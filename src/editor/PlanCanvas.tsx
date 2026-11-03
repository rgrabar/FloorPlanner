import { useEffect, useReducer, useRef, useState } from 'react'
import { dist, projectOnWall } from '../model/geometry'
import { planBounds } from '../model/plan'
import type { Opening, Plan, Vec2, Wall } from '../model/types'
import {
  acceptSuggestions,
  addOpening,
  addWall,
  deleteSelection,
  moveWall,
  moveWallEnd,
  splitWall,
  updateOpening,
  wallLength,
} from '../model/walls'
import { useStore, type DrawDefaults } from '../store/store'
import { CalibrateDialog } from './CalibrateDialog'
import { drawScene, type View } from './draw'
import { hitTest, snapPoint, wallAt, type Snap } from './snap'
import { ToolOptions } from './ToolOptions'

type Drag =
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'wall'; id: string; last: Vec2; started: boolean }
  | { kind: 'end'; id: string; end: 'a' | 'b'; started: boolean; ignore: Set<string> }
  | { kind: 'opening'; id: string; grab: number; started: boolean }

/** Where a new door/window would go for the mouse at `p`, or null when not over a wall. */
function openingPreview(p: Vec2, plan: Plan, zoom: number, kind: 'door' | 'window', d: DrawDefaults) {
  const hit = wallAt(p, plan.walls, zoom)
  if (!hit) return null
  const len = wallLength(hit.wall)
  const size = kind === 'door' ? { ...d.door, sill: 0 } : d.window
  const width = Math.min(size.width, len)
  const opening: Omit<Opening, 'id' | 'wallId'> = {
    kind,
    offset: Math.max(0, Math.min(len - width, hit.t - width / 2)),
    width,
    height: size.height,
    sill: size.sill,
  }
  return { wall: hit.wall, opening }
}

export function PlanCanvas() {
  const plan = useStore((s) => s.plan)
  const tool = useStore((s) => s.tool)
  const selection = useStore((s) => s.selection)
  const defaults = useStore((s) => s.defaults)
  const fitToken = useStore((s) => s.fitToken)
  const highlight = useStore((s) => s.highlightLayer)
  const { setTool, calibrate, straighten, select, edit, mutate, checkpoint } = useStore.getState()

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const view = useRef<View>({ ox: 40, oy: 40, zoom: 1 })
  const drag = useRef<Drag | null>(null)
  const spaceDown = useRef(false)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [cursor, setCursor] = useState<Vec2 | null>(null)
  const [snap, setSnap] = useState<Snap | null>(null)
  const [picks, setPicks] = useState<Vec2[]>([])
  const [measured, setMeasured] = useState<number | null>(null)
  // Wall drawing: where the next wall starts, and where this chain of walls began.
  const [wallStart, setWallStart] = useState<Vec2 | null>(null)
  const chain = useRef<{ first: Vec2; count: number } | null>(null)
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

  const endChain = () => {
    setWallStart(null)
    chain.current = null
  }

  // A new tool starts fresh.
  useEffect(() => {
    setPicks([])
    setMeasured(null)
    setSnap(null)
    endChain()
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

  // Keys that act on the plan: Space pans, Escape cancels, Delete removes, Enter accepts.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      const s = useStore.getState()
      if (e.code === 'Space') {
        spaceDown.current = true
        e.preventDefault()
      } else if (e.key === 'Escape') {
        setPicks([])
        setMeasured(null)
        if (chain.current) endChain()
        else s.select(null)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selection) {
        s.edit((p) => deleteSelection(p, s.selection))
        s.select(null)
      } else if (e.key === 'Enter' && s.selection?.kind === 'suggestion') {
        const id = s.selection.id
        s.edit((p) => acceptSuggestions(p, [id]))
        s.select({ kind: 'wall', id })
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

  const placing = tool === 'door' || tool === 'window' ? tool : null
  const preview = placing && cursor ? openingPreview(cursor, plan, view.current.zoom, placing, defaults) : null

  // Redraw after every render.
  useEffect(() => {
    const canvas = canvasRef.current!
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size.w * dpr)
    canvas.height = Math.round(size.h * dpr)
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawScene(ctx, size, view.current, plan, img, {
      selection,
      highlight,
      newWall: tool === 'wall' && wallStart && snap ? { a: wallStart, b: snap.p, thickness: defaults.wallThickness } : undefined,
      newOpening: preview ?? undefined,
      snap: tool === 'wall' ? snap : null,
      picks: { tool, points: picks, cursor },
    })
  })

  const toPlan = (e: React.PointerEvent | React.MouseEvent): Vec2 => {
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

  const startPan = (e: React.PointerEvent) => {
    drag.current = { kind: 'pan', x: e.clientX, y: e.clientY }
    canvasRef.current!.setPointerCapture(e.pointerId)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || e.button === 2 || tool === 'pan' || spaceDown.current) return startPan(e)
    if (e.button !== 0) return
    const p = toPlan(e)
    const zoom = view.current.zoom

    if (tool === 'select') {
      const hit = hitTest(p, plan, zoom, selection)
      if (!hit) {
        select(null)
        return startPan(e)
      }
      if (hit.kind === 'suggestion') return select({ kind: 'suggestion', id: hit.id })
      canvasRef.current!.setPointerCapture(e.pointerId)
      if (hit.kind === 'end') {
        // Walls joined at this end move along, so they mustn't be snap targets.
        const at = plan.walls.find((w) => w.id === hit.id)![hit.end]
        const ignore = new Set(plan.walls.filter((w) => dist(w.a, at) < 0.5 || dist(w.b, at) < 0.5).map((w) => w.id))
        drag.current = { kind: 'end', id: hit.id, end: hit.end, started: false, ignore }
      } else if (hit.kind === 'wall') {
        select({ kind: 'wall', id: hit.id })
        drag.current = { kind: 'wall', id: hit.id, last: p, started: false }
      } else {
        select({ kind: 'opening', id: hit.id })
        const o = plan.openings.find((x) => x.id === hit.id)!
        drag.current = { kind: 'opening', id: hit.id, grab: hit.t - o.offset, started: false }
      }
    } else if (tool === 'wall') {
      const s = snapPoint(p, plan, zoom, wallStart, e.altKey)
      if (!wallStart) {
        setWallStart(s.p)
        chain.current = { first: s.p, count: 0 }
        return
      }
      if (dist(s.p, wallStart) < 1) return
      const start = wallStart
      edit((pl) => addWall(pl, start, s.p, defaults.wallThickness).plan)
      const c = chain.current!
      c.count++
      // Clicking back on the first point closes the room.
      if (c.count >= 2 && dist(s.p, c.first) < 0.5) endChain()
      else setWallStart(s.p)
    } else if (placing) {
      // Use the click position itself, not the last hover preview.
      const target = openingPreview(p, plan, zoom, placing, defaults)
      if (!target) return
      const { wall, opening } = target
      let id = ''
      edit((pl) => {
        const r = addOpening(pl, { ...opening, wallId: wall.id })
        id = r.id
        return r.plan
      })
      select({ kind: 'opening', id })
    } else if (tool === 'calibrate' && picks.length < 2) {
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
    const p = toPlan(e)
    setCursor(p)
    const d = drag.current
    const zoom = view.current.zoom
    if (!d) {
      if (tool === 'wall') setSnap(snapPoint(p, plan, zoom, wallStart, e.altKey))
      return
    }
    if (d.kind === 'pan') {
      view.current.ox += e.clientX - d.x
      view.current.oy += e.clientY - d.y
      drag.current = { ...d, x: e.clientX, y: e.clientY }
      return
    }
    // The first real move of a drag saves one undo step for the whole drag.
    if (!d.started) {
      checkpoint()
      d.started = true
    }
    if (d.kind === 'end') {
      const wall = plan.walls.find((w) => w.id === d.id)
      if (!wall) return
      const others = { ...plan, walls: plan.walls.filter((w) => !d.ignore.has(w.id)) }
      const s = snapPoint(p, others, zoom, d.end === 'a' ? wall.b : wall.a, e.altKey)
      setSnap(s)
      mutate((pl) => moveWallEnd(pl, d.id, d.end, s.p))
    } else if (d.kind === 'wall') {
      const delta = { x: p.x - d.last.x, y: p.y - d.last.y }
      d.last = p
      mutate((pl) => moveWall(pl, d.id, delta))
    } else {
      const o = plan.openings.find((x) => x.id === d.id)
      const wall: Wall | undefined = o && plan.walls.find((w) => w.id === o.wallId)
      if (!wall) return
      const { t } = projectOnWall(p, wall)
      mutate((pl) => updateOpening(pl, d.id, { offset: t - d.grab }))
    }
  }

  const onPointerUp = () => {
    drag.current = null
    if (tool !== 'wall') setSnap(null)
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (tool === 'wall') return endChain()
    if (tool !== 'select') return
    // Double-clicking a wall splits it there.
    const p = toPlan(e)
    const hit = hitTest(p, plan, view.current.zoom, null)
    if (hit?.kind === 'wall') {
      edit((pl) => splitWall(pl, hit.id, hit.t))
      select(null)
    }
  }

  const onCalibrated = (realCm: number) => {
    const k = realCm / measured!
    view.current.zoom /= k // keep the picture where it is on screen
    calibrate(k)
    setTool('select')
  }

  const hint = (() => {
    if (tool === 'calibrate') {
      return picks.length === 0
        ? 'Click the start of a line whose real length you know (e.g. a dimension line). Hold Shift for a straight line.'
        : 'Click the end of the line.'
    }
    if (tool === 'straighten') return `Click the 4 corners of the plan on the photo (${picks.length}/4). Esc to start over.`
    if (tool === 'wall') {
      return wallStart
        ? 'Click to end this wall and start the next. Click the first point to close the room. Double-click or Esc to stop.'
        : 'Click where a wall starts (the middle of the wall). It snaps to wall ends, walls and 45°/90°. Hold Alt to not snap.'
    }
    if (placing) {
      return plan.walls.length
        ? `Click on a wall to place a ${placing}.`
        : `Draw walls (or accept the suggested ones) first, then place ${placing}s on them.`
    }
    return null
  })()

  const empty = !plan.source && !plan.background && !plan.walls.length

  return (
    <div ref={wrapRef} className={`canvas-wrap tool-${tool}`} onContextMenu={(e) => e.preventDefault()}>
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setCursor(null)}
        onDoubleClick={onDoubleClick}
      />
      {hint && <div className="hint">{hint}</div>}
      <ToolOptions />
      {empty && (
        <div className="empty">
          <h2>Drop a floorplan here</h2>
          <p>or click Open. Pictures, PDF, SVG, DXF, IFC and Sweet Home 3D files all work.</p>
          <p>You can also start drawing walls right away with the Wall tool.</p>
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
