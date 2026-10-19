/**
 * Host half of the performance HUD.
 *
 * CPU load and memory come from `node:os`. GPU load comes from one long-lived
 * PowerShell worker that reads the Windows GPU Engine performance counters,
 * because Node has no access to them and spawning a shell per poll would cost
 * more than the reading itself. Temperature comes from the separate elevated
 * helper in D:\DSHTools\perf-sensor, which writes one small JSON file per
 * second; this process only reads that file and never needs privileges itself.
 * The latest snapshot is served to the Client half over a loopback-only route.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROUTE = '/perf-hud/metrics'
const CPU_SAMPLE_MS = 1000
const WORKER_RESTART_MS = 5000
const STALE_AFTER_MS = 9000
// Written by the elevated helper (see helper/setup.ps1). The helper prefers
// D:\DSHTools when that drive exists and falls back to %LOCALAPPDATA%\DSHTools,
// so both locations are read and the freshest reading wins.
const HELPER_FILES = [
  path.join('D:\\DSHTools', 'perf-sensor', 'sensors.json'),
  path.join(process.env.LOCALAPPDATA || os.homedir(), 'DSHTools', 'perf-sensor', 'sensors.json'),
]
// A reading older than this still beats showing nothing: keep it (dimmed) for a
// while, and only drop it once the helper is truly gone.
const HELPER_FRESH_MS = 8000
const HELPER_RETENTION_MS = 60000

export const inject = ['webServer']

/**
 * The GPU worker. It prints one compact JSON object per line and keeps running
 * until the Host half kills it. Every value it cannot read is `null`, so the
 * Client can show an honest gap instead of a fake number.
 */
const SENSOR_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'

$cpuName = ''
$proc = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
if ($proc) { $cpuName = [string]$proc.Name }

$gpuName = ''
$vc = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Select-Object -First 1
if ($vc) { $gpuName = [string]$vc.Name }

while ($true) {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $gpuUse = $null

  # Sum each engine's per-process counters, then take the busiest engine, which
  # is what Task Manager reports as the GPU utilisation.
  $rows = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue
  if ($rows) {
    $engines = @{}
    foreach ($r in $rows) {
      $n = [string]$r.Name
      if ($n -match 'pid_\d+_(luid_.+_eng_\d+)') {
        $key = $Matches[1]
        $v = [double]$r.UtilizationPercentage
        if ($engines.ContainsKey($key)) { $engines[$key] = $engines[$key] + $v } else { $engines[$key] = $v }
      }
    }
    $busiest = 0.0
    foreach ($v in $engines.Values) { if ($v -gt $busiest) { $busiest = $v } }
    if ($busiest -gt 100) { $busiest = 100 }
    $gpuUse = [math]::Round($busiest, 1)
  }

  $out = @{
    t = $now
    gpuUse = $gpuUse
    cpuName = $cpuName
    gpuName = $gpuName
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 900
}
`

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function round1(value) {
  const n = finiteOrNull(value)
  return n === null ? null : Math.round(n * 10) / 10
}

function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(full) ? full : 'powershell.exe'
}

function readCpuTimes() {
  const cpus = os.cpus()
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    const times = cpu.times
    idle += times.idle
    total += times.user + times.nice + times.sys + times.idle + times.irq
  }
  return { idle, total }
}

function cpuUsageSince(before, after) {
  const total = after.total - before.total
  const idle = after.idle - before.idle
  if (!(total > 0)) return null
  const busy = 100 * (1 - idle / total)
  return Math.min(100, Math.max(0, busy))
}

function isLoopbackHostname(raw) {
  const host = String(raw || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  return m[1] === '127' && [m[2], m[3], m[4]].every((part) => Number(part) <= 255)
}

/** Read-only system telemetry stays on this machine: loopback plus same-origin only. */
function isLocalRequest(req) {
  try {
    const headers = req.headers || {}
    const authority = new URL('http://' + String(headers.host || ''))
    if (!isLoopbackHostname(authority.hostname)) return false
    if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false
    const origin = headers.origin
    if (typeof origin === 'string' && origin && origin !== 'null') {
      let parsed
      try {
        parsed = new URL(origin)
      } catch {
        return false
      }
      if (parsed.host.toLowerCase() !== authority.host.toLowerCase()) return false
    }
    return true
  } catch {
    return false
  }
}

export function apply(ctx) {
  const state = {
    cpuUsage: null,
    cpuName: '',
    gpuName: '',
    gpuUsage: null,
    helper: null,
    sensorAt: 0,
    sensorState: 'starting',
  }

  let disposed = false
  let worker = null
  let restartTimer = null
  let sampleTimer = null
  let lastCpu = readCpuTimes()
  let buffer = ''

  function noteSensor(payload) {
    state.gpuUsage = finiteOrNull(payload.gpuUse)
    if (typeof payload.cpuName === 'string' && payload.cpuName) state.cpuName = payload.cpuName
    if (typeof payload.gpuName === 'string' && payload.gpuName) state.gpuName = payload.gpuName
    state.sensorAt = Date.now()
    state.sensorState = 'ok'
  }

  function consume(chunk) {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) {
        let payload = null
        try {
          payload = JSON.parse(line)
        } catch {
          payload = null
        }
        if (payload && typeof payload === 'object') noteSensor(payload)
      }
      index = buffer.indexOf('\n')
    }
    if (buffer.length > 64 * 1024) buffer = ''
  }

  function scheduleRestart() {
    if (disposed || restartTimer) return
    restartTimer = setTimeout(() => {
      restartTimer = null
      startWorker()
    }, WORKER_RESTART_MS)
    restartTimer.unref?.()
  }

  function startWorker() {
    if (disposed) return
    const encoded = Buffer.from(SENSOR_SCRIPT, 'utf16le').toString('base64')
    let child
    try {
      child = spawn(
        powershellPath(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch {
      state.sensorState = 'error'
      scheduleRestart()
      return
    }
    worker = child
    buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', consume)
    child.stderr?.resume()
    child.on('error', () => {
      if (worker === child) worker = null
      state.sensorState = 'error'
      scheduleRestart()
    })
    child.on('exit', () => {
      if (worker === child) worker = null
      if (!disposed) {
        state.sensorState = 'error'
        scheduleRestart()
      }
    })
  }

  function stopWorker() {
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    const child = worker
    worker = null
    if (child) {
      try {
        child.kill()
      } catch {
        // already gone
      }
    }
  }

  /**
   * Keep the last good elevated reading across the instant where the helper
   * replaces its file, and drop it once the file stops being refreshed.
   */
  function refreshHelper() {
    let next = null
    for (const file of HELPER_FILES) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'))
        if (!data || typeof data !== 'object' || typeof data.t !== 'number') continue
        if (Date.now() - data.t > HELPER_RETENTION_MS) continue
        if (!next || data.t > next.t) next = data
      } catch {
        // Missing or mid-replace: the other candidate may still be fresh.
      }
    }
    if (next) state.helper = next
    else if (state.helper && Date.now() - state.helper.t > HELPER_RETENTION_MS) state.helper = null
  }

  function tickCpu() {
    const next = readCpuTimes()
    const usage = cpuUsageSince(lastCpu, next)
    lastCpu = next
    if (usage !== null) state.cpuUsage = usage
    refreshHelper()
  }

  function buildSnapshot() {
    const total = os.totalmem()
    const free = os.freemem()
    const used = Math.max(0, total - free)
    const age = state.sensorAt ? Date.now() - state.sensorAt : null

    const helper = state.helper
    const helperAge = helper ? Date.now() - helper.t : null
    const helperUsable = helperAge !== null && helperAge <= HELPER_RETENTION_MS
    const helperStale = helperUsable && helperAge > HELPER_FRESH_MS
    const stale = age === null || age > STALE_AFTER_MS || helperStale

    return {
      ts: Date.now(),
      cpu: {
        usage: round1(state.cpuUsage),
        temp: helperUsable ? finiteOrNull(helper.cpuTemp) : null,
        name: state.cpuName,
        cores: os.cpus().length,
      },
      gpu: {
        usage: state.gpuUsage,
        temp: helperUsable ? finiteOrNull(helper.gpuTemp) : null,
        name: state.gpuName,
      },
      mem: {
        usage: round1((used / total) * 100),
        usedGB: Math.round((used / 1024 ** 3) * 10) / 10,
        totalGB: Math.round((total / 1024 ** 3) * 10) / 10,
      },
      sensor: {
        ageMs: age,
        state: stale ? 'stale' : state.sensorState,
        helper: helperUsable ? 'live' : 'off',
      },
    }
  }

  ctx.effect(() => {
    lastCpu = readCpuTimes()
    tickCpu()
    sampleTimer = setInterval(tickCpu, CPU_SAMPLE_MS)
    sampleTimer.unref?.()
    startWorker()
    return () => {
      disposed = true
      if (sampleTimer) {
        clearInterval(sampleTimer)
        sampleTimer = null
      }
      stopWorker()
    }
  }, 'perf-hud: sampler')

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD' })
            res.end()
            return
          }
          if (!isLocalRequest(req)) {
            res.writeHead(403)
            res.end()
            return
          }
          const body = JSON.stringify(buildSnapshot())
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(body),
          })
          res.end(req.method === 'HEAD' ? undefined : body)
        },
      }),
    'perf-hud: metrics route',
  )
}
