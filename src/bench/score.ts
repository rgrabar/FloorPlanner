import { dist, projectOnWall } from '../model/geometry'
import { pointOnWall } from '../model/walls'
import type { Opening, Vec2, Wall } from '../model/types'

// Scores detected walls and openings against the known answer of a test plan.
// All lengths are in the importer's units; `scale` converts centimetres to them.

export interface Truth {
  file: string
  style: string
  rotation: number
  scale: number
  walls: { a: Vec2; b: Vec2; thickness: number }[]
  openings: { kind: 'door' | 'window'; center: Vec2; width: number }[]
  furniture?: TrueFurniture[]
}

export interface Score {
  wallRecall: number // share of the true wall length that was found
  wallPrecision: number // share of the detected wall length that is a real wall
  offsetCm: number // average distance between found and true centrelines
  thicknessCm: number // average thickness error
  openingRecall: number // true doors/windows found, of the right kind
  openingPrecision: number // detected doors/windows that are real
  kindErrors: number // found in the right place but door/window mixed up
  missedWalls: number // true walls less than half found
}

const STEP_CM = 5

function direction(w: { a: Vec2; b: Vec2 }) {
  const len = dist(w.a, w.b) || 1
  return { x: (w.b.x - w.a.x) / len, y: (w.b.y - w.a.y) / len }
}

/** Points every 5 cm along a wall's centreline, with its direction. */
function samples(w: { a: Vec2; b: Vec2 }, step: number) {
  const len = dist(w.a, w.b)
  const n = Math.max(1, Math.round(len / step))
  return Array.from({ length: n }, (_, i) => {
    const t = (i + 0.5) / n
    return { x: w.a.x + (w.b.x - w.a.x) * t, y: w.a.y + (w.b.y - w.a.y) * t }
  })
}

/** The nearest wall running parallel through a point, within a tolerance across it. */
function nearestParallel(p: Vec2, dir: Vec2, walls: { a: Vec2; b: Vec2; thickness: number }[], tolerance: (w: { thickness: number }) => number) {
  let best: { d: number; w: (typeof walls)[number] } | null = null
  for (const w of walls) {
    const wd = direction(w)
    if (Math.abs(wd.x * dir.x + wd.y * dir.y) < Math.cos((10 * Math.PI) / 180)) continue
    const { t, d, length } = projectOnWall(p, { ...w, id: '' })
    const tol = tolerance(w)
    if (t < -tol || t > length + tol || d > tol) continue
    if (!best || d < best.d) best = { d, w }
  }
  return best
}

export function scoreDetection(truth: Truth, walls: Wall[], openings: Opening[]): Score {
  const s = truth.scale
  const step = STEP_CM * s
  // Close enough: within a third of the true wall's thickness (and at least 4 cm).
  const tolTrue = (w: { thickness: number }) => Math.max(w.thickness * 0.35, 4 * s)

  let found = 0
  let total = 0
  let offsetSum = 0
  let thicknessSum = 0
  let missedWalls = 0
  for (const tw of truth.walls) {
    const dir = direction(tw)
    const pts = samples(tw, step)
    let hit = 0
    for (const p of pts) {
      // The detected wall must lie within the true wall's tolerance.
      const m = nearestParallel(p, dir, walls, () => tolTrue(tw))
      if (m) {
        hit++
        offsetSum += m.d
        thicknessSum += Math.abs(m.w.thickness - tw.thickness)
      }
    }
    found += hit
    total += pts.length
    if (hit < pts.length / 2) missedWalls++
  }

  let real = 0
  let detected = 0
  for (const dw of walls) {
    const dir = direction(dw)
    for (const p of samples(dw, step)) {
      detected++
      if (nearestParallel(p, dir, truth.walls, tolTrue)) real++
    }
  }

  // Openings: centre within half the opening's width (at least 25 cm).
  const byId = new Map(walls.map((w) => [w.id, w]))
  const centres = openings.flatMap((o) => {
    const w = byId.get(o.wallId)
    return w ? [{ kind: o.kind, c: pointOnWall(w, o.offset + o.width / 2), used: false }] : []
  })
  let openingHits = 0
  let kindErrors = 0
  for (const to of truth.openings) {
    const reach = Math.max(to.width / 2, 25 * s)
    const near = centres.filter((c) => !c.used && dist(c.c, to.center) <= reach).sort((a, b) => dist(a.c, to.center) - dist(b.c, to.center))
    const same = near.find((c) => c.kind === to.kind)
    if (same) {
      same.used = true
      openingHits++
    } else if (near.length) {
      near[0].used = true
      kindErrors++
    }
  }

  return {
    wallRecall: total ? found / total : 1,
    wallPrecision: detected ? real / detected : 0,
    offsetCm: found ? offsetSum / found / s : 0,
    thicknessCm: found ? thicknessSum / found / s : 0,
    openingRecall: truth.openings.length ? openingHits / truth.openings.length : 1,
    openingPrecision: centres.length ? centres.filter((c) => c.used).length / centres.length : truth.openings.length ? 0 : 1,
    kindErrors,
    missedWalls,
  }
}

// ---------- furniture ----------

export interface TrueFurniture {
  model: string
  center: Vec2
  rotation: number // degrees; the back faces (sin r, -cos r)
  width: number // cm
  depth: number
}

export interface FurnitureScore {
  total: number // true pieces
  found: number // a piece detected at the right place
  rightKind: number // ... and recognised as the right thing
  facing: number // ... and turned the right way
  detected: number // pieces detected
  real: number // detected pieces at a true piece's place
}

// Kinds that count as the same thing.
const SAME: Record<string, string> = {
  'generic-office-chair': 'generic-chair',
  'generic-kitchen-sink': 'generic-kitchen-base',
  'generic-stove': 'generic-kitchen-base',
}
const kindOf = (model: string) => SAME[model] ?? model
// Turned either way round, a table is the same table.
const SYMMETRIC = new Set(['generic-dining-table', 'generic-coffee-table'])

/** Detected pieces in the importer's units (centres; rotations unchanged), against the true ones. */
export function scoreFurniture(truth: TrueFurniture[], found: { model: string; x: number; y: number; rotation: number }[], scale: number): FurnitureScore {
  const used = new Set<number>()
  const score: FurnitureScore = { total: truth.length, found: 0, rightKind: 0, facing: 0, detected: found.length, real: 0 }
  for (const t of truth) {
    const reach = Math.max(40, 0.35 * Math.max(t.width, t.depth)) * scale
    const near = found
      .map((f, i) => ({ f, i, d: dist({ x: f.x, y: f.y }, t.center) }))
      .filter((c) => !used.has(c.i) && c.d <= reach)
      .sort((a, b) => Number(kindOf(b.f.model) === kindOf(t.model)) - Number(kindOf(a.f.model) === kindOf(t.model)) || a.d - b.d)
    const best = near[0]
    if (!best) continue
    used.add(best.i)
    score.found++
    if (kindOf(best.f.model) !== kindOf(t.model)) continue
    score.rightKind++
    const period = SYMMETRIC.has(t.model) ? 180 : 360
    const diff = Math.abs((((best.f.rotation - t.rotation) % period) + period * 1.5) % period - period / 2)
    if (diff <= 20) score.facing++
  }
  score.real = used.size
  return score
}
