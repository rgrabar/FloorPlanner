import { dist } from '../model/geometry'
import type { PlacedFurniture, Plan, Vec2 } from '../model/types'
import { joinedEnds, wallLength } from '../model/walls'
import { MODELS } from './model'
import { axes, footprint, modelOf } from './placement'

// How furniture fits in the rooms: what overlaps what, what goes through a wall, which
// clearances are blocked, how far a piece is from the walls, snapping, and standing on things.
// All in plan cm; heights in cm above the floor.

const TOUCH = 1 // overlaps of up to 1 cm count as touching

/** A solid piece of wall, from the floor up to `top` (the sill under a window). Doors are gaps. */
export interface WallPiece {
  poly: Vec2[]
  top: number
}

export function wallPieces(plan: Plan): WallPiece[] {
  const pieces: WallPiece[] = []
  for (const w of plan.walls) {
    const len = wallLength(w)
    if (!len) continue
    const u = { x: (w.b.x - w.a.x) / len, y: (w.b.y - w.a.y) / len }
    const n = { x: -u.y, y: u.x }
    const h = w.thickness / 2
    const ends = joinedEnds(w, plan.walls)
    const rect = (t0: number, t1: number): Vec2[] =>
      [
        [t0, h],
        [t1, h],
        [t1, -h],
        [t0, -h],
      ].map(([t, s]) => ({ x: w.a.x + u.x * t + n.x * s, y: w.a.y + u.y * t + n.y * s }))
    const height = w.height ?? plan.roomHeight
    const openings = plan.openings.filter((o) => o.wallId === w.id).sort((a, b) => a.offset - b.offset)
    let t = ends.a ? -h : 0
    for (const o of openings) {
      if (o.offset > t) pieces.push({ poly: rect(t, o.offset), top: height })
      if (o.kind === 'window' && o.sill > 0) pieces.push({ poly: rect(o.offset, o.offset + o.width), top: o.sill })
      t = Math.max(t, o.offset + o.width)
    }
    const end = len + (ends.b ? h : 0)
    if (end > t) pieces.push({ poly: rect(t, end), top: height })
  }
  return pieces
}

/** How deep two convex outlines overlap (0 when they don't). */
export function overlapDepth(a: Vec2[], b: Vec2[]): number {
  let least = Infinity
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]
      const q = poly[(i + 1) % poly.length]
      const len = dist(p, q)
      if (len < 1e-9) continue
      const n = { x: -(q.y - p.y) / len, y: (q.x - p.x) / len }
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity
      for (const s of a) {
        const d = s.x * n.x + s.y * n.y
        a0 = Math.min(a0, d)
        a1 = Math.max(a1, d)
      }
      for (const s of b) {
        const d = s.x * n.x + s.y * n.y
        b0 = Math.min(b0, d)
        b1 = Math.max(b1, d)
      }
      const overlap = Math.min(a1, b1) - Math.max(a0, b0)
      if (overlap <= 0) return 0
      least = Math.min(least, overlap)
    }
  }
  return least
}

export const heightOf = (f: PlacedFurniture) => modelOf(f)?.size[2] ?? 50
const bottomOf = (f: PlacedFurniture) => f.z ?? 0

/** Does one piece stand on the other (directly or on something standing on it)? */
function stacked(a: PlacedFurniture, b: PlacedFurniture, byId: Map<string, PlacedFurniture>): boolean {
  const supports = (top: PlacedFurniture, base: PlacedFurniture) => {
    for (let f: PlacedFurniture | undefined = top, k = 0; f?.on && k < 10; k++) {
      if (f.on === base.id) return true
      f = byId.get(f.on)
    }
    return false
  }
  return supports(a, b) || supports(b, a)
}

/** Chairs belong at tables and desks: pushed in under them, and in the space in front of them. */
function chairAtTable(a: PlacedFurniture, b: PlacedFurniture): boolean {
  const kind = (f: PlacedFurniture) => MODELS[f.model]?.generic?.kind ?? MODELS[f.model]?.category
  const chair = (f: PlacedFurniture) => {
    const k = kind(f)
    const size = modelOf(f)?.size ?? [100, 100]
    return k === 'chair' || k === 'office-chair' || (MODELS[f.model]?.category === 'seating' && size[0] <= 65 && size[1] <= 65)
  }
  const table = (f: PlacedFurniture) => ['table', 'desk', 'coffee-table'].includes(kind(f) ?? '')
  return (chair(a) && table(b)) || (chair(b) && table(a))
}

export interface Conflict {
  with: string[] // ids of the pieces it overlaps
  wall: boolean // goes through a wall
}

/** Pieces that overlap each other (at the same height) or go through a wall. */
export function conflicts(plan: Plan): Map<string, Conflict> {
  const items = plan.furniture
  const byId = new Map(items.map((f) => [f.id, f]))
  const shapes = items.map((f) => ({ f, poly: footprint(f), z0: bottomOf(f), z1: bottomOf(f) + heightOf(f) }))
  const out = new Map<string, Conflict>()
  const get = (id: string) => out.get(id) ?? (out.set(id, { with: [], wall: false }), out.get(id)!)
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const a = shapes[i]
      const b = shapes[j]
      if (a.z0 >= b.z1 - TOUCH || b.z0 >= a.z1 - TOUCH) continue
      if (stacked(a.f, b.f, byId) || chairAtTable(a.f, b.f)) continue
      if (overlapDepth(a.poly, b.poly) > TOUCH) {
        get(a.f.id).with.push(b.f.id)
        get(b.f.id).with.push(a.f.id)
      }
    }
  }
  const walls = wallPieces(plan)
  for (const s of shapes) {
    if (walls.some((w) => s.z0 < w.top - TOUCH && overlapDepth(s.poly, w.poly) > TOUCH)) get(s.f.id).wall = true
  }
  return out
}

type Side = 'front' | 'back' | 'left' | 'right'

function clearanceSides(f: PlacedFurniture): { side: Side; poly: Vec2[] }[] {
  const m = modelOf(f)
  if (!m) return []
  const [W, D] = m.size
  const { u, v } = axes(f)
  const at = (a: number, b: number) => ({ x: f.x + u.x * a + v.x * b, y: f.y + u.y * a + v.y * b })
  const box = (a0: number, b0: number, a1: number, b1: number) => [at(a0, b0), at(a1, b0), at(a1, b1), at(a0, b1)]
  const c = m.clearance
  const zones: { side: Side; poly: Vec2[] }[] = []
  if (c.front > 0) zones.push({ side: 'front', poly: box(-W / 2, D / 2, W / 2, D / 2 + c.front) })
  if (c.back > 0) zones.push({ side: 'back', poly: box(-W / 2, -D / 2 - c.back, W / 2, -D / 2) })
  if (c.left > 0) zones.push({ side: 'left', poly: box(-W / 2 - c.left, -D / 2, -W / 2, D / 2) })
  if (c.right > 0) zones.push({ side: 'right', poly: box(W / 2, -D / 2, W / 2 + c.right, D / 2) })
  return zones
}

/** The free space a piece needs around it (in front of a wardrobe, for its doors), as outlines. */
export function clearanceZones(f: PlacedFurniture): Vec2[][] {
  return clearanceSides(f).map((z) => z.poly)
}

/**
 * Pieces whose clearance is blocked by a wall or by another piece standing on the floor. Room on
 * the left and on the right (a bed's sides) means room on either: one free side is enough.
 */
export function blockedClearances(plan: Plan): Set<string> {
  const walls = wallPieces(plan)
  const floor = plan.furniture.filter((f) => !f.on)
  const blocked = new Set<string>()
  for (const f of plan.furniture) {
    if (f.on) continue
    const zones = clearanceSides(f)
    // Blocked: more than a corner of the space is taken (15 % of it).
    const hit = (z: Vec2[]) => {
      const limit = area(z) * 0.15
      return (
        walls.some((w) => overlapArea(z, w.poly) > limit) ||
        floor.some((o) => o.id !== f.id && !chairAtTable(f, o) && overlapArea(z, footprint(o)) > limit)
      )
    }
    const sides = zones.filter((z) => z.side === 'left' || z.side === 'right')
    const ends = zones.filter((z) => z.side === 'front' || z.side === 'back')
    if (ends.some((z) => hit(z.poly)) || (sides.length > 0 && sides.every((z) => hit(z.poly)))) blocked.add(f.id)
  }
  return blocked
}

function area(poly: Vec2[]): number {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % poly.length]
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a) / 2
}

/** The area two convex outlines share (one clipped by the other). */
export function overlapArea(a: Vec2[], b: Vec2[]): number {
  if (overlapDepth(a, b) <= 0) return 0
  // Clip a by each edge of b, keeping the side b's middle is on.
  const c = b.reduce((s, p) => ({ x: s.x + p.x / b.length, y: s.y + p.y / b.length }), { x: 0, y: 0 })
  let out = a
  for (let i = 0; i < b.length && out.length; i++) {
    const p = b[i]
    const q = b[(i + 1) % b.length]
    const side = (s: Vec2) => (q.x - p.x) * (s.y - p.y) - (q.y - p.y) * (s.x - p.x)
    const keep = Math.sign(side(c)) || 1
    const next: Vec2[] = []
    for (let k = 0; k < out.length; k++) {
      const s = out[k]
      const e = out[(k + 1) % out.length]
      const ds = side(s) * keep
      const de = side(e) * keep
      if (ds >= 0) next.push(s)
      if (ds * de < 0) {
        const t = ds / (ds - de)
        next.push({ x: s.x + (e.x - s.x) * t, y: s.y + (e.y - s.y) * t })
      }
    }
    out = next
  }
  return out.length >= 3 ? area(out) : 0
}

/** Distance from each side of a piece (back, front, left, right) straight out to the nearest wall. */
export function wallDistances(f: PlacedFurniture, plan: Plan): { from: Vec2; to: Vec2; cm: number }[] {
  const m = modelOf(f)
  if (!m) return []
  const [W, D] = m.size
  const { u, v } = axes(f)
  const sides = [
    { n: { x: -v.x, y: -v.y }, half: D / 2 },
    { n: v, half: D / 2 },
    { n: { x: -u.x, y: -u.y }, half: W / 2 },
    { n: u, half: W / 2 },
  ]
  const edges = wallPieces(plan).flatMap((w) => w.poly.map((p, i) => [p, w.poly[(i + 1) % w.poly.length]] as const))
  const out: { from: Vec2; to: Vec2; cm: number }[] = []
  for (const s of sides) {
    const from = { x: f.x + s.n.x * s.half, y: f.y + s.n.y * s.half }
    let best = Infinity
    for (const [p, q] of edges) {
      const t = rayHit(from, s.n, p, q)
      if (t !== null && t >= -0.5 && t < best) best = t
    }
    if (best < 1500) out.push({ from, to: { x: from.x + s.n.x * best, y: from.y + s.n.y * best }, cm: Math.max(0, best) })
  }
  return out
}

/** Where a ray from `o` along `d` crosses the segment p–q, as a distance, or null. */
function rayHit(o: Vec2, d: Vec2, p: Vec2, q: Vec2): number | null {
  const e = { x: q.x - p.x, y: q.y - p.y }
  const den = d.x * e.y - d.y * e.x
  if (Math.abs(den) < 1e-9) return null
  const w = { x: p.x - o.x, y: p.y - o.y }
  const t = (w.x * e.y - w.y * e.x) / den
  const s = (w.x * d.y - w.y * d.x) / den
  return s >= 0 && s <= 1 ? t : null
}

// ---------- snapping ----------

interface Face {
  a: Vec2
  b: Vec2
  n: Vec2 // outward
}

function facesOf(poly: Vec2[]): Face[] {
  const c = poly.reduce((s, p) => ({ x: s.x + p.x / poly.length, y: s.y + p.y / poly.length }), { x: 0, y: 0 })
  return poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length]
    const len = dist(a, b) || 1
    let n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len }
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    if ((mid.x - c.x) * n.x + (mid.y - c.y) * n.y < 0) n = { x: -n.x, y: -n.y }
    return { a, b, n }
  })
}

/**
 * Where a piece being moved should snap to: its sides against nearby wall faces and the sides of
 * other pieces (within `reach` cm), turned square to a wall it's nearly square to.
 */
export function snapPlacement(f: PlacedFurniture, plan: Plan, reach: number): { x: number; y: number; rotation: number } {
  const byId = new Map(plan.furniture.map((o) => [o.id, o]))
  const faces: Face[] = [
    ...wallPieces(plan).flatMap((w) => facesOf(w.poly)),
    ...plan.furniture.filter((o) => o.id !== f.id && !stacked(o, f, byId) && !o.on).flatMap((o) => facesOf(footprint(o))),
  ]
  let item = { ...f }
  const sides = (it: PlacedFurniture) => facesOf(footprint(it))
  const along = (s: Face, face: Face) => {
    // How much the side and the face overlap along the face.
    const t = { x: face.b.x - face.a.x, y: face.b.y - face.a.y }
    const len = Math.hypot(t.x, t.y) || 1
    const proj = (p: Vec2) => ((p.x - face.a.x) * t.x + (p.y - face.a.y) * t.y) / len
    const s0 = Math.min(proj(s.a), proj(s.b))
    const s1 = Math.max(proj(s.a), proj(s.b))
    return Math.min(s1, len) - Math.max(s0, 0)
  }
  const gapTo = (s: Face, face: Face) => {
    const mid = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 }
    return (mid.x - face.a.x) * face.n.x + (mid.y - face.a.y) * face.n.y
  }

  // 1. Square to the nearest face it's nearly square to (within 8°).
  let best: { gap: number; turn: number } | null = null
  for (const s of sides(item)) {
    for (const face of faces) {
      const facing = -(s.n.x * face.n.x + s.n.y * face.n.y)
      if (facing < Math.cos((8 * Math.PI) / 180) || along(s, face) <= 0) continue
      const gap = gapTo(s, face)
      if (Math.abs(gap) > reach || (best && Math.abs(gap) >= Math.abs(best.gap))) continue
      const turn = Math.atan2(s.n.x * -face.n.y - s.n.y * -face.n.x, s.n.x * -face.n.x + s.n.y * -face.n.y)
      best = { gap, turn }
    }
  }
  if (best && Math.abs(best.turn) > 1e-4) item = { ...item, rotation: (((item.rotation + (best.turn * 180) / Math.PI) % 360) + 360) % 360 }

  // 2. Slide against the nearest face along each of the piece's two axes.
  const { u, v } = axes(item)
  let dx = 0
  let dy = 0
  for (const axis of [u, v]) {
    let pick: { gap: number; n: Vec2 } | null = null
    for (const s of sides(item)) {
      if (Math.abs(s.n.x * axis.x + s.n.y * axis.y) < 0.99) continue
      for (const face of faces) {
        if (-(s.n.x * face.n.x + s.n.y * face.n.y) < 0.999 || along(s, face) <= 0) continue
        const gap = gapTo(s, face)
        if (Math.abs(gap) <= reach && (!pick || Math.abs(gap) < Math.abs(pick.gap))) pick = { gap, n: face.n }
      }
    }
    if (pick) {
      dx -= pick.n.x * pick.gap
      dy -= pick.n.y * pick.gap
    }
  }
  return { x: item.x + dx, y: item.y + dy, rotation: item.rotation }
}

// ---------- standing on things ----------

/** The surfaces of another piece that the point is over, highest first, with their height. */
export function surfacesUnder(p: Vec2, f: PlacedFurniture, plan: Plan): { host: PlacedFurniture; index: number; z: number; label: string }[] {
  const out: { host: PlacedFurniture; index: number; z: number; label: string }[] = []
  for (const host of plan.furniture) {
    if (host.id === f.id || host.on === f.id) continue
    const m = modelOf(host)
    if (!m?.surfaces.length) continue
    const [W, D] = m.size
    const { u, v } = axes(host)
    const corner = { x: host.x - u.x * (W / 2) - v.x * (D / 2), y: host.y - u.y * (W / 2) - v.y * (D / 2) }
    const lx = (p.x - corner.x) * u.x + (p.y - corner.y) * u.y
    const ly = (p.x - corner.x) * v.x + (p.y - corner.y) * v.y
    m.surfaces.forEach((s, index) => {
      const [ax, ay, aw, ad] = s.area
      if (lx >= ax && lx <= ax + aw && ly >= ay && ly <= ay + ad) out.push({ host, index, z: (host.z ?? 0) + s.z, label: s.label })
    })
  }
  return out.sort((a, b) => b.z - a.z)
}

/**
 * A piece moved to a new spot: put on the top surface of what's under its middle (or keep the
 * surface it was on, if it's still over it), or on the floor.
 */
export function standingFor(f: PlacedFurniture, plan: Plan): Pick<PlacedFurniture, 'on' | 'surface' | 'z'> {
  const under = surfacesUnder(f, f, plan)
  if (!under.length) return { on: undefined, surface: undefined, z: undefined }
  const same = under.find((s) => s.host.id === f.on && s.index === f.surface)
  const pick = same ?? under[0]
  return { on: pick.host.id, surface: pick.index, z: pick.z }
}

/** Moves (and turns) a piece, and everything standing on it along with it. */
export function moveFurniture(plan: Plan, id: string, to: { x: number; y: number; rotation: number }): Plan {
  const f = plan.furniture.find((x) => x.id === id) ?? plan.suggestedFurniture.find((x) => x.id === id)
  if (!f) return plan
  const turn = ((to.rotation - f.rotation) * Math.PI) / 180
  const cos = Math.cos(turn)
  const sin = Math.sin(turn)
  // Everything resting on this piece, directly or not.
  const moving = new Set([id])
  for (let added = true; added; ) {
    added = false
    for (const o of plan.furniture) {
      if (o.on && moving.has(o.on) && !moving.has(o.id)) {
        moving.add(o.id)
        added = true
      }
    }
  }
  const move = (o: PlacedFurniture): PlacedFurniture => {
    if (o.id === id) return { ...o, ...to }
    if (!moving.has(o.id)) return o
    const dx = o.x - f.x
    const dy = o.y - f.y
    return {
      ...o,
      x: to.x + dx * cos - dy * sin,
      y: to.y + dx * sin + dy * cos,
      rotation: (((o.rotation + to.rotation - f.rotation) % 360) + 360) % 360,
    }
  }
  return { ...plan, furniture: plan.furniture.map(move), suggestedFurniture: plan.suggestedFurniture.map(move) }
}

/** Pieces standing on a removed piece come down to the floor. */
export function dropOrphans(plan: Plan): Plan {
  const ids = new Set(plan.furniture.map((f) => f.id))
  if (plan.furniture.every((f) => !f.on || ids.has(f.on))) return plan
  return {
    ...plan,
    furniture: plan.furniture.map((f) => (f.on && !ids.has(f.on) ? { ...f, on: undefined, surface: undefined, z: undefined } : f)),
  }
}


/** Heights of everything standing on something, worked out again from what it stands on. */
export function restack(plan: Plan): Plan {
  const byId = new Map(plan.furniture.map((f) => [f.id, f]))
  const zOf = (f: PlacedFurniture, depth = 0): number => {
    if (!f.on || depth > 10) return 0
    const host = byId.get(f.on)
    const s = host && modelOf(host)?.surfaces[f.surface ?? -1]
    return host && s ? zOf(host, depth + 1) + s.z : 0
  }
  let changed = false
  const furniture = plan.furniture.map((f) => {
    if (!f.on) return f
    const z = zOf(f)
    if (z === (f.z ?? 0)) return f
    changed = true
    return { ...f, z }
  })
  return changed ? { ...plan, furniture } : plan
}

/**
 * A piece dragged to `to`: onto the surface under it (a shelf, a top), or on the floor snapped
 * against walls and other pieces (within `reach` cm; 0 for no snapping).
 */
export function dragFurniture(plan: Plan, f: PlacedFurniture, to: Vec2, reach: number): Plan {
  const moved = { ...f, x: to.x, y: to.y }
  const standing = standingFor(moved, plan)
  const place = standing.on || reach <= 0 ? { x: to.x, y: to.y, rotation: f.rotation } : snapPlacement(moved, plan, reach)
  const next = moveFurniture(plan, f.id, place)
  const set = (o: PlacedFurniture) => (o.id === f.id ? { ...o, ...standing } : o)
  return restack({ ...next, furniture: next.furniture.map(set), suggestedFurniture: next.suggestedFurniture.map(set) })
}
