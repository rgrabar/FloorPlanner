import { dist, projectOnWall } from '../model/geometry'
import { insideFootprint, modelOf } from '../furniture/placement'
import type { PlacedFurniture, Plan, Vec2, Wall } from '../model/types'
import { pointOnWall, type Selection } from '../model/walls'

const SNAP_PX = 10 // how close (in screen pixels) the mouse must be to snap
const ANGLE_STEP = Math.PI / 4 // 45°
const ANGLE_SNAP = (8 * Math.PI) / 180

export interface Snap {
  p: Vec2
  kind: 'end' | 'wall' | 'angle' | 'free'
}

/**
 * Where a click really lands while drawing walls: on an existing wall end, on a wall,
 * and/or at a 45°/90° angle from the previous point. Holding Alt turns snapping off.
 */
export function snapPoint(raw: Vec2, plan: Plan, zoom: number, from: Vec2 | null, free: boolean): Snap {
  if (free) return { p: raw, kind: 'free' }
  const tol = SNAP_PX / zoom

  // 1. Wall ends, and the ends of lines on wall layers.
  let best: Vec2 | null = null
  let bestD = tol
  const consider = (q: Vec2) => {
    const d = dist(raw, q)
    if (d < bestD) {
      best = q
      bestD = d
    }
  }
  for (const w of plan.walls) {
    consider(w.a)
    consider(w.b)
  }
  const wallLayers = new Set(plan.layers.filter((l) => l.role === 'wall').map((l) => l.name))
  for (const l of plan.lines) {
    if (!wallLayers.has(l.layer)) continue
    consider(l.a)
    consider(l.b)
  }
  if (best) return { p: { ...(best as Vec2) }, kind: 'end' }

  // 2. Straight angles from the previous point.
  let p = raw
  let kind: Snap['kind'] = 'free'
  if (from && dist(raw, from) > 0) {
    const angle = Math.atan2(raw.y - from.y, raw.x - from.x)
    const snapped = Math.round(angle / ANGLE_STEP) * ANGLE_STEP
    if (Math.abs(angle - snapped) < ANGLE_SNAP) {
      const r = dist(raw, from) * Math.cos(angle - snapped)
      p = { x: from.x + r * Math.cos(snapped), y: from.y + r * Math.sin(snapped) }
      kind = 'angle'
    }
  }

  // 3. Onto an existing wall (for T-junctions). With an angle, where the straight line meets the wall.
  const hit = wallAt(p, plan.walls, zoom)
  if (hit) {
    const crossing = kind === 'angle' && from ? intersect(from, p, hit.wall.a, hit.wall.b) : null
    return { p: crossing ?? pointOnWall(hit.wall, hit.t), kind: 'wall' }
  }
  return { p, kind }
}

/** The wall under a point (within its thickness, or a few pixels of its centreline). */
export function wallAt(p: Vec2, walls: Wall[], zoom: number): { wall: Wall; t: number } | null {
  let best: { wall: Wall; t: number; d: number } | null = null
  for (const wall of walls) {
    const { t, d, length } = projectOnWall(p, wall)
    if (t < 0 || t > length) continue
    if (d > Math.max(wall.thickness / 2, SNAP_PX / zoom)) continue
    if (!best || d < best.d) best = { wall, t, d }
  }
  return best
}

function intersect(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null {
  const d1 = { x: a2.x - a1.x, y: a2.y - a1.y }
  const d2 = { x: b2.x - b1.x, y: b2.y - b1.y }
  const den = d1.x * d2.y - d1.y * d2.x
  if (Math.abs(den) < 1e-9) return null
  const s = ((b1.x - a1.x) * d2.y - (b1.y - a1.y) * d2.x) / den
  return { x: a1.x + d1.x * s, y: a1.y + d1.y * s }
}

export type Hit =
  | { kind: 'end'; id: string; end: 'a' | 'b' }
  | { kind: 'opening'; id: string; t: number }
  | { kind: 'wall'; id: string; t: number }
  | { kind: 'suggestion'; id: string }
  | { kind: 'furniture'; id: string }

/** What's under the mouse in the select tool. Handles of the selected wall win, then openings, then walls. */
export function hitTest(p: Vec2, plan: Plan, zoom: number, selection: Selection): Hit | null {
  const tol = SNAP_PX / zoom
  if (selection?.kind === 'wall') {
    const w = plan.walls.find((x) => x.id === selection.id)
    if (w) {
      if (dist(p, w.a) < tol) return { kind: 'end', id: w.id, end: 'a' }
      if (dist(p, w.b) < tol) return { kind: 'end', id: w.id, end: 'b' }
    }
  }
  const onWall = wallAt(p, plan.walls, zoom)
  if (onWall) {
    const opening = plan.openings.find(
      (o) => o.wallId === onWall.wall.id && onWall.t >= o.offset - tol / 2 && onWall.t <= o.offset + o.width + tol / 2,
    )
    if (opening) return { kind: 'opening', id: opening.id, t: onWall.t }
    return { kind: 'wall', id: onWall.wall.id, t: onWall.t }
  }
  const pieces = [...plan.furniture, ...plan.suggestedFurniture].filter((f) => insideFootprint(p, f))
  if (pieces.length) {
    const area = (f: PlacedFurniture) => {
      const size = modelOf(f)?.size ?? [50, 50]
      return size[0] * size[1]
    }
    return { kind: 'furniture', id: pieces.sort((a, b) => area(a) - area(b))[0].id }
  }
  const suggestion = wallAt(p, plan.suggestedWalls, zoom)
  if (suggestion) return { kind: 'suggestion', id: suggestion.wall.id }
  return null
}
