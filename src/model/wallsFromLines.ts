import { attachOpenings, dist, newId, projectOnWall, type LooseOpening } from './geometry'
import type { LayerRole, Opening, Segment, Vec2, Wall } from './types'

// Finds walls in a drawing. A wall is drawn as two parallel outlines a wall-thickness apart,
// so outlines on wall layers are paired up and each pair becomes a wall along their middle.
// Collinear walls separated by a gap become one wall with a door or window in the gap.

const MIN_THICKNESS = 4 // cm
const MAX_THICKNESS = 60
const ANGLE_TOLERANCE = (2 * Math.PI) / 180
const MIN_OPENING = 40
const MAX_OPENING = 300
const MAX_LINES = 20_000

interface Line {
  a: Vec2
  u: Vec2 // unit direction
  n: Vec2 // unit normal (u turned 90°)
  len: number
  angle: number // 0..π
  covered: [[number, number][], [number, number][]] // used stretches on each side (-n, +n)
}

const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y
const sub = (a: Vec2, b: Vec2) => ({ x: a.x - b.x, y: a.y - b.y })
const along = (l: Line, t: number, off = 0): Vec2 => ({ x: l.a.x + l.u.x * t + l.n.x * off, y: l.a.y + l.u.y * t + l.n.y * off })

function toLine(s: Segment): Line {
  const len = dist(s.a, s.b)
  let u = { x: (s.b.x - s.a.x) / len, y: (s.b.y - s.a.y) / len }
  let a = s.a
  // Same direction for all parallel lines, so their projections can be compared.
  if (u.y < 0 || (u.y === 0 && u.x < 0)) {
    u = { x: -u.x, y: -u.y }
    a = s.b
  }
  return { a, u, n: { x: -u.y, y: u.x }, len, angle: Math.atan2(u.y, u.x), covered: [[], []] }
}

function coveredFraction(spans: [number, number][], from: number, to: number) {
  let covered = 0
  for (const [s, e] of spans) covered += Math.max(0, Math.min(e, to) - Math.max(s, from))
  return covered / (to - from)
}

export interface Defaults {
  door: { height: number }
  window: { height: number; sill: number }
}

const DEFAULTS: Defaults = { door: { height: 210 }, window: { height: 120, sill: 90 } }

export function wallsFromLines(
  segments: Segment[],
  roleOf: Map<string, LayerRole>,
  defaults: Defaults = DEFAULTS,
): { walls: Wall[]; openings: Opening[] } {
  const lines = segments
    .filter((s) => roleOf.get(s.layer) === 'wall' && dist(s.a, s.b) >= 10)
    .slice(0, MAX_LINES)
    .map(toLine)
  const openingLines = segments.filter((s) => {
    const role = roleOf.get(s.layer)
    return role === 'door' || role === 'window'
  })
  const otherLines = segments.filter((s) => {
    const role = roleOf.get(s.layer)
    return role === 'other' || role === 'hidden'
  })

  // 1. Pair parallel outlines, thinnest walls first.
  const pairs: { i: Line; j: Line; d: number; from: number; to: number }[] = []
  const tryPair = (i: Line, j: Line) => {
    const d = dot(sub(j.a, i.a), i.n) // signed: which side of i the line j is on
    if (Math.abs(d) < MIN_THICKNESS || Math.abs(d) > MAX_THICKNESS) return
    const t1 = dot(sub(j.a, i.a), i.u)
    const t2 = dot(sub(along(j, j.len), i.a), i.u)
    const from = Math.max(0, Math.min(t1, t2))
    const to = Math.min(i.len, Math.max(t1, t2))
    if (to - from < Math.max(15, Math.abs(d))) return // a wall is longer than it is thick
    pairs.push({ i, j, d, from, to })
  }
  const sorted = [...lines].sort((p, q) => p.angle - q.angle)
  for (let x = 0; x < sorted.length; x++) {
    for (let y = x + 1; y < sorted.length && sorted[y].angle - sorted[x].angle <= ANGLE_TOLERANCE; y++) {
      tryPair(sorted[x], sorted[y])
    }
  }
  // Directions just above 0 and just below π are nearly parallel too.
  for (let x = 0; x < sorted.length && sorted[x].angle <= ANGLE_TOLERANCE; x++) {
    for (let y = sorted.length - 1; y > x && sorted[y].angle >= Math.PI - ANGLE_TOLERANCE; y--) {
      tryPair(sorted[x], sorted[y])
    }
  }
  pairs.sort((p, q) => Math.abs(p.d) - Math.abs(q.d))

  let walls: Wall[] = []
  for (const { i, j, d, from, to } of pairs) {
    // Which side each outline faces this wall on, and the stretch used on j (in j's own terms).
    const sideI = d > 0 ? 1 : 0
    const sideJ = dot(sub(i.a, j.a), j.n) > 0 ? 1 : 0
    const ja = dot(sub(along(i, from), j.a), j.u)
    const jb = dot(sub(along(i, to), j.a), j.u)
    const jFrom = Math.min(ja, jb)
    const jTo = Math.max(ja, jb)
    // Each outline faces only one wall on each side.
    if (coveredFraction(i.covered[sideI], from, to) > 0.5 || coveredFraction(j.covered[sideJ], jFrom, jTo) > 0.5) continue
    i.covered[sideI].push([from, to])
    j.covered[sideJ].push([jFrom, jTo])
    walls.push({ id: newId(), a: along(i, from, d / 2), b: along(i, to, d / 2), thickness: Math.abs(d) })
  }

  // 2. Join collinear pieces; gaps between them become doors and windows.
  const loose: LooseOpening[] = []
  walls = mergeCollinear(walls, loose, openingLines, otherLines, defaults)

  // 3. Extend wall ends to meet at corners and T-junctions.
  walls = joinEnds(walls)

  return { walls, openings: attachOpenings(walls, loose) }
}

function mergeCollinear(
  walls: Wall[],
  loose: LooseOpening[],
  openingLines: Segment[],
  otherLines: Segment[],
  defaults: Defaults,
): Wall[] {
  let changed = true
  while (changed) {
    changed = false
    outer: for (let x = 0; x < walls.length; x++) {
      for (let y = x + 1; y < walls.length; y++) {
        const w1 = walls[x]
        const w2 = walls[y]
        if (Math.abs(w1.thickness - w2.thickness) > 2) continue
        const l1 = dist(w1.a, w1.b)
        const u = { x: (w1.b.x - w1.a.x) / l1, y: (w1.b.y - w1.a.y) / l1 }
        const n = { x: -u.y, y: u.x }
        const off = (p: Vec2) => dot(sub(p, w1.a), n)
        const tol = Math.max(1.5, w1.thickness * 0.2)
        if (Math.abs(off(w2.a)) > tol || Math.abs(off(w2.b)) > tol) continue
        const t = (p: Vec2) => dot(sub(p, w1.a), u)
        const s2 = Math.min(t(w2.a), t(w2.b))
        const e2 = Math.max(t(w2.a), t(w2.b))
        const start = Math.min(0, s2)
        const end = Math.max(l1, e2)
        const gapStart = s2 > l1 ? l1 : e2 < 0 ? e2 : NaN
        const gapEnd = s2 > l1 ? s2 : e2 < 0 ? 0 : NaN
        const gap = gapEnd - gapStart
        const at = (tt: number) => ({ x: w1.a.x + u.x * tt, y: w1.a.y + u.y * tt })
        if (Number.isNaN(gap) || gap <= 2) {
          // Overlapping or touching: one wall.
        } else if (gap >= MIN_OPENING && gap <= MAX_OPENING) {
          const center = at((gapStart + gapEnd) / 2)
          // Only bridge empty gaps: not one with another wall in it, a wall ending in its middle
          // (a T-junction), or one that another wall runs through. A wall ending at the edge of
          // the gap is fine: it's the corner beside a door.
          const inGap = (p: Vec2, w: Wall) => {
            const tp = t(p)
            const margin = w.thickness / 2 + 2
            return Math.abs(off(p)) <= w1.thickness / 2 + 2 && tp > gapStart + margin && tp < gapEnd - margin
          }
          if (walls.some((w) => w !== w1 && w !== w2 && (inGap(w.a, w) || inGap(w.b, w) || insideWall(center, w)))) continue
          const gapA = at(gapStart)
          const gapB = at(gapEnd)
          // The opening itself may be narrower than the gap: use its frame or glazing lines.
          const [o0, o1] = openingExtent(gapA, gapB, w1.thickness, openingLines) ?? [0, gap]
          const oa = at(gapStart + o0)
          const ob = at(gapStart + o1)
          const oc = at(gapStart + (o0 + o1) / 2)
          if (swingsOut(oa, ob, w1.thickness, openingLines)) {
            // Lines reaching out of the wall: a door leaf or its swing.
            loose.push({ kind: 'door', center: oc, width: o1 - o0, height: defaults.door.height, sill: 0 })
          } else if (spanningLines(oa, ob, w1.thickness, openingLines) >= 1) {
            // Glazing inside the wall: a window.
            loose.push({ kind: 'window', center: oc, width: o1 - o0, height: defaults.window.height, sill: defaults.window.sill })
          } else if (spanningLines(gapA, gapB, w1.thickness, otherLines) < 2) {
            // Nothing across the gap: an open passage, kept as a door opening.
            loose.push({ kind: 'door', center, width: gap, height: defaults.door.height, sill: 0 })
          }
          // Otherwise the gap is wall drawn in another style (a light partition): just join.
        } else continue
        const merged: Wall = { ...w1, id: newId(), a: at(start), b: at(end), thickness: (w1.thickness + w2.thickness) / 2 }
        walls = [...walls.filter((w) => w !== w1 && w !== w2), merged]
        changed = true
        break outer
      }
    }
  }
  return walls
}

function insideWall(p: Vec2, w: Wall) {
  const { t, d, length } = projectOnWall(p, w)
  return d <= w.thickness / 2 + 1 && t >= 0 && t <= length
}

/**
 * The stretch of a gap (distances from `a`) covered by door/window lines running along the wall
 * inside its thickness, or null when there are none (or they cover too little to trust).
 */
function openingExtent(a: Vec2, b: Vec2, thickness: number, lines: Segment[]): [number, number] | null {
  const gap = dist(a, b)
  const u = { x: (b.x - a.x) / gap, y: (b.y - a.y) / gap }
  const n = { x: -u.y, y: u.x }
  let lo = Infinity
  let hi = -Infinity
  for (const l of lines) {
    const len = dist(l.a, l.b)
    if (len < 10 || Math.abs(dot(sub(l.b, l.a), u)) / len < 0.98) continue
    if (Math.abs(dot(sub(l.a, a), n)) > thickness / 2 + 2) continue
    const ta = Math.max(0, Math.min(dot(sub(l.a, a), u), dot(sub(l.b, a), u)))
    const tb = Math.min(gap, Math.max(dot(sub(l.a, a), u), dot(sub(l.b, a), u)))
    if (tb - ta < 20) continue
    lo = Math.min(lo, ta)
    hi = Math.max(hi, tb)
  }
  return hi - lo >= MIN_OPENING ? [lo, hi] : null
}

/** True when door/window lines at a gap reach well outside the wall: a door leaf or swing arc. */
function swingsOut(a: Vec2, b: Vec2, thickness: number, lines: Segment[]): boolean {
  const gap = dist(a, b)
  const u = { x: (b.x - a.x) / gap, y: (b.y - a.y) / gap }
  const n = { x: -u.y, y: u.x }
  return lines.some((l) =>
    [l.a, l.b].some((p) => {
      const tp = dot(sub(p, a), u)
      const off = Math.abs(dot(sub(p, a), n))
      return tp >= -2 && tp <= gap + 2 && off > thickness / 2 + 10 && off < gap + thickness
    }),
  )
}

/**
 * How many separate lines run along a wall gap, inside the wall's thickness. Windows show two or
 * more (glass, frame); doors at most a threshold.
 */
function spanningLines(a: Vec2, b: Vec2, thickness: number, lines: Segment[]): number {
  const gap = dist(a, b)
  const u = { x: (b.x - a.x) / gap, y: (b.y - a.y) / gap }
  const n = { x: -u.y, y: u.x }
  const offsets: number[] = []
  for (const l of lines) {
    const len = dist(l.a, l.b)
    if (len < gap * 0.5) continue
    if (Math.abs(dot(sub(l.b, l.a), u)) / len < 0.98) continue // not parallel to the wall
    const ta = dot(sub(l.a, a), u)
    const tb = dot(sub(l.b, a), u)
    const covered = Math.min(gap, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb))
    if (covered < gap * 0.5) continue
    const off = dot(sub(l.a, a), n)
    if (Math.abs(off) > thickness / 2 + 2) continue
    // Lines at the same offset (one line drawn in pieces) count once.
    if (!offsets.some((o) => Math.abs(o - off) < 1)) offsets.push(off)
  }
  return offsets.length
}

/** Moves wall ends that stop short of another wall onto that wall's centreline. */
function joinEnds(walls: Wall[]): Wall[] {
  const result = walls.map((w) => ({ ...w }))
  for (const w of result) {
    for (const end of ['a', 'b'] as const) {
      let best: { p: Vec2; d: number } | null = null
      for (const other of result) {
        if (other === w) continue
        const p = intersect(w.a, w.b, other.a, other.b)
        if (!p) continue
        const d = dist(w[end], p)
        const reach = Math.max(w.thickness, other.thickness) + 2
        if (d > reach) continue
        // The meeting point must lie on (or just past the end of) the other wall.
        const { t, length } = projectOnWall(p, other)
        if (t < -w.thickness || t > length + w.thickness) continue
        // And it must be beyond this end, not back inside the wall.
        const other_end = end === 'a' ? w.b : w.a
        if (dist(other_end, p) < dist(other_end, w[end]) - 0.5) continue
        if (!best || d < best.d) best = { p, d }
      }
      if (best) w[end] = best.p
    }
  }
  return result
}

/** Where two infinite lines cross, or null when they're (nearly) parallel. */
function intersect(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null {
  const d1 = sub(a2, a1)
  const d2 = sub(b2, b1)
  const den = d1.x * d2.y - d1.y * d2.x
  const lens = Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y)
  if (Math.abs(den) < lens * Math.sin((20 * Math.PI) / 180)) return null
  const s = ((b1.x - a1.x) * d2.y - (b1.y - a1.y) * d2.x) / den
  return { x: a1.x + d1.x * s, y: a1.y + d1.y * s }
}
