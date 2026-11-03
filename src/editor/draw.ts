import { dist, formatLength } from '../model/geometry'
import type { LayerRole, Opening, Plan, Vec2, Wall } from '../model/types'
import { joinedEnds, pointOnWall, wallLength, wallOutline, type Selection } from '../model/walls'
import type { Snap } from './snap'

/** Screen position = plan position (cm) × zoom + offset. */
export interface View {
  ox: number
  oy: number
  zoom: number // screen pixels per cm
}

/** Things drawn on top of the plan while editing. */
export interface Overlay {
  selection: Selection
  highlight: string | null
  newWall?: { a: Vec2; b: Vec2; thickness: number }
  newOpening?: { wall: Wall; opening: Omit<Opening, 'id' | 'wallId'> }
  snap?: Snap | null
  picks?: { tool: string; points: Vec2[]; cursor: Vec2 | null }
}

const ROLE_COLORS: Record<LayerRole, string> = {
  wall: '#1d4ed8',
  door: '#ea580c',
  window: '#0891b2',
  other: '#475569',
  hidden: 'transparent',
}

const COLORS = {
  wall: '#334155',
  wallSelected: '#2563eb',
  suggestion: 'rgba(37, 99, 235, 0.22)',
  suggestionLine: '#2563eb',
  suggestionSelected: 'rgba(245, 158, 11, 0.45)',
  door: '#ea580c',
  window: '#0891b2',
  preview: 'rgba(22, 163, 74, 0.55)',
  snap: '#16a34a',
  pick: '#dc2626',
}

type Ctx = CanvasRenderingContext2D

export function drawScene(ctx: Ctx, size: { w: number; h: number }, v: View, plan: Plan, img: HTMLImageElement | null, o: Overlay) {
  const S = (p: Vec2) => ({ x: p.x * v.zoom + v.ox, y: p.y * v.zoom + v.oy })
  ctx.fillStyle = '#eef0f3'
  ctx.fillRect(0, 0, size.w, size.h)
  drawGrid(ctx, size, v)

  // Lines on "other" layers are already visible in the background picture, so with a picture
  // only lines I gave a role (or the layer I'm pointing at) are drawn on top.
  const bg = plan.background
  const roleOf = new Map(plan.layers.map((l) => [l.name, l.role]))
  const drawnRoles: LayerRole[] = bg ? ['window', 'door', 'wall'] : ['other', 'window', 'door', 'wall']
  const busy = plan.walls.length > 0 || o.highlight !== null || plan.layers.some((l) => l.role !== 'other' && l.role !== 'hidden')
  if (bg && img) {
    const tl = S({ x: bg.x, y: bg.y })
    ctx.imageSmoothingQuality = 'high'
    ctx.globalAlpha = busy ? 0.4 : 1 // let walls and coloured lines stand out
    ctx.drawImage(img, tl.x, tl.y, bg.widthPx * bg.cmPerPx * v.zoom, bg.heightPx * bg.cmPerPx * v.zoom)
    ctx.globalAlpha = 1
  }

  drawRooms(ctx, S, plan)

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
  if (o.highlight) strokeLines((layer) => layer === o.highlight, '#db2777', 2)

  const sel = o.selection
  drawWalls(ctx, S, plan.suggestedWalls, plan.suggestedOpenings, (w) =>
    sel?.kind === 'suggestion' && sel.id === w.id ? COLORS.suggestionSelected : COLORS.suggestion, true)
  drawWalls(ctx, S, plan.walls, plan.openings, (w) =>
    sel?.kind === 'wall' && sel.id === w.id ? COLORS.wallSelected : COLORS.wall, false, sel?.kind === 'opening' ? sel.id : null)

  // Handles on the ends of the selected wall.
  if (sel?.kind === 'wall') {
    const w = plan.walls.find((x) => x.id === sel.id)
    if (w) {
      for (const p of [w.a, w.b].map(S)) {
        ctx.fillStyle = 'white'
        ctx.strokeStyle = COLORS.wallSelected
        ctx.lineWidth = 2
        ctx.fillRect(p.x - 5, p.y - 5, 10, 10)
        ctx.strokeRect(p.x - 5, p.y - 5, 10, 10)
      }
      lengthLabel(ctx, S(w.a), S(w.b), wallLength(w))
    }
  }

  if (o.newWall) {
    const w: Wall = { id: '', ...o.newWall }
    fillPolygon(ctx, wallOutline(w, { a: false, b: false }).map(S), COLORS.preview)
    lengthLabel(ctx, S(w.a), S(w.b), dist(w.a, w.b))
  }
  if (o.newOpening) {
    drawOpening(ctx, S, o.newOpening.wall, { ...o.newOpening.opening, id: '', wallId: o.newOpening.wall.id }, COLORS.snap, false)
  }
  if (o.snap && o.snap.kind !== 'free') drawSnap(ctx, S(o.snap.p), o.snap.kind)
  if (o.picks) drawPicks(ctx, S, o.picks.tool, o.picks.points, o.picks.cursor)
  drawScaleBar(ctx, size, v.zoom)
}

function drawGrid(ctx: Ctx, size: { w: number; h: number }, v: View) {
  // 1 m squares, or 10 m when zoomed far out.
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
}

function drawRooms(ctx: Ctx, S: (p: Vec2) => Vec2, plan: Plan) {
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
}

function fillPolygon(ctx: Ctx, pts: Vec2[], fill: string, stroke?: string, dashed = false) {
  ctx.beginPath()
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
  ctx.closePath()
  ctx.fillStyle = fill
  ctx.fill()
  if (stroke) {
    ctx.setLineDash(dashed ? [5, 4] : [])
    ctx.strokeStyle = stroke
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.setLineDash([])
  }
}

function drawWalls(
  ctx: Ctx,
  S: (p: Vec2) => Vec2,
  walls: Wall[],
  openings: Opening[],
  fillOf: (w: Wall) => string,
  suggested: boolean,
  selectedOpening: string | null = null,
) {
  for (const w of walls) {
    fillPolygon(ctx, wallOutline(w, joinedEnds(w, walls)).map(S), fillOf(w), suggested ? COLORS.suggestionLine : undefined, suggested)
  }
  const byId = new Map(walls.map((w) => [w.id, w]))
  for (const o of openings) {
    const w = byId.get(o.wallId)
    if (w) drawOpening(ctx, S, w, o, o.id === selectedOpening ? COLORS.wallSelected : COLORS[o.kind], suggested)
  }
}

/** A door: gap, leaf and swing arc. A window: gap with glazing lines. */
function drawOpening(ctx: Ctx, S: (p: Vec2) => Vec2, w: Wall, o: Opening, color: string, faint: boolean) {
  const len = wallLength(w) || 1
  const u = { x: (w.b.x - w.a.x) / len, y: (w.b.y - w.a.y) / len }
  const n = { x: -u.y, y: u.x }
  const h = w.thickness / 2
  const at = (t: number, off: number) => {
    const p = pointOnWall(w, t)
    return S({ x: p.x + n.x * off, y: p.y + n.y * off })
  }
  const t0 = o.offset
  const t1 = o.offset + o.width
  ctx.globalAlpha = faint ? 0.7 : 1
  fillPolygon(ctx, [at(t0, h), at(t1, h), at(t1, -h), at(t0, -h)], '#ffffff', color)
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.beginPath()
  if (o.kind === 'window') {
    ctx.moveTo(at(t0, 0).x, at(t0, 0).y)
    ctx.lineTo(at(t1, 0).x, at(t1, 0).y)
  } else {
    // Leaf opened 90° on the +n side, hinged at the start, and its swing.
    const hinge = at(t0, h)
    const leafEnd = at(t0, h + o.width)
    ctx.moveTo(hinge.x, hinge.y)
    ctx.lineTo(leafEnd.x, leafEnd.y)
    const r = Math.hypot(leafEnd.x - hinge.x, leafEnd.y - hinge.y)
    const close = at(t1, h)
    const startAngle = Math.atan2(leafEnd.y - hinge.y, leafEnd.x - hinge.x)
    const endAngle = Math.atan2(close.y - hinge.y, close.x - hinge.x)
    // Pick the short way round (90°).
    let diff = endAngle - startAngle
    while (diff > Math.PI) diff -= 2 * Math.PI
    while (diff < -Math.PI) diff += 2 * Math.PI
    ctx.moveTo(leafEnd.x, leafEnd.y)
    ctx.arc(hinge.x, hinge.y, r, startAngle, startAngle + diff, diff < 0)
  }
  ctx.stroke()
  ctx.globalAlpha = 1
}

function lengthLabel(ctx: Ctx, a: Vec2, b: Vec2, cm: number) {
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const text = formatLength(cm)
  ctx.font = 'bold 12px system-ui, sans-serif'
  const w = ctx.measureText(text).width + 8
  ctx.fillStyle = 'rgba(15, 23, 42, 0.85)'
  ctx.fillRect(m.x - w / 2, m.y - 22, w, 17)
  ctx.fillStyle = 'white'
  ctx.textAlign = 'center'
  ctx.fillText(text, m.x, m.y - 9)
}

function drawSnap(ctx: Ctx, p: Vec2, kind: string) {
  ctx.strokeStyle = COLORS.snap
  ctx.lineWidth = 2
  ctx.beginPath()
  if (kind === 'end') ctx.rect(p.x - 6, p.y - 6, 12, 12)
  else if (kind === 'wall') ctx.arc(p.x, p.y, 6, 0, Math.PI * 2)
  else {
    ctx.moveTo(p.x - 6, p.y)
    ctx.lineTo(p.x + 6, p.y)
    ctx.moveTo(p.x, p.y - 6)
    ctx.lineTo(p.x, p.y + 6)
  }
  ctx.stroke()
}

function drawScaleBar(ctx: Ctx, size: { w: number; h: number }, zoom: number) {
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

function drawPicks(ctx: Ctx, S: (p: Vec2) => Vec2, tool: string, picks: Vec2[], cursor: Vec2 | null) {
  if (!picks.length) return
  const pts = cursor && (tool === 'straighten' || picks.length < 2) ? [...picks, cursor] : picks
  ctx.strokeStyle = COLORS.pick
  ctx.fillStyle = COLORS.pick
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
  if (tool === 'calibrate' && pts.length === 2) lengthLabel(ctx, S(pts[0]), S(pts[1]), dist(pts[0], pts[1]))
}
