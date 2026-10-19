# dsh-perf-hud sensor helper.
#
# Runs elevated (the LibreHardwareMonitor driver needs it) and publishes one
# small JSON file every ~0.4 s that the plugin reads:
#   <Root>\perf-sensor\sensors.json
#
# It is started by the "DSH Perf Sensor" scheduled task created by setup.ps1, so
# it never shows a window and never asks for permission again after the first run.

param(
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Root) {
  if (Test-Path 'D:\') { $Root = 'D:\DSHTools' } else { $Root = Join-Path $env:LOCALAPPDATA 'DSHTools' }
}

$libDir = Join-Path $Root 'LibreHardwareMonitor'
$outDir = Join-Path $Root 'perf-sensor'
$outFile = Join-Path $outDir 'sensors.json'
$statusFile = Join-Path $outDir 'status.json'
$loopMs = 400
# CPU sensors cost 0.3-1.4 s of wall time per call through the driver, so they
# refresh about once a second while the cheap GPU read runs every loop.
$cpuRefreshMs = 900

function Write-JsonAtomic([string]$Path, $Payload) {
  $tmp = "$Path.tmp"
  $json = $Payload | ConvertTo-Json -Compress -Depth 4
  [IO.File]::WriteAllText($tmp, $json, (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Write-Status([bool]$Ok, [string]$Reason) {
  try {
    Write-JsonAtomic $statusFile ([ordered]@{
        ok     = $Ok
        reason = $Reason
        pid    = $PID
        at     = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      })
  } catch { }
}

function Now-Ms { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

$isAdmin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Status $false 'admin-required'
  exit 1
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

try {
  [void][Reflection.Assembly]::LoadFrom((Join-Path $libDir 'LibreHardwareMonitorLib.dll'))
  $computer = New-Object LibreHardwareMonitor.Hardware.Computer
  $computer.IsCpuEnabled = $true
  $computer.IsGpuEnabled = $true
  $computer.IsMotherboardEnabled = $false
  $computer.IsControllerEnabled = $false
  $computer.IsMemoryEnabled = $false
  $computer.IsStorageEnabled = $false
  $computer.IsNetworkEnabled = $false
  $computer.Open()
  $cpu = $computer.Hardware | Where-Object { [string]$_.HardwareType -eq 'Cpu' } | Select-Object -First 1
  $gpu = $computer.Hardware | Where-Object { [string]$_.HardwareType -like 'Gpu*' } | Select-Object -First 1
} catch {
  Write-Status $false ('open-failed: ' + $_.Exception.Message)
  exit 1
}

Write-Status $true 'running'
$lastCpuUpdate = 0
$failures = 0

while ($true) {
  $payload = [ordered]@{
    t       = Now-Ms
    cpuTemp = $null
    cpuLoad = $null
    gpuTemp = $null
    gpuLoad = $null
    gpuName = $null
    sensor  = $null
  }

  try {
    $now = Now-Ms
    if ($cpu -and (($now - $lastCpuUpdate) -ge $cpuRefreshMs)) {
      $cpu.Update()
      $lastCpuUpdate = Now-Ms
    }
    if ($gpu) {
      $gpu.Update()
      $payload.gpuName = [string]$gpu.Name
    }

    if ($cpu) {
      foreach ($sensor in $cpu.Sensors) {
        if ($null -eq $sensor.Value) { continue }
        if ($sensor.SensorType -eq 'Temperature' -and $sensor.Name -eq 'CPU Package') {
          $payload.cpuTemp = [math]::Round([double]$sensor.Value, 1)
          $payload.sensor = 'cpu-package'
        }
        elseif ($sensor.SensorType -eq 'Load' -and $sensor.Name -eq 'CPU Total') {
          $payload.cpuLoad = [math]::Round([double]$sensor.Value, 1)
        }
      }
    }

    if ($gpu) {
      $hottest = $null
      foreach ($sensor in $gpu.Sensors) {
        if ($null -eq $sensor.Value) { continue }
        if ($sensor.SensorType -eq 'Temperature') {
          $value = [double]$sensor.Value
          if ($null -eq $hottest -or $value -gt $hottest) { $hottest = $value }
        }
        elseif ($sensor.SensorType -eq 'Load' -and $sensor.Name -eq 'D3D 3D') {
          $payload.gpuLoad = [math]::Round([double]$sensor.Value, 1)
        }
      }
      if ($null -ne $hottest) {
        $payload.gpuTemp = [math]::Round($hottest, 1)
        if (-not $payload.sensor) { $payload.sensor = 'gpu-core' }
      }
    }
    $failures = 0
  } catch {
    $failures++
    if ($failures -ge 5) {
      Write-Status $false ('read-failed: ' + $_.Exception.Message)
      $failures = 0
    }
  }

  try {
    Write-JsonAtomic $outFile $payload
  } catch {
    # A transient lock on the file is fine: the next tick rewrites it.
  }

  Start-Sleep -Milliseconds $loopMs
}
