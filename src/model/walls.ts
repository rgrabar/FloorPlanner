import { dist, newId } from './geometry'
import type { Opening, Plan, Vec2, Wall } from './types'

// Editing operations on my walls and openings. Each takes a plan and returns a new one.

const SAME_POINT = 0.5 // cm: wall ends closer than this count as joined

export type Selection = { kind: 'wall' | 'suggestion' | 'opening' | 'furniture'; id: string } | null

export const wallLength = (w: Wall) => dist(w.a, w.b)

export function pointOnWall(w: Wall, t: number): Vec2 {
  const len = wallLength(w) || 1
  return { x: w.a.x + ((w.b.x - w.a.x) * t) / len, y: w.a.y + ((w.b.y - w.a.y) * t) / len }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Keeps openings inside their wall after walls changed, and drops openings whose wall is gone. */
function fitOpenings(openings: Opening[], walls: Wall[]): Opening[] {
  const byId = new Map(walls.map((w) => [w.id, w]))
  return openings.flatMap((o) => {
    const w = byId.get(o.wallId)
    if (!w) return []
    const len = wallLength(w)
    const width = Math.min(o.width, len)
    return [{ ...o, width, offset: clamp(o.offset, 0, len - width) }]
  })
}

/** Moves every wall end sitting at `from` to `to`, so joined corners stay joined. */
function moveJoined(walls: Wall[], moves: { from: Vec2; to: Vec2 }[]): Wall[] {
  return walls.map((w) => {
    let { a, b } = w
    for (const m of moves) {
      if (dist(w.a, m.from) < SAME_POINT) a = m.to
      if (dist(w.b, m.from) < SAME_POINT) b = m.to
    }
    return a === w.a && b === w.b ? w : { ...w, a, b }
  })
}

function withWalls(plan: Plan, walls: Wall[]): Plan {
  return { ...plan, walls, openings: fitOpenings(plan.openings, walls) }
}

export function addWall(plan: Plan, a: Vec2, b: Vec2, thickness: number): { plan: Plan; id: string } {
  const id = newId()
  return { plan: { ...plan, walls: [...plan.walls, { id, a, b, thickness }] }, id }
}

export function updateWall(plan: Plan, id: string, patch: Partial<Omit<Wall, 'id'>>): Plan {
  return withWalls(plan, plan.walls.map((w) => (w.id === id ? { ...w, ...patch } : w)))
}

export function moveWallEnd(plan: Plan, id: string, end: 'a' | 'b', to: Vec2): Plan {
  const w = plan.walls.find((x) => x.id === id)
  return w ? withWalls(plan, moveJoined(plan.walls, [{ from: w[end], to }])) : plan
}

export function moveWall(plan: Plan, id: string, delta: Vec2): Plan {
  const w = plan.walls.find((x) => x.id === id)
  if (!w) return plan
  const shift = (p: Vec2) => ({ x: p.x + delta.x, y: p.y + delta.y })
  return withWalls(plan, moveJoined(plan.walls, [{ from: w.a, to: shift(w.a) }, { from: w.b, to: shift(w.b) }]))
}

/** Changes a wall's length by moving its end (b), keeping its direction. */
export function setWallLength(plan: Plan, id: string, length: number): Plan {
  const w = plan.walls.find((x) => x.id === id)
  if (!w || length <= 0) return plan
  const len = wallLength(w) || 1
  const to = { x: w.a.x + ((w.b.x - w.a.x) / len) * length, y: w.a.y + ((w.b.y - w.a.y) / len) * length }
  return moveWallEnd(plan, id, 'b', to)
}

/** Splits a wall in two at distance `t` from its start. Openings go with the part they're on. */
export function splitWall(plan: Plan, id: string, t: number): Plan {
  const w = plan.walls.find((x) => x.id === id)
  if (!w) return plan
  const len = wallLength(w)
  if (t < 1 || t > len - 1) return plan
  const p = pointOnWall(w, t)
  const first: Wall = { ...w, id: newId(), b: p }
  const second: Wall = { ...w, id: newId(), a: p }
  const walls = plan.walls.flatMap((x) => (x.id === id ? [first, second] : [x]))
  const openings = plan.openings.map((o) => {
    if (o.wallId !== id) return o
    const onFirst = o.offset + o.width / 2 < t
    return onFirst ? { ...o, wallId: first.id } : { ...o, wallId: second.id, offset: o.offset - t }
  })
  return { ...plan, walls, openings: fitOpenings(openings, walls) }
}

export function deleteWall(plan: Plan, id: string): Plan {
  return withWalls(plan, plan.walls.filter((w) => w.id !== id))
}

export function addOpening(plan: Plan, opening: Omit<Opening, 'id'>): { plan: Plan; id: string } {
  const id = newId()
  return { plan: { ...plan, openings: fitOpenings([...plan.openings, { ...opening, id }], plan.walls) }, id }
}

export function updateOpening(plan: Plan, id: string, patch: Partial<Omit<Opening, 'id'>>): Plan {
  return { ...plan, openings: fitOpenings(plan.openings.map((o) => (o.id === id ? { ...o, ...patch } : o)), plan.walls) }
}

export function deleteOpening(plan: Plan, id: string): Plan {
  return { ...plan, openings: plan.openings.filter((o) => o.id !== id) }
}

/** Turns suggested walls (all of them, or the given ones) into my walls, with their doors and windows. */
export function acceptSuggestions(plan: Plan, ids?: string[]): Plan {
  const take = new Set(ids ?? plan.suggestedWalls.map((w) => w.id))
  const moving = plan.suggestedWalls.filter((w) => take.has(w.id))
  return {
    ...plan,
    walls: [...plan.walls, ...moving],
    openings: [...plan.openings, ...plan.suggestedOpenings.filter((o) => take.has(o.wallId))],
    suggestedWalls: plan.suggestedWalls.filter((w) => !take.has(w.id)),
    suggestedOpenings: plan.suggestedOpenings.filter((o) => !take.has(o.wallId)),
  }
}

export function deleteSuggestion(plan: Plan, id: string): Plan {
  return {
    ...plan,
    suggestedWalls: plan.suggestedWalls.filter((w) => w.id !== id),
    suggestedOpenings: plan.suggestedOpenings.filter((o) => o.wallId !== id),
  }
}

export function clearSuggestions(plan: Plan): Plan {
  return { ...plan, suggestedWalls: [], suggestedOpenings: [] }
}

/**
 * Which ends of a wall meet another wall. Joined ends are drawn half a thickness longer,
 * so corners are filled instead of notched.
 */
export function joinedEnds(w: Wall, walls: Wall[]): { a: boolean; b: boolean } {
  const joined = (p: Vec2) =>
    walls.some((o) => {
      if (o === w) return false
      if (dist(p, o.a) < SAME_POINT || dist(p, o.b) < SAME_POINT) return true
      const len = wallLength(o) || 1
      const t = ((p.x - o.a.x) * (o.b.x - o.a.x) + (p.y - o.a.y) * (o.b.y - o.a.y)) / len
      const d = Math.abs(((p.x - o.a.x) * (o.b.y - o.a.y) - (p.y - o.a.y) * (o.b.x - o.a.x)) / len)
      return d < 1 && t > 0 && t < len
    })
  return { a: joined(w.a), b: joined(w.b) }
}

/** The outline of a wall, with joined ends extended by half its thickness. */
export function wallOutline(w: Wall, ends: { a: boolean; b: boolean }): Vec2[] {
  const len = wallLength(w) || 1
  const ux = (w.b.x - w.a.x) / len
  const uy = (w.b.y - w.a.y) / len
  const h = w.thickness / 2
  const a = ends.a ? { x: w.a.x - ux * h, y: w.a.y - uy * h } : w.a
  const b = ends.b ? { x: w.b.x + ux * h, y: w.b.y + uy * h } : w.b
  const nx = -uy * h
  const ny = ux * h
  return [
    { x: a.x + nx, y: a.y + ny },
    { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny },
    { x: a.x - nx, y: a.y - ny },
  ]
}

/** Removes whatever is selected. */
export function deleteSelection(plan: Plan, sel: Selection): Plan {
  if (!sel) return plan
  if (sel.kind === 'wall') return deleteWall(plan, sel.id)
  if (sel.kind === 'opening') return deleteOpening(plan, sel.id)
  if (sel.kind === 'furniture') {
    return {
      ...plan,
      furniture: plan.furniture.filter((f) => f.id !== sel.id),
      suggestedFurniture: plan.suggestedFurniture.filter((f) => f.id !== sel.id),
    }
  }
  return deleteSuggestion(plan, sel.id)
}
