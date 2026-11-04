import type { ImportResult } from '../import/types'
import { dist } from '../model/geometry'
import { emptyPlan, layersFromLines, scalePlan } from '../model/plan'
import type { Opening, Plan, Wall } from '../model/types'
import { finishWalls, guessLayerRoles, structureScore, wallsFromLines, type GapClassifier } from '../model/wallsFromLines'
import { findWallPieces, loadPicture, pictureGapClassifier } from './raster'

// Inner walls are usually 10–15 cm thick. When a picture's scale is unknown, it's estimated from
// its thinner walls until the plan is calibrated.
const TYPICAL_INNER_WALL_CM = 12

interface Found {
  walls: Wall[]
  openings: Opening[]
  how: string
}

/**
 * Turns an imported file into a plan, with walls found automatically where possible.
 * `use` forces one detector (for testing); normally the better result is picked.
 */
export async function planFromImport(r: ImportResult, fileName: string, use?: 'picture' | 'lines'): Promise<Plan> {
  let plan: Plan = {
    ...emptyPlan(),
    source: { fileName, format: r.format, parts: r.parts, note: r.note },
    scaleKnown: r.scaleKnown,
    background: r.background,
    lines: r.lines,
    layers: layersFromLines(r.lines),
    suggestedWalls: r.suggestedWalls,
    suggestedOpenings: r.suggestedOpenings,
    rooms: r.rooms,
  }
  // IFC and Sweet Home 3D files bring their own walls.
  if (plan.suggestedWalls.length) return plan

  // 1. From the picture: walls drawn as thick dark bands (filled walls, scans, exports).
  let fromPicture: Found | null = null
  let scaleNote = ''
  let pictureClassifier: GapClassifier | undefined
  if (plan.background) {
    const pic = await loadPicture(plan.background.src)
    const pieces = findWallPieces(pic)
    {
      // Doors and windows are judged from the picture, also for walls found from lines.
      const bg = plan.background
      const unitsPerPicPx = bg.cmPerPx / pic.scale
      const toPx = (p: { x: number; y: number }) => ({ x: (p.x - bg.x) / unitsPerPicPx, y: (p.y - bg.y) / unitsPerPicPx })
      pictureClassifier = pictureGapClassifier(pic, toPx, 1 / unitsPerPicPx)
    }
    // Outlined walls are found far more precisely from a file's own lines, when it has them.
    if (pieces.walls.length >= 3 && !(pieces.outlined && plan.lines.length)) {
      // Picture pixels -> source pixels -> plan units.
      const thinWallPx = percentileByLength(pieces.walls, 0.3) / pic.scale
      const thinWallCm = thinWallPx * plan.background.cmPerPx
      const isPicture = ['image', 'heic', 'tiff', 'photo'].includes(r.format)
      // PDFs are assumed to be 1:100; keep that only when the walls come out plausible.
      if (!plan.scaleKnown && (isPicture || thinWallCm < 7 || thinWallCm > 20)) {
        // Unknown or implausible scale: estimate it from the walls, so sizes are about right.
        const k = TYPICAL_INNER_WALL_CM / thinWallPx / plan.background.cmPerPx
        plan = { ...scalePlan(plan, k), scaleKnown: false }
        scaleNote = ' Scale estimated from the wall thickness: calibrate it for exact sizes.'
      }
      const bg = plan.background!
      const unitsPerPicPx = bg.cmPerPx / pic.scale
      const toPlan = (p: { x: number; y: number }) => ({ x: bg.x + p.x * unitsPerPicPx, y: bg.y + p.y * unitsPerPicPx })
      const toPx = (p: { x: number; y: number }) => ({ x: (p.x - bg.x) / unitsPerPicPx, y: (p.y - bg.y) / unitsPerPicPx })
      const walls = pieces.walls.map((w) => ({ ...w, a: toPlan(w.a), b: toPlan(w.b), thickness: w.thickness * unitsPerPicPx }))
      pictureClassifier = pictureGapClassifier(pic, toPx, 1 / unitsPerPicPx)
      const found = finishWalls(walls, pictureClassifier)
      fromPicture = { ...found, how: 'from the picture (thick dark walls)' }
    }
  }

  // 2. From the drawing's lines: walls drawn as pairs of outlines (CAD-style PDFs, DXF, SVG).
  let fromLines: Found | null = null
  if (plan.lines.length) {
    let layers = plan.layers
    if (!layers.some((l) => l.role === 'wall')) layers = guessLayerRoles(plan.lines, layers)
    if (layers.some((l) => l.role === 'wall')) {
      const found = wallsFromLines(plan.lines, new Map(layers.map((l) => [l.name, l.role])), undefined, pictureClassifier)
      const names = layers.filter((l) => l.role === 'wall').map((l) => `"${l.name}"`).join(', ')
      fromLines = { ...found, how: `from the drawing's lines (walls on ${names})` }
      plan = { ...plan, layers }
    }
  }

  // The picture is preferred whenever it finds a real building: it sees exactly what's drawn,
  // while line pairs also come from window frames, stairs and dimension arrows.
  const pictureScore = fromPicture ? structureScore(fromPicture.walls) : 0
  const linesScore = fromLines ? structureScore(fromLines.walls) : 0
  const best =
    use === 'picture' ? fromPicture
    : use === 'lines' ? fromLines
    : fromPicture && fromPicture.walls.length >= 4 && pictureScore >= 0.3 * linesScore ? fromPicture
    : fromLines
  if (!best || !best.walls.length) return plan

  const note = `Found ${best.walls.length} walls and ${best.openings.length} doors/windows ${best.how}. Check them, then Accept all.${scaleNote}`
  return {
    ...plan,
    suggestedWalls: best.walls,
    suggestedOpenings: best.openings,
    source: plan.source && { ...plan.source, note: `${plan.source.note ?? ''} ${note}`.trim() },
  }
}

/** The thickness below which `share` of the total wall length lies. */
function percentileByLength(walls: Wall[], share: number): number {
  const sorted = [...walls].sort((a, b) => a.thickness - b.thickness)
  const total = sorted.reduce((t, w) => t + dist(w.a, w.b), 0)
  let acc = 0
  for (const w of sorted) {
    acc += dist(w.a, w.b)
    if (acc >= total * share) return w.thickness
  }
  return sorted[sorted.length - 1]?.thickness ?? 1
}

/** Finds walls in the plan's lines, using the layer roles as set. */
export function withFoundWalls(plan: Plan): Plan {
  const found = wallsFromLines(plan.lines, new Map(plan.layers.map((l) => [l.name, l.role])))
  return { ...plan, suggestedWalls: found.walls, suggestedOpenings: found.openings }
}
