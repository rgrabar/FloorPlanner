import { boundsOf, wallCorners, type Bounds } from './geometry'
import type { Layer, LayerRole, Opening, Plan, Segment, Vec2, Wall } from './types'

export function emptyPlan(): Plan {
  return {
    version: 1,
    source: null,
    scaleKnown: false,
    roomHeight: 250,
    background: null,
    lines: [],
    layers: [],
    walls: [],
    openings: [],
    suggestedWalls: [],
    suggestedOpenings: [],
    rooms: [],
  }
}

/** Guesses what a layer contains from its name (English, Dutch, German, French, Croatian). */
function guessRole(name: string): LayerRole {
  const n = name.toLowerCase()
  if (/wall|wand|muur|mur|mauer|zid/.test(n)) return 'wall'
  if (/door|deur|tür|tuer|porte|vrata/.test(n)) return 'door'
  if (/window|raam|fenster|fen[eê]tre|glaz|prozor/.test(n)) return 'window'
  if (/text|dim|bema|kota|hatch|furn|meubel|möbel|namje/.test(n)) return 'hidden'
  return 'other'
}

export function layersFromLines(lines: Segment[]): Layer[] {
  const counts = new Map<string, number>()
  for (const l of lines) counts.set(l.layer, (counts.get(l.layer) ?? 0) + 1)
  return [...counts]
    .map(([name, count]) => ({ name, count, role: guessRole(name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function* planPoints(plan: Plan): Generator<Vec2> {
  const bg = plan.background
  if (bg) {
    yield { x: bg.x, y: bg.y }
    yield { x: bg.x + bg.widthPx * bg.cmPerPx, y: bg.y + bg.heightPx * bg.cmPerPx }
  }
  const visible = new Set(plan.layers.filter((l) => l.role !== 'hidden').map((l) => l.name))
  for (const l of plan.lines) {
    if (!visible.has(l.layer)) continue
    yield l.a
    yield l.b
  }
  for (const w of [...plan.walls, ...plan.suggestedWalls]) yield* wallCorners(w)
  for (const r of plan.rooms) yield* r.points
}

export function planBounds(plan: Plan): Bounds | null {
  return boundsOf(planPoints(plan))
}

/**
 * Applies a scale calibration: the drawing was off by `k`, so everything that comes from the
 * drawing is multiplied by `k` around the origin. Thicknesses and opening sizes typed in by me
 * are real measurements and stay as they are.
 */
export function scalePlan(plan: Plan, k: number): Plan {
  const p = (v: Vec2): Vec2 => ({ x: v.x * k, y: v.y * k })
  const fileWall = (w: Wall): Wall => ({ ...w, a: p(w.a), b: p(w.b), thickness: w.thickness * k })
  const fileOpening = (o: Opening): Opening => ({ ...o, offset: o.offset * k, width: o.width * k })
  const myWallIds = new Set(plan.walls.map((w) => w.id))
  return {
    ...plan,
    scaleKnown: true,
    background: plan.background && {
      ...plan.background,
      x: plan.background.x * k,
      y: plan.background.y * k,
      cmPerPx: plan.background.cmPerPx * k,
    },
    lines: plan.lines.map((l) => ({ ...l, a: p(l.a), b: p(l.b) })),
    walls: plan.walls.map((w) => ({ ...w, a: p(w.a), b: p(w.b) })),
    openings: plan.openings.map((o) => (myWallIds.has(o.wallId) ? { ...o, offset: o.offset * k } : o)),
    suggestedWalls: plan.suggestedWalls.map(fileWall),
    suggestedOpenings: plan.suggestedOpenings.map(fileOpening),
    rooms: plan.rooms.map((r) => ({ ...r, points: r.points.map(p) })),
  }
}

/** Moves the geometry so its top-left corner is at (0, 0). Used by vector importers. */
export function moveToOrigin<T extends { lines: Segment[]; suggestedWalls: Wall[]; rooms: { points: Vec2[] }[] }>(r: T): T {
  const pts: Vec2[] = []
  for (const l of r.lines) pts.push(l.a, l.b)
  for (const w of r.suggestedWalls) pts.push(...wallCorners(w))
  for (const room of r.rooms) pts.push(...room.points)
  const b = boundsOf(pts)
  if (!b) return r
  const p = (v: Vec2): Vec2 => ({ x: v.x - b.minX, y: v.y - b.minY })
  return {
    ...r,
    lines: r.lines.map((l) => ({ ...l, a: p(l.a), b: p(l.b) })),
    suggestedWalls: r.suggestedWalls.map((w) => ({ ...w, a: p(w.a), b: p(w.b) })),
    rooms: r.rooms.map((room) => ({ ...room, points: room.points.map(p) })),
  }
}
