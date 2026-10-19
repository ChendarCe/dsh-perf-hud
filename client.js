/**
 * Client half of the performance HUD.
 *
 * A frameless, fully transparent readout that floats in the frame-wide
 * `shell.overlay` layer: CPU / GPU / memory usage plus CPU and GPU
 * temperatures. It sits directly on top of the UI with only a soft text halo
 * for legibility, and is anchored to the nearest window corner so resizing,
 * maximising or restoring the window keeps its distance to that corner.
 */
window.__ModuleLoader__.load({
  id: 'dsh-perf-hud',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'perf-hud'
    const ROUTE = '/perf-hud/metrics'
    const POLL_MS = 1200
    const HIDDEN_POLL_MS = 5000
    const PLACEMENT_KEY = 'dsh.perf-hud.placement'
    const LEGACY_POS_KEY = 'dsh.perf-hud.position'
    const COLLAPSE_KEY = 'dsh.perf-hud.collapsed'
    const CARD_WIDTH = 110
    // Room for the hover control that hangs outside the card, so it never clips.
    const EDGE = 18
    const DEFAULT_PLACEMENT = { anchor: 'tr', dx: 24, dy: 92 }

    const DICT = {
      zh: {
        title: '性能监控',
        cpu: 'CPU',
        gpu: 'GPU',
        mem: '内存',
        collapse: '收起',
        expand: '展开',
        dragHint: '拖动移动位置（会吸附到最近的窗口角），双击回到右上角',
        memDetail: '已用 / 总内存',
        gpuNoSensor: '这块核显没有独立的温度传感器，温度显示为 —；可参考 CPU 封装温度（同一颗芯片）',
        offline: '无法连接性能服务',
        starting: '采样中',
      },
      en: {
        title: 'Performance',
        cpu: 'CPU',
        gpu: 'GPU',
        mem: 'MEM',
        collapse: 'Collapse',
        expand: 'Expand',
        dragHint: 'Drag to move (snaps to the nearest window corner), double-click to reset',
        memDetail: 'Used / total memory',
        gpuNoSensor: 'This integrated GPU has no dedicated temperature sensor, so it reads —; use the CPU package temperature (same die) as reference',
        offline: 'Cannot reach the performance service',
        starting: 'Starting',
      },
    }

    const CSS = `
.phud-card{position:fixed;z-index:30;width:${CARD_WIDTH}px;box-sizing:border-box;
  padding:5px 4px 5px 6px;border:0;background:transparent;
  color:var(--dsw-alias-label-primary);pointer-events:auto;cursor:grab;
  font:11px/1.3 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  -webkit-user-select:none;user-select:none;outline:none;
  text-shadow:0 0 2px var(--dsw-alias-bg-base),0 1px 3px var(--dsw-alias-bg-base),0 0 6px var(--dsw-alias-bg-base);
  opacity:.96;transition:opacity .15s ease;
}
.phud-card:hover{opacity:1;}
.phud-card[data-dragging="true"]{cursor:grabbing;opacity:1;}
.phud-card[data-stale="true"]{opacity:.55;}
.phud-card:focus-visible{box-shadow:0 0 0 1px var(--dsw-alias-brand-primary);border-radius:4px;}
.phud-list{display:flex;flex-direction:column;gap:2px;}
.phud-row{display:grid;grid-template-columns:24px 32px 30px;align-items:baseline;column-gap:7px;}
.phud-label{font-size:9px;font-weight:600;letter-spacing:.08em;color:var(--dsw-alias-label-secondary);
  overflow:hidden;white-space:nowrap;}
.phud-value{font-size:11.5px;font-weight:600;text-align:right;font-variant-numeric:tabular-nums;
  white-space:nowrap;overflow:hidden;}
.phud-unit{margin-left:1px;font-size:8px;font-weight:500;color:var(--dsw-alias-label-secondary);}
.phud-read{font-size:9.5px;text-align:right;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;}
.phud-more{position:absolute;right:-13px;top:50%;transform:translateY(-50%);
  display:flex;align-items:center;justify-content:center;width:14px;height:14px;padding:0;
  border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);
  cursor:pointer;opacity:0;transition:opacity .15s ease;}
.phud-card:hover .phud-more,.phud-more:focus-visible{opacity:1;}
.phud-more:hover{color:var(--dsw-alias-label-primary);
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);}
@media (prefers-reduced-motion:reduce){.phud-card,.phud-more{transition:none;}}
`

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    /**
     * The dictionary service is the source of truth, but a widget that shows raw
     * message keys is worse than one that shows the package's own default copy,
     * so every lookup falls back to the Chinese dictionary.
     */
    function withFallback(translate) {
      return (key) => {
        let value
        if (typeof translate === 'function') {
          try {
            value = translate(key)
          } catch {
            value = undefined
          }
        }
        if (typeof value === 'string' && value && value !== key) return value
        return DICT.zh[key] || key
      }
    }

    function readJson(key) {
      try {
        const raw = window.localStorage.getItem(key)
        return raw ? JSON.parse(raw) : null
      } catch {
        return null
      }
    }

    function writeJson(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch {
        // private mode or blocked storage: the widget still works, it just forgets.
      }
    }

    function isPlacement(value) {
      return (
        value &&
        typeof value === 'object' &&
        typeof value.anchor === 'string' &&
        /^[tb][lr]$/.test(value.anchor) &&
        Number.isFinite(value.dx) &&
        Number.isFinite(value.dy)
      )
    }

    /**
     * A placement is `{ anchor, dx, dy }`: the window corner the card hugs and
     * its distance from that corner's two edges. That is what keeps the card in
     * the same visual spot when the window is resized, maximised or restored.
     */
    function loadPlacement() {
      const saved = readJson(PLACEMENT_KEY)
      if (isPlacement(saved)) return { anchor: saved.anchor, dx: saved.dx, dy: saved.dy }
      const legacy = readJson(LEGACY_POS_KEY)
      if (legacy && Number.isFinite(legacy.x) && Number.isFinite(legacy.y)) {
        return placementFromPosition(
          { x: legacy.x, y: legacy.y },
          { width: window.innerWidth, height: window.innerHeight },
          { width: CARD_WIDTH, height: 52 },
        )
      }
      return { ...DEFAULT_PLACEMENT }
    }

    function placementFromPosition(position, viewport, size) {
      const right = position.x + size.width / 2 > viewport.width / 2
      const bottom = position.y + size.height / 2 > viewport.height / 2
      return {
        anchor: (bottom ? 'b' : 't') + (right ? 'r' : 'l'),
        dx: Math.max(EDGE, right ? viewport.width - position.x - size.width : position.x),
        dy: Math.max(EDGE, bottom ? viewport.height - position.y - size.height : position.y),
      }
    }

    function resolvePosition(placement, viewport, size) {
      const rawX = placement.anchor[1] === 'r' ? viewport.width - size.width - placement.dx : placement.dx
      const rawY = placement.anchor[0] === 'b' ? viewport.height - size.height - placement.dy : placement.dy
      return {
        x: clamp(rawX, EDGE, Math.max(EDGE, viewport.width - size.width - EDGE)),
        y: clamp(rawY, EDGE, Math.max(EDGE, viewport.height - size.height - EDGE)),
      }
    }

    function toneOf(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'var(--dsw-alias-label-secondary)'
      if (value >= 90) return 'var(--dsw-alias-state-error-primary)'
      if (value >= 70) return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-brand-primary)'
    }

    function tempTone(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
      if (value >= 88) return 'var(--dsw-alias-state-error-primary)'
      if (value >= 78) return 'var(--dsw-alias-state-warn-primary)'
      return undefined
    }

    function percentText(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '--'
      return String(Math.round(value))
    }

    function tempText(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return Math.round(value) + '°'
    }

    function chevron(pointsUp) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 10, height: 10, 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: pointsUp ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function Row(props) {
      return h('div', { className: 'phud-row' }, [
        h('span', { className: 'phud-label', key: 'label' }, props.label),
        h('span', { className: 'phud-value', key: 'value', style: { color: props.valueColor } }, [
          percentText(props.value),
          h('span', { className: 'phud-unit', key: 'unit' }, '%'),
        ]),
        h(
          'span',
          {
            className: 'phud-read',
            key: 'read',
            title: props.readTitle || undefined,
            style: props.readColor ? { color: props.readColor } : undefined,
          },
          props.read || '',
        ),
      ])
    }

    function PerfHud(props) {
      const t = typeof props.t === 'function' ? props.t : withFallback(null)
      const [snapshot, setSnapshot] = React.useState(null)
      const [offline, setOffline] = React.useState(false)
      const [collapsed, setCollapsed] = React.useState(() => readJson(COLLAPSE_KEY) === true)
      const [dragging, setDragging] = React.useState(false)
      const [placement, setPlacement] = React.useState(loadPlacement)
      const [viewport, setViewport] = React.useState(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }))
      const [size, setSize] = React.useState({ width: CARD_WIDTH, height: 52 })
      // Absolute pixels exist only while a drag is in flight; the resting state
      // is the anchor + offsets above.
      const [dragPosition, setDragPosition] = React.useState(null)

      const cardRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const dragPositionRef = React.useRef(null)
      const viewportRef = React.useRef(viewport)
      const sizeRef = React.useRef(size)

      React.useEffect(() => {
        viewportRef.current = viewport
      }, [viewport])

      React.useEffect(() => {
        sizeRef.current = size
      }, [size])

      // Measure the card so the anchor offsets can be resolved exactly, including
      // after collapsing to one row.
      React.useEffect(() => {
        const element = cardRef.current
        if (!element) return
        const measure = () => setSize({ width: element.offsetWidth, height: element.offsetHeight })
        measure()
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(measure)
          observer.observe(element)
          return () => observer.disconnect()
        }
        return undefined
      }, [])

      React.useEffect(() => {
        const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      // Poll the Host half; sequential timeouts keep slow readings from piling
      // up, and a hidden window backs off so the widget costs almost nothing.
      React.useEffect(() => {
        let alive = true
        let timer = null
        let inFlight = false
        const schedule = () => {
          if (!alive) return
          timer = window.setTimeout(load, document.hidden ? HIDDEN_POLL_MS : POLL_MS)
        }
        const load = async () => {
          if (!alive || inFlight) return
          inFlight = true
          try {
            const response = await fetch(ROUTE, { cache: 'no-store', headers: { accept: 'application/json' } })
            if (!response.ok) throw new Error('http ' + response.status)
            const data = await response.json()
            if (!alive) return
            setSnapshot(data)
            setOffline(false)
          } catch {
            if (alive) setOffline(true)
          } finally {
            inFlight = false
          }
          schedule()
        }
        load()
        const onVisibility = () => {
          if (document.hidden || !alive) return
          if (timer) window.clearTimeout(timer)
          timer = null
          load()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          alive = false
          if (timer) window.clearTimeout(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [])

      const applyPlacement = (next) => {
        setPlacement(next)
        writeJson(PLACEMENT_KEY, next)
      }

      // Drag with window-level listeners instead of pointer capture: capture
      // retargets every move event to the capturing element, which is what made
      // the card stick when the listener sat on a child.
      const startDrag = (event) => {
        if (event.button !== 0) return
        if (event.target && event.target.closest && event.target.closest('button')) return
        const element = cardRef.current
        if (!element) return
        const rect = element.getBoundingClientRect()
        dragRef.current = {
          dx: event.clientX - rect.left,
          dy: event.clientY - rect.top,
          width: rect.width,
          height: rect.height,
        }
        const start = { x: rect.left, y: rect.top }
        dragPositionRef.current = start
        setDragPosition(start)
        setDragging(true)
        event.preventDefault()
      }

      React.useEffect(() => {
        if (!dragging) return
        const previousCursor = document.body.style.cursor
        const previousSelect = document.body.style.userSelect
        document.body.style.cursor = 'grabbing'
        document.body.style.userSelect = 'none'
        const onMove = (event) => {
          const drag = dragRef.current
          if (!drag) return
          event.preventDefault()
          const next = {
            x: clamp(event.clientX - drag.dx, EDGE, Math.max(EDGE, window.innerWidth - drag.width - EDGE)),
            y: clamp(event.clientY - drag.dy, EDGE, Math.max(EDGE, window.innerHeight - drag.height - EDGE)),
          }
          dragPositionRef.current = next
          setDragPosition(next)
        }
        const onEnd = () => {
          const droppedAt = dragPositionRef.current
          dragRef.current = null
          dragPositionRef.current = null
          if (droppedAt) applyPlacement(placementFromPosition(droppedAt, viewportRef.current, sizeRef.current))
          setDragPosition(null)
          setDragging(false)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onEnd)
        window.addEventListener('pointercancel', onEnd)
        return () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onEnd)
          window.removeEventListener('pointercancel', onEnd)
          document.body.style.cursor = previousCursor
          document.body.style.userSelect = previousSelect
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [dragging])

      const resetPlacement = () => applyPlacement({ ...DEFAULT_PLACEMENT })

      const nudge = (event) => {
        const step = event.shiftKey ? 1 : 12
        const moves = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        }
        const move = moves[event.key]
        if (!move) return
        event.preventDefault()
        const current = resolvePosition(placement, viewportRef.current, sizeRef.current)
        const next = {
          x: clamp(current.x + move[0], EDGE, Math.max(EDGE, window.innerWidth - sizeRef.current.width - EDGE)),
          y: clamp(current.y + move[1], EDGE, Math.max(EDGE, window.innerHeight - sizeRef.current.height - EDGE)),
        }
        applyPlacement(placementFromPosition(next, viewportRef.current, sizeRef.current))
      }

      const toggleCollapsed = () => {
        const next = !collapsed
        setCollapsed(next)
        writeJson(COLLAPSE_KEY, next)
      }

      const cpu = (snapshot && snapshot.cpu) || {}
      const gpu = (snapshot && snapshot.gpu) || {}
      const mem = (snapshot && snapshot.mem) || {}
      const sensor = (snapshot && snapshot.sensor) || {}
      const stale = offline || !snapshot || sensor.state === 'stale'
      const gpuTemp = typeof gpu.temp === 'number' ? gpu.temp : null
      const memoryRead = typeof mem.usedGB === 'number' ? mem.usedGB + 'G' : ''
      const memoryTitle =
        typeof mem.totalGB === 'number'
          ? t('memDetail') + ' · ' + mem.usedGB + ' / ' + mem.totalGB + ' GB'
          : undefined

      const rows = collapsed
        ? [
            h(Row, {
              key: 'cpu',
              label: t('cpu'),
              value: cpu.usage,
              valueColor: toneOf(cpu.usage),
              read: tempText(cpu.temp),
              readColor: tempTone(cpu.temp),
              readTitle: cpu.name || undefined,
            }),
          ]
        : [
            h(Row, {
              key: 'cpu',
              label: t('cpu'),
              value: cpu.usage,
              valueColor: toneOf(cpu.usage),
              read: tempText(cpu.temp),
              readColor: tempTone(cpu.temp),
              readTitle: cpu.name || undefined,
            }),
            h(Row, {
              key: 'gpu',
              label: t('gpu'),
              value: gpu.usage,
              valueColor: toneOf(gpu.usage),
              read: tempText(gpuTemp),
              readColor: tempTone(gpuTemp),
              readTitle: gpuTemp === null ? t('gpuNoSensor') : gpu.name || undefined,
            }),
            h(Row, {
              key: 'mem',
              label: t('mem'),
              value: mem.usage,
              valueColor: toneOf(mem.usage),
              read: memoryRead,
              readTitle: memoryTitle,
            }),
          ]

      const position = dragPosition || resolvePosition(placement, viewport, size)

      return h(
        'div',
        {
          className: 'phud-card',
          ref: cardRef,
          style: { left: Math.round(position.x) + 'px', top: Math.round(position.y) + 'px' },
          role: 'group',
          tabIndex: 0,
          'aria-label': t('title'),
          title: stale ? t('offline') : t('dragHint'),
          'data-dragging': dragging ? 'true' : undefined,
          'data-stale': stale ? 'true' : undefined,
          'data-anchor': placement.anchor,
          onPointerDown: startDrag,
          onDoubleClick: resetPlacement,
          onKeyDown: nudge,
        },
        [
          h('style', { key: 'style' }, CSS),
          h('div', { className: 'phud-list', key: 'list' }, rows),
          h(
            'button',
            {
              className: 'phud-more',
              key: 'toggle',
              type: 'button',
              onClick: toggleCollapsed,
              'aria-label': collapsed ? t('expand') : t('collapse'),
              title: collapsed ? t('expand') : t('collapse'),
            },
            chevron(!collapsed),
          ),
        ],
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICT), 'perf-hud: dictionaries')
      const t = withFallback(ctx.locale.bind(NS))
      // Bind the translator into the component instead of relying on injectable
      // props, so the readout renders localized copy in every slot-host version.
      const Widget = (props) => h(PerfHud, Object.assign({}, props, { t }))
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: 'perf-hud', order: 20, label: () => t('title') },
          Widget,
        ),
      )
    }

    return { name: NS, inject: ['slots', 'locale'], apply }
  },
})
