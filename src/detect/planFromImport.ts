import type { ImportResult } from '../import/types'
import { dist, projectOnWall } from '../model/geometry'
import { emptyPlan, layersFromLines, scalePlan } from '../model/plan'
import type { Opening, Plan, Vec2, Wall } from '../model/types'
import { finishWalls, guessLayerRoles, keepBuilding, keepTypicalThickness, structureScore, wallsFromLines, type GapClassifier } from '../model/wallsFromLines'
import { inBox, insideBuilding, mergeInner, recogniseFurniture, shapesFromLines, type FurnitureOptions } from './furniture'
import { loadColours, patchesFromPicture, shapesFromInk } from './furniturePicture'
import { readLabels } from './labels'
import { findWallPieces, loadPicture, pictureGapClassifier, type Picture } from './raster'

// Inner walls are usually 10–15 cm thick. When a picture's scale is unknown, it's estimated from
// its thinner walls until the plan is calibrated.
const TYPICAL_INNER_WALL_CM = 12
// Inner doors are 70–90 cm wide; their median is a good ruler for pictures without a scale.
const TYPICAL_DOOR_CM = 82

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
  let inkPicture: Picture | null = null
  let pictureOutlined = false
  if (plan.background) {
    const pic = await loadPicture(plan.background.src)
    const pieces = findWallPieces(pic)
    inkPicture = pic
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
      let found = finishWalls(walls, pictureClassifier)
      if (pieces.outlined) found = keepTypicalThickness(found.walls, found.openings)
      pictureOutlined = pieces.outlined
      // Doors measure the scale better than walls do: walls are 10–25 cm thick, but nearly
      // every inner door is 70–90 cm wide.
      const doors = found.openings.filter((o) => o.kind === 'door').map((o) => o.width).sort((a, b) => a - b)
      if (scaleNote && doors.length >= 3) {
        const k = TYPICAL_DOOR_CM / doors[doors.length >> 1]
        if (Math.abs(k - 1) > 0.05) {
          plan = { ...scalePlan(plan, k), scaleKnown: false }
          const p = (v: Vec2) => ({ x: v.x * k, y: v.y * k })
          found = {
            walls: found.walls.map((w) => ({ ...w, a: p(w.a), b: p(w.b), thickness: w.thickness * k })),
            openings: found.openings.map((o) => ({ ...o, offset: o.offset * k, width: o.width * k })),
          }
          const bg2 = plan.background!
          const u = bg2.cmPerPx / pic.scale
          pictureClassifier = pictureGapClassifier(pic, (q) => ({ x: (q.x - bg2.x) / u, y: (q.y - bg2.y) / u }), 1 / u)
        }
        scaleNote = ' Scale estimated from the door widths: calibrate it for exact sizes.'
      }
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
  // Furniture outlines, letters and dimension ticks that looked like walls go.
  Object.assign(best, keepBuilding(best.walls, best.openings, best === fromPicture && pictureOutlined))

  // 3. Furniture: drawn on the layers that aren't walls, doors or windows, or as coloured
  // patches in the picture.
  const options = { walls: best.walls, openings: best.openings }
  const shapes = shapesFromLines(plan.lines, furnitureLayers(plan, options))
  if (plan.background) {
    const bg = plan.background
    const pic = await loadColours(bg.src)
    const unitsPerPicPx = bg.cmPerPx / pic.scale
    const patches = patchesFromPicture(pic, unitsPerPicPx, (p) => ({ x: bg.x + p.x * unitsPerPicPx, y: bg.y + p.y * unitsPerPicPx }))
    await readLabels(pic, patches)
    shapes.push(...patches.map((p) => p.shape))
    // Outlines drawn in the picture, when the file has no lines of its own (those are better).
    if (inkPicture && !plan.lines.length) {
      const u = bg.cmPerPx / inkPicture.scale
      shapes.push(...shapesFromInk(inkPicture.thin, inkPicture.w, inkPicture.h, u, (p) => ({ x: bg.x + p.x * u, y: bg.y + p.y * u }), best.walls))
    }
  }
  // The file's own words name the shapes they're written in (better than reading the picture).
  const merged = mergeInner(shapes)
  if (r.texts?.length) {
    const k = plan.background && r.background ? plan.background.cmPerPx / r.background.cmPerPx : 1
    const texts = r.texts.map((t) => ({ text: t.text, at: { x: t.at.x * k, y: t.at.y * k } }))
    for (const s of merged) {
      const inside = texts.filter((t) => inBox(t.at, s.box, 2)).sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x)
      if (inside.length) s.label = inside.map((t) => t.text).join(' ')
    }
  }
  const furniture = recogniseFurniture(merged, options)

  const note =
    `Found ${best.walls.length} walls and ${best.openings.length} doors/windows ${best.how}` +
    (furniture.length ? `, and ${furniture.length} pieces of furniture` : '') +
    `. Check them, then Accept all.${scaleNote}`
  return {
    ...plan,
    suggestedWalls: best.walls,
    suggestedOpenings: best.openings,
    suggestedFurniture: furniture,
    source: plan.source && { ...plan.source, note: `${plan.source.note ?? ''} ${note}`.trim() },
  }
}

/**
 * The layers furniture is drawn on. Text, dimensions and hatching are on layers too, and their
 * marks can look like small furniture; on a furniture layer, though, a good share of the shapes
 * inside the building are recognised as something.
 */
function furnitureLayers(plan: Plan, options: FurnitureOptions): Set<string> {
  // Not the layers the walls are drawn with: most of their lines lie on the walls found. (The
  // guessed layer roles can't be trusted for this: furniture outlines can look like wall outlines.)
  const candidates = plan.layers.filter((l) => l.role !== 'hidden' && onWallsShare(plan, l.name, options.walls) < 0.5)
  const kept = new Set<string>()
  for (const l of candidates) {
    const shapes = shapesFromLines(plan.lines, new Set([l.name])).filter((s) => insideBuilding(s.box.center, options.walls))
    if (shapes.length < 2) continue
    const found = recogniseFurniture(shapes, options).length
    if (found >= 2 && found >= shapes.length * 0.25) kept.add(l.name)
  }
  return kept
}

/** The share of a layer's line length that lies along the walls (within half a wall's thickness and 2 cm). */
function onWallsShare(plan: Plan, layer: string, walls: Wall[]): number {
  let on = 0
  let total = 0
  for (const l of plan.lines) {
    if (l.layer !== layer) continue
    const len = dist(l.a, l.b)
    total += len
    const mid = { x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 }
    const near = walls.some((w) => {
      const { t, d, length } = projectOnWall(mid, w)
      return t > -w.thickness && t < length + w.thickness && d <= w.thickness / 2 + 2
    })
    if (near) on += len
  }
  return total ? on / total : 0
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
