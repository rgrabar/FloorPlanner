import { useEffect, useReducer, useRef, useState } from 'react'
import { dist, formatLength, wallCorners } from '../model/geometry'
import { planBounds } from '../model/plan'
import type { LayerRole, Opening, Plan, Vec2, Wall } from '../model/types'
import { useStore } from '../store/store'
import { CalibrateDialog } from './CalibrateDialog'

/** Screen position = plan position (cm) × zoom + offset. */
interface View {
  ox: number
  oy: number
  zoom: number // screen pixels per cm
}

const ROLE_COLORS: Record<LayerRole, string> = {
  wall: '#1d4ed8',
  door: '#ea580c',
  window: '#0891b2',
  other: '#475569',
  hidden: 'transparent',
}

export function PlanCanvas() {
  const plan = useStore((s) => s.plan)
  const tool = useStore((s) => s.tool)
  const fitToken = useStore((s) => s.fitToken)
  const highlight = useStore((s) => s.highlightLayer)
  const { setTool, calibrate, straighten } = useStore.getState()

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const view = useRef<View>({ ox: 40, oy: 40, zoom: 1 })
  const drag = useRef<{ x: number; y: number } | null>(null)
  const spaceDown = useRef(false)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [cursor, setCursor] = useState<Vec2 | null>(null)
  const [picks, setPicks] = useState<Vec2[]>([])
  const [measured, setMeasured] = useState<number | null>(null)
  const [, redraw] = useReducer((x: number) => x + 1, 0)

  // Keep the canvas the size of its container.
  useEffect(() => {
    const ro = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }))
    ro.observe(wrapRef.current!)
    return () => ro.disconnect()
  }, [])

  // Load the background picture whenever it changes.
  const bgSrc = plan.background?.src
  useEffect(() => {
    setImg(null)
    if (!bgSrc) return
    const image = new Image()
    image.onload = () => setImg(image)
    image.src = bgSrc
  }, [bgSrc])

  // Zoom to fit when asked (after opening a file, or the Fit button).
  const fittedFor = useRef(-1)
  useEffect(() => {
    if (size.w === 0 || fittedFor.current === fitToken) return
    fittedFor.current = fitToken
    const b = planBounds(useStore.getState().plan)
    if (!b) {
      view.current = { ox: 40, oy: 40, zoom: 1 }
    } else {
      const zoom = Math.min((size.w - 80) / Math.max(1, b.maxX - b.minX), (size.h - 80) / Math.max(1, b.maxY - b.minY))
      view.current = {
        zoom,
        ox: size.w / 2 - ((b.minX + b.maxX) / 2) * zoom,
        oy: size.h / 2 - ((b.minY + b.maxY) / 2) * zoom,
      }
    }
    redraw()
  }, [fitToken, size])

  // A new tool starts with no clicked points.
  useEffect(() => {
    setPicks([])
    setMeasured(null)
  }, [tool])

  // Zoom with the mouse wheel, around the cursor. Needs a non-passive listener to stop page scrolling.
  useEffect(() => {
    const canvas = canvasRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = canvas.getBoundingClientRect()
      const sx = e.clientX - r.left
      const sy = e.clientY - r.top
      const v = view.current
      const zoom = Math.min(200, Math.max(0.005, v.zoom * Math.exp(-e.deltaY * 0.0015)))
      view.current = { zoom, ox: sx - ((sx - v.ox) / v.zoom) * zoom, oy: sy - ((sy - v.oy) / v.zoom) * zoom }
      redraw()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

  // Space = temporary pan, Escape = cancel clicked points.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.code === 'Space') {
        spaceDown.current = true
        e.preventDefault()
      }
      if (e.key === 'Escape') {
        setPicks([])
        setMeasured(null)
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceDown.current = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  // Redraw after every render.
  useEffect(() => {
    const canvas = canvasRef.current!
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size.w * dpr)
    canvas.height = Math.round(size.h * dpr)
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawPlan(ctx, size, view.current, plan, img, highlight)
    drawPicks(ctx, view.current, tool, picks, cursor)
  })

  const toPlan = (e: React.PointerEvent): Vec2 => {
    const r = canvasRef.current!.getBoundingClientRect()
    const v = view.current
    let p = { x: (e.clientX - r.left - v.ox) / v.zoom, y: (e.clientY - r.top - v.oy) / v.zoom }
    // Shift keeps the calibration line straight.
    if (tool === 'calibrate' && picks.length === 1 && e.shiftKey) {
      const a = picks[0]
      p = Math.abs(p.x - a.x) > Math.abs(p.y - a.y) ? { x: p.x, y: a.y } : { x: a.x, y: p.y }
    }
    return p
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || e.button === 2 || tool === 'pan' || spaceDown.current) {
      drag.current = { x: e.clientX, y: e.clientY }
      canvasRef.current!.setPointerCapture(e.pointerId)
      return
    }
    if (e.button !== 0) return
    const p = toPlan(e)
    if (tool === 'calibrate' && picks.length < 2) {
      const next = [...picks, p]
      setPicks(next)
      if (next.length === 2) setMeasured(dist(next[0], next[1]))
    } else if (tool === 'straighten') {
      const bg = plan.background
      if (!bg) return
      const next = [...picks, p]
      if (next.length < 4) {
        setPicks(next)
        return
      }
      setPicks([])
      void straighten(next.map((c) => ({ x: (c.x - bg.x) / bg.cmPerPx, y: (c.y - bg.y) / bg.cmPerPx })))
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    setCursor(toPlan(e))
    if (drag.current) {
      view.current.ox += e.clientX - drag.current.x
      view.current.oy += e.clientY - drag.current.y
      drag.current = { x: e.clientX, y: e.clientY }
    }
  }

  const onCalibrated = (realCm: number) => {
    const k = realCm / measured!
    view.current.zoom /= k // keep the picture where it is on screen
    calibrate(k)
    setTool('pan')
  }

  const hint =
    tool === 'calibrate'
      ? picks.length === 0
        ? 'Click the start of a line whose real length you know (e.g. a dimension line). Hold Shift for a straight line.'
        : 'Click the end of the line.'
      : tool === 'straighten'
        ? `Click the 4 corners of the plan on the photo (${picks.length}/4). Esc to start over.`
        : null

  const empty = !plan.source && !plan.background

  return (
    <div
      ref={wrapRef}
      className={`canvas-wrap tool-${tool}`}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        onPointerLeave={() => setCursor(null)}
      />
      {hint && <div className="hint">{hint}</div>}
      {empty && (
        <div className="empty">
          <h2>Drop a floorplan here</h2>
          <p>or click Open. Pictures, PDF, SVG, DXF, IFC and Sweet Home 3D files all work.</p>
        </div>
      )}
      {cursor && !empty && (
        <div className="coords">
          x {Math.round(cursor.x)} cm · y {Math.round(cursor.y)} cm
        </div>
      )}
      {measured !== null && (
        <CalibrateDialog
          measured={measured}
          scaleKnown={plan.scaleKnown}
          onSubmit={onCalibrated}
          onCancel={() => {
            setPicks([])
            setMeasured(null)
          }}
        />
      )}
    </div>
  )
}

// ---------- drawing ----------

function drawPlan(
  ctx: CanvasRenderingContext2D,
  size: { w: number; h: number },
  v: View,
  plan: Plan,
  img: HTMLImageElement | null,
  highlight: string | null,
) {
  const S = (p: Vec2) => ({ x: p.x * v.zoom + v.ox, y: p.y * v.zoom + v.oy })
  ctx.fillStyle = '#eef0f3'
  ctx.fillRect(0, 0, size.w, size.h)

  // Grid: 1 m squares, or 10 m when zoomed far out.
  let step = 100
  while (step * v.zoom < 24) step *= 10
  ctx.strokeStyle = '#dde1e7'
  ctx.lineWidth = 1
  ctx.beginPath()
  const x0 = Math.floor(-v.ox / v.zoom / step) * step
  for (let x = x0; x * v.zoom + v.ox < size.w; x += step) {
    const sx = Math.round(x * v.zoom + v.ox) + 0.5
    ctx.moveTo(sx, 0)
    ctx.lineTo(sx, size.h)
  }
  const y0 = Math.floor(-v.oy / v.zoom / step) * step
  for (let y = y0; y * v.zoom + v.oy < size.h; y += step) {
    const sy = Math.round(y * v.zoom + v.oy) + 0.5
    ctx.moveTo(0, sy)
    ctx.lineTo(size.w, sy)
  }
  ctx.stroke()

  // Lines on "other" layers are already visible in the background picture, so with a picture
  // only lines I gave a role (or the layer I'm pointing at) are drawn on top.
  const bg = plan.background
  const roleOf = new Map(plan.layers.map((l) => [l.name, l.role]))
  const drawnRoles: LayerRole[] = bg ? ['window', 'door', 'wall'] : ['other', 'window', 'door', 'wall']
  const anyOnTop = highlight !== null || plan.layers.some((l) => l.role !== 'other' && l.role !== 'hidden')
  if (bg && img) {
    const tl = S({ x: bg.x, y: bg.y })
    ctx.imageSmoothingQuality = 'high'
    ctx.globalAlpha = anyOnTop ? 0.4 : 1 // let the coloured lines stand out
    ctx.drawImage(img, tl.x, tl.y, bg.widthPx * bg.cmPerPx * v.zoom, bg.heightPx * bg.cmPerPx * v.zoom)
    ctx.globalAlpha = 1
  }

  for (const room of plan.rooms) {
    ctx.beginPath()
    room.points.forEach((p, i) => (i ? ctx.lineTo(S(p).x, S(p).y) : ctx.moveTo(S(p).x, S(p).y)))
    ctx.closePath()
    ctx.fillStyle = 'rgba(250, 204, 21, 0.12)'
    ctx.fill()
    if (room.name) {
      const c = room.points.reduce((s, p) => ({ x: s.x + p.x / room.points.length, y: s.y + p.y / room.points.length }), { x: 0, y: 0 })
      ctx.fillStyle = '#854d0e'
      ctx.font = '12px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(room.name, S(c).x, S(c).y)
    }
  }

  // Vector lines, one batch per layer role, then the highlighted layer on top.
  const strokeLines = (keep: (layer: string) => boolean, color: string, width: number) => {
    ctx.beginPath()
    for (const l of plan.lines) {
      if (!keep(l.layer)) continue
      const a = S(l.a)
      const b = S(l.b)
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
    }
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.stroke()
  }
  for (const role of drawnRoles) {
    strokeLines((layer) => roleOf.get(layer) === role, ROLE_COLORS[role], role === 'wall' ? 1.6 : 1)
  }
  if (highlight) strokeLines((layer) => layer === highlight, '#db2777', 2)

  drawWalls(ctx, S, plan.suggestedWalls, plan.suggestedOpenings, true, v.zoom)
  drawWalls(ctx, S, plan.walls, plan.openings, false, v.zoom)
  drawScaleBar(ctx, size, v.zoom)
}

function drawWalls(ctx: CanvasRenderingContext2D, S: (p: Vec2) => Vec2, walls: Wall[], openings: Opening[], suggested: boolean, zoom: number) {
  ctx.setLineDash(suggested ? [5, 4] : [])
  for (const w of walls) {
    const c = wallCorners(w).map(S)
    ctx.beginPath()
    c.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
    ctx.closePath()
    ctx.fillStyle = suggested ? 'rgba(37, 99, 235, 0.22)' : '#334155'
    ctx.fill()
    ctx.strokeStyle = suggested ? '#2563eb' : '#0f172a'
    ctx.lineWidth = 1
    ctx.stroke()
  }
  ctx.setLineDash([])
  const byId = new Map(walls.map((w) => [w.id, w]))
  for (const o of openings) {
    const w = byId.get(o.wallId)
    if (!w) continue
    const len = dist(w.a, w.b) || 1
    const at = (t: number) => S({ x: w.a.x + ((w.b.x - w.a.x) * t) / len, y: w.a.y + ((w.b.y - w.a.y) * t) / len })
    const a = at(o.offset)
    const b = at(o.offset + o.width)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.strokeStyle = ROLE_COLORS[o.kind]
    ctx.lineWidth = Math.max(3, w.thickness * zoom * 0.8)
    ctx.stroke()
  }
}

function drawScaleBar(ctx: CanvasRenderingContext2D, size: { w: number; h: number }, zoom: number) {
  const lengths = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]
  const cm = lengths.find((l) => l * zoom >= 80) ?? lengths[lengths.length - 1]
  const px = cm * zoom
  const x = 16
  const y = size.h - 20
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.fillRect(x - 6, y - 22, px + 12, 30)
  ctx.strokeStyle = '#0f172a'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(x, y - 5)
  ctx.lineTo(x, y)
  ctx.lineTo(x + px, y)
  ctx.lineTo(x + px, y - 5)
  ctx.stroke()
  ctx.fillStyle = '#0f172a'
  ctx.font = '12px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(cm >= 100 ? `${cm / 100} m` : `${cm} cm`, x + px / 2, y - 8)
}

function drawPicks(ctx: CanvasRenderingContext2D, v: View, tool: string, picks: Vec2[], cursor: Vec2 | null) {
  if (!picks.length) return
  const S = (p: Vec2) => ({ x: p.x * v.zoom + v.ox, y: p.y * v.zoom + v.oy })
  const pts = cursor && (tool === 'straighten' || picks.length < 2) ? [...picks, cursor] : picks
  ctx.strokeStyle = '#dc2626'
  ctx.fillStyle = '#dc2626'
  ctx.lineWidth = 2
  ctx.beginPath()
  pts.map(S).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
  if (tool === 'straighten' && pts.length === 4) ctx.closePath()
  ctx.stroke()
  for (const p of picks.map(S)) {
    ctx.beginPath()
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2)
    ctx.fill()
  }
  if (tool === 'calibrate' && pts.length === 2) {
    const m = S({ x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 })
    ctx.font = 'bold 12px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(formatLength(dist(pts[0], pts[1])), m.x, m.y - 8)
  }
}
