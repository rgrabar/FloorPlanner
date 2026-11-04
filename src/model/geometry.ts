import type { Opening, OpeningKind, Vec2, Wall } from './types'

export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y)

export const newId = () => Math.random().toString(36).slice(2, 10)

// ---------- 2D affine transforms ----------
// [a, b, c, d, e, f] maps (x, y) to (a*x + c*y + e, b*x + d*y + f),
// the same convention as PDF and the canvas API.

export type Affine = [number, number, number, number, number, number]

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0]

export function applyAffine(m: Affine, x: number, y: number): Vec2 {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
}

/** Returns the transform that applies `inner` first, then `outer`. */
export function composeAffine(outer: Affine, inner: Affine): Affine {
  const [a, b, c, d, e, f] = outer
  const [A, B, C, D, E, F] = inner
  return [a * A + c * B, b * A + d * B, a * C + c * D, b * C + d * D, a * E + c * F + e, b * E + d * F + f]
}

// ---------- bounds ----------

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function boundsOf(points: Iterable<Vec2>): Bounds | null {
  let b: Bounds | null = null
  for (const p of points) {
    if (!b) b = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y }
    else {
      b.minX = Math.min(b.minX, p.x)
      b.minY = Math.min(b.minY, p.y)
      b.maxX = Math.max(b.maxX, p.x)
      b.maxY = Math.max(b.maxY, p.y)
    }
  }
  return b
}

// ---------- rectangles (used to turn 3D wall meshes into walls) ----------

function convexHull(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((p, q) => p.x - q.x || p.y - q.y)
  if (pts.length < 3) return pts
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Vec2[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Vec2[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

export interface Rect {
  center: Vec2
  axis: Vec2 // unit vector along the long side
  length: number
  width: number
}

/** The smallest rectangle around the points, with `axis` along its long side. */
export function minAreaRect(points: Vec2[]): Rect | null {
  const hull = convexHull(points)
  if (hull.length < 3) return null
  let best: Rect | null = null
  let bestArea = Infinity
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i]
    const q = hull[(i + 1) % hull.length]
    const len = dist(p, q)
    if (len < 1e-9) continue
    const u = { x: (q.x - p.x) / len, y: (q.y - p.y) / len }
    const n = { x: -u.y, y: u.x }
    let minU = Infinity, maxU = -Infinity, minN = Infinity, maxN = -Infinity
    for (const h of hull) {
      const pu = h.x * u.x + h.y * u.y
      const pn = h.x * n.x + h.y * n.y
      minU = Math.min(minU, pu); maxU = Math.max(maxU, pu)
      minN = Math.min(minN, pn); maxN = Math.max(maxN, pn)
    }
    const du = maxU - minU
    const dn = maxN - minN
    if (du * dn < bestArea) {
      bestArea = du * dn
      const cu = (minU + maxU) / 2
      const cn = (minN + maxN) / 2
      const center = { x: u.x * cu + n.x * cn, y: u.y * cu + n.y * cn }
      best = du >= dn ? { center, axis: u, length: du, width: dn } : { center, axis: n, length: dn, width: du }
    }
  }
  return best
}

export function wallFromRect(r: Rect, height?: number): Wall {
  const h = r.length / 2
  return {
    id: newId(),
    a: { x: r.center.x - r.axis.x * h, y: r.center.y - r.axis.y * h },
    b: { x: r.center.x + r.axis.x * h, y: r.center.y + r.axis.y * h },
    thickness: r.width,
    height,
  }
}

/** The four corners of a wall, for drawing. */
export function wallCorners(w: Wall): Vec2[] {
  const len = dist(w.a, w.b) || 1
  const nx = (-(w.b.y - w.a.y) / len) * (w.thickness / 2)
  const ny = ((w.b.x - w.a.x) / len) * (w.thickness / 2)
  return [
    { x: w.a.x + nx, y: w.a.y + ny },
    { x: w.b.x + nx, y: w.b.y + ny },
    { x: w.b.x - nx, y: w.b.y - ny },
    { x: w.a.x - nx, y: w.a.y - ny },
  ]
}

/** Where a point lies relative to a wall: `t` along it from `a`, `d` away from its centreline. */
export function projectOnWall(p: Vec2, w: Wall) {
  const length = dist(w.a, w.b)
  const ux = (w.b.x - w.a.x) / (length || 1)
  const uy = (w.b.y - w.a.y) / (length || 1)
  const t = (p.x - w.a.x) * ux + (p.y - w.a.y) * uy
  const d = Math.abs(-(p.x - w.a.x) * uy + (p.y - w.a.y) * ux)
  return { t, d, length }
}

/** A door or window known only by its centre, before it is attached to a wall. */
export interface LooseOpening {
  kind: OpeningKind
  center: Vec2
  width: number
  height: number
  sill: number
}

/** Attaches each door/window to the wall it sits in. Items not inside any wall are dropped. */
export function attachOpenings(walls: Wall[], items: LooseOpening[]): Opening[] {
  const result: Opening[] = []
  for (const item of items) {
    let best: { wall: Wall; t: number; d: number; length: number } | null = null
    for (const wall of walls) {
      const { t, d, length } = projectOnWall(item.center, wall)
      if (d > wall.thickness / 2 + 10 || t < -5 || t > length + 5) continue
      if (!best || d < best.d) best = { wall, t, d, length }
    }
    if (!best) continue
    const width = Math.min(item.width, best.length)
    const offset = Math.max(0, Math.min(best.length - width, best.t - width / 2))
    // The same opening found twice (e.g. from two pieces of one wall): keep it once.
    const wallId = best.wall.id
    if (result.some((o) => o.wallId === wallId && o.kind === item.kind && o.offset < offset + width && offset < o.offset + o.width)) continue
    result.push({
      id: newId(),
      wallId: best.wall.id,
      kind: item.kind,
      offset,
      width,
      height: item.height,
      sill: item.sill,
    })
  }
  return result
}

/** Turns typed lengths like "350", "350 cm", "3.5 m", "3500mm" or "12 ft" into centimetres. */
export function parseLength(text: string): number | null {
  const m = text.trim().replace(',', '.').match(/^(\d+(?:\.\d+)?|\.\d+)\s*(mm|cm|m|in|"|ft|')?$/i)
  if (!m) return null
  const value = parseFloat(m[1])
  const factor: Record<string, number> = { mm: 0.1, cm: 1, m: 100, in: 2.54, '"': 2.54, ft: 30.48, "'": 30.48 }
  const cm = value * factor[(m[2] ?? 'cm').toLowerCase()]
  return cm > 0 ? cm : null
}

export function formatLength(cm: number): string {
  return cm >= 100 ? `${(cm / 100).toFixed(2)} m` : `${cm.toFixed(1)} cm`
}
