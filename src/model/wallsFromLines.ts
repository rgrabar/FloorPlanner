import { attachOpenings, dist, newId, projectOnWall, type LooseOpening } from './geometry'
import type { Layer, LayerRole, Opening, Segment, Vec2, Wall } from './types'

// Finds walls in a drawing. A wall is drawn as two parallel outlines a wall-thickness apart,
// so outlines on wall layers are paired up and each pair becomes a wall along their middle.
// Collinear walls separated by a gap become one wall with a door or window in the gap.

const MIN_THICKNESS = 4 // cm
const MAX_THICKNESS = 60
const ANGLE_TOLERANCE = (2 * Math.PI) / 180
const MIN_OPENING = 40
const MAX_PASSAGE = 300 // an empty gap wider than this is open plan, not a doorway
const MAX_OPENING = 600 // wide windows and sliding doors, when drawn as such
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

/**
 * What a gap between two collinear wall pieces is: a door or window (optionally only part of
 * the gap, from..to along it), wall drawn in another style ('wall': just join), or something
 * that shouldn't be bridged ('none').
 */
export type GapKind =
  | { kind: 'door' | 'window'; from?: number; to?: number; passage?: boolean } // passage: an empty gap
  | { kind: 'wall' }
  | { kind: 'none' }
export type GapClassifier = (a: Vec2, b: Vec2, thickness: number) => GapKind

export interface Defaults {
  door: { height: number }
  window: { height: number; sill: number }
}

const DEFAULTS: Defaults = { door: { height: 210 }, window: { height: 120, sill: 90 } }

export function wallsFromLines(
  segments: Segment[],
  roleOf: Map<string, LayerRole>,
  defaults: Defaults = DEFAULTS,
  classify?: GapClassifier, // e.g. from the rendered page, instead of judging gaps by lines
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
  if (classify) return finishWalls(walls, classify, defaults)
  return finishWalls(walls, lineGapClassifier(openingLines, otherLines), defaults, false)
}

/** Joins collinear pieces (gaps become doors and windows) and makes wall ends meet. */
export function finishWalls(
  pieces: Wall[],
  classify: GapClassifier,
  defaults: Defaults = DEFAULTS,
  endOpenings = true,
): { walls: Wall[]; openings: Opening[] } {
  // Joining restarts after every merge and asks about the same gaps again; remember the answers.
  const answers = new Map<string, GapKind>()
  const remembered: GapClassifier = (a, b, thickness) => {
    const key = [a.x, a.y, b.x, b.y, thickness].map((v) => v.toFixed(1)).join(',')
    let kind = answers.get(key)
    if (!kind) answers.set(key, (kind = classify(a, b, thickness)))
    return kind
  }
  const loose: LooseOpening[] = []
  const merged = mergeCollinear(dropDuplicates(pieces), loose, remembered, defaults)
  const extended = endOpenings ? openingsAtEnds(merged, loose, remembered, defaults) : merged
  const walls = joinEnds(extended)
  return { walls, openings: attachOpenings(walls, loose) }
}

/** Removes walls lying almost entirely inside a longer wall on the same line (found twice). */
function dropDuplicates(walls: Wall[]): Wall[] {
  const kept: Wall[] = []
  for (const w of [...walls].sort((p, q) => dist(q.a, q.b) - dist(p.a, p.b))) {
    const len = dist(w.a, w.b)
    const dup = kept.some((k) => {
      if (Math.abs(dot(direction(k), direction(w))) < 0.98) return false
      const pa = projectOnWall(w.a, k)
      const pb = projectOnWall(w.b, k)
      const near = Math.max(k.thickness, w.thickness) / 2
      if (pa.d > near || pb.d > near) return false
      const inside = Math.min(pa.length, Math.max(pa.t, pb.t)) - Math.max(0, Math.min(pa.t, pb.t))
      return inside >= 0.7 * len
    })
    if (!dup) kept.push(w)
  }
  return kept
}

/**
 * Doors often sit at the end of a wall, right beside a crossing wall: the wall stops, there's a
 * door, then the other wall. A free wall end facing another wall across such a gap is extended
 * to it, with the door or window in the gap. Only with evidence (a swing, glazing): an empty gap
 * there is usually open plan, like a half-wall.
 */
function openingsAtEnds(walls: Wall[], loose: LooseOpening[], classify: GapClassifier, defaults: Defaults): Wall[] {
  const result = walls.map((w) => ({ ...w }))
  for (const w of result) {
    for (const end of ['a', 'b'] as const) {
      const p = w[end]
      const from = end === 'a' ? w.b : w.a
      const len = dist(from, p)
      if (len === 0) continue
      const dir = { x: (p.x - from.x) / len, y: (p.y - from.y) / len }
      // Already meeting a wall here?
      if (result.some((o) => o !== w && insideWall(p, { ...o, thickness: o.thickness + 4 }))) continue
      let best: { hit: Vec2; gap: number } | null = null
      for (const o of result) {
        if (o === w) continue
        const hit = intersect(from, p, o.a, o.b)
        if (!hit) continue
        const s = dot(sub(hit, p), dir)
        const gap = s - o.thickness / 2
        if (s <= 0 || gap < 2 || gap > MAX_OPENING) continue
        const { t, length } = projectOnWall(hit, o)
        if (t < -o.thickness / 2 || t > length + o.thickness / 2) continue
        if (!best || gap < best.gap) best = { hit, gap }
      }
      if (!best) continue
      const gapEnd = { x: p.x + dir.x * best.gap, y: p.y + dir.y * best.gap }
      const kind = classify(p, gapEnd, w.thickness)
      if (best.gap > MAX_PASSAGE && kind.kind !== 'window') continue
      if (kind.kind === 'wall') {
        w[end] = best.hit
      } else if ((kind.kind === 'door' && !kind.passage) || kind.kind === 'window') {
        if (best.gap < MIN_OPENING) continue
        const o0 = kind.from ?? 0
        const o1 = kind.to ?? best.gap
        const center = { x: p.x + dir.x * (o0 + o1) / 2, y: p.y + dir.y * (o0 + o1) / 2 }
        loose.push(
          kind.kind === 'door'
            ? { kind: 'door', center, width: o1 - o0, height: defaults.door.height, sill: 0 }
            : { kind: 'window', center, width: o1 - o0, height: defaults.window.height, sill: defaults.window.sill },
        )
        w[end] = best.hit
      }
    }
  }
  return result
}

/** Gap classification from drawn lines: door swings, glazing, or wall drawn in another style. */
function lineGapClassifier(openingLines: Segment[], otherLines: Segment[]): GapClassifier {
  return (gapA, gapB, thickness) => {
    const gap = dist(gapA, gapB)
    const u = { x: (gapB.x - gapA.x) / gap, y: (gapB.y - gapA.y) / gap }
    const at = (t: number) => ({ x: gapA.x + u.x * t, y: gapA.y + u.y * t })
    // The opening itself may be narrower than the gap: use its frame or glazing lines.
    const [o0, o1] = openingExtent(gapA, gapB, thickness, openingLines) ?? [0, gap]
    if (swingsOut(at(o0), at(o1), thickness, openingLines)) return { kind: 'door', from: o0, to: o1 }
    if (spanningLines(at(o0), at(o1), thickness, openingLines) >= 1) return { kind: 'window', from: o0, to: o1 }
    // Nothing across the gap: an open passage. Lines across it: wall drawn in another style.
    return spanningLines(gapA, gapB, thickness, otherLines) < 2 ? { kind: 'door', passage: true } : { kind: 'wall' }
  }
}

function mergeCollinear(walls: Wall[], loose: LooseOpening[], classify: GapClassifier, defaults: Defaults): Wall[] {
  let changed = true
  while (changed) {
    changed = false
    outer: for (let x = 0; x < walls.length; x++) {
      for (let y = x + 1; y < walls.length; y++) {
        const w1 = walls[x]
        const w2 = walls[y]
        // Same wall: similar thickness (measured walls vary a little) and on one line.
        if (Math.abs(w1.thickness - w2.thickness) > Math.max(2, 0.2 * Math.min(w1.thickness, w2.thickness))) continue
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
        } else if (gap <= MAX_OPENING) {
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
          const result = classify(at(gapStart), at(gapEnd), w1.thickness)
          if (result.kind === 'none') continue
          // Too narrow for a door or window: only join when it's drawn as wall.
          if (gap < MIN_OPENING && result.kind !== 'wall') continue
          // Only a window can be wider than a doorway; anything else that wide is open plan.
          if (gap > MAX_PASSAGE && result.kind !== 'window') continue
          // An empty gap with crossing walls at both ends is a corridor crossing, not a doorway.
          if (result.kind === 'door' && result.passage) {
            const crossed = (p: Vec2) =>
              walls.some((w) => w !== w1 && w !== w2 && Math.abs(dot(direction(w), u)) < 0.5 && insideWall(p, { ...w, thickness: w.thickness + w1.thickness + 6 }))
            if (crossed(at(gapStart)) && crossed(at(gapEnd))) continue
          }
          if (result.kind === 'door' || result.kind === 'window') {
            const o0 = result.from ?? 0
            const o1 = result.to ?? gap
            const oc = at(gapStart + (o0 + o1) / 2)
            loose.push(
              result.kind === 'door'
                ? { kind: 'door', center: oc, width: o1 - o0, height: defaults.door.height, sill: 0 }
                : { kind: 'window', center: oc, width: o1 - o0, height: defaults.window.height, sill: defaults.window.sill },
            )
          }
          // 'wall': the gap is wall drawn in another style (a light partition), so just join.
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

function direction(w: Wall): Vec2 {
  const len = dist(w.a, w.b) || 1
  return { x: (w.b.x - w.a.x) / len, y: (w.b.y - w.a.y) / len }
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

// ---------- which layers hold the walls ----------

const lineLength = (s: Segment | Wall) => dist(s.a, s.b)

/**
 * How convincing a set of walls is as a building: long walls whose ends join other walls. Walls
 * covering a large share of their own area are rejected: that's a grid or hatching, not walls.
 */
export function structureScore(walls: Wall[]): number {
  if (walls.length < 3) return 0
  const length = walls.reduce((t, w) => t + lineLength(w), 0)
  const ends = walls.flatMap((w) => [w.a, w.b])
  const joined = ends.filter((p) => walls.filter((w) => insideWall(p, { ...w, thickness: 2 })).length >= 2).length
  const xs = ends.map((p) => p.x)
  const ys = ends.map((p) => p.y)
  const box = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
  const area = walls.reduce((t, w) => t + lineLength(w) * w.thickness, 0)
  const filled = box > 0 ? area / box : 1
  return length * (joined / ends.length + 0.1) * (filled > 0.35 ? 0.05 : 1)
}

/** How much a layer looks like walls: long, joined-up pairs of outlines that use most of its lines. */
function wallScore(segments: Segment[], layer: string): number {
  const own = segments.filter((s) => s.layer === layer)
  const total = own.reduce((t, s) => t + lineLength(s), 0)
  if (own.length < 4 || total === 0) return 0
  const { walls } = wallsFromLines(own, new Map([[layer, 'wall']]))
  if (walls.length < 3) return 0
  const wallLength = walls.reduce((t, w) => t + lineLength(w), 0)
  // Each wall uses two outlines, so a pure wall layer has a coverage of about 1.
  const coverage = Math.min(1, (2 * wallLength) / total)
  if (coverage < 0.5) return 0
  // Very thin pairs are glazing or furniture outlines, not walls.
  const thickness = walls.map((w) => w.thickness).sort((a, b) => a - b)[walls.length >> 1]
  return structureScore(walls) * coverage * (thickness < 6 ? 0.2 : 1)
}

/**
 * For files whose layers don't say what they are (PDFs are split into layers by colour and pen
 * width), picks the wall layer(s) by trying each one, then the layer that best explains the
 * gaps in those walls as doors and windows.
 */
export function guessLayerRoles(segments: Segment[], layers: Layer[]): Layer[] {
  const candidates = layers.filter((l) => l.role !== 'hidden' && l.count <= MAX_LINES)
  const scored = candidates.map((l) => ({ name: l.name, score: wallScore(segments, l.name) })).sort((a, b) => b.score - a.score)
  if (!scored.length || scored[0].score === 0) return layers
  // Walls are sometimes split over a few layers (outer and inner walls): keep close runners-up.
  const wallLayers = new Set(scored.filter((s) => s.score >= scored[0].score * 0.5).map((s) => s.name))

  const rolesWith = (opening: (name: string) => boolean) =>
    new Map<string, LayerRole>(
      layers.map((l) => [l.name, wallLayers.has(l.name) ? 'wall' : opening(l.name) ? 'window' : l.role === 'hidden' ? 'hidden' : 'other']),
    )

  // Find every gap in the walls (with all other layers allowed to explain them), then pick the
  // layer whose lines are mostly at those gaps: door swings and glazing are, while text and
  // furniture are spread all over the plan.
  const { walls, openings } = wallsFromLines(segments, rolesWith(() => true))
  const byId = new Map(walls.map((w) => [w.id, w]))
  const atAGap = (p: Vec2) =>
    openings.some((o) => {
      const w = byId.get(o.wallId)
      if (!w) return false
      const { t, d } = projectOnWall(p, w)
      return t > o.offset - 10 && t < o.offset + o.width + 10 && d < o.width + w.thickness / 2 + 10
    })
  let best: { name?: string; score: number } = { score: 0 }
  for (const l of candidates) {
    if (wallLayers.has(l.name)) continue
    const own = segments.filter((s) => s.layer === l.name)
    const near = own.filter((s) => atAGap({ x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 })).length
    const score = near < 2 ? 0 : (near * near) / own.length // many lines at gaps, and few elsewhere
    if (score > best.score) best = { name: l.name, score }
  }
  const roles = rolesWith((name) => name === best.name)
  return layers.map((l) => ({ ...l, role: roles.get(l.name) ?? l.role }))
}
