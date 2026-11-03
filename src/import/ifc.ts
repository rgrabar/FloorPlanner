import { IFCDOOR, IFCWALL, IFCWALLSTANDARDCASE, IFCWINDOW, IfcAPI } from 'web-ifc'
import wasmUrl from 'web-ifc/web-ifc.wasm?url'
import { attachOpenings, minAreaRect, wallFromRect, type LooseOpening } from '../model/geometry'
import { moveToOrigin } from '../model/plan'
import type { Vec2, Wall } from '../model/types'
import { emptyResult, ImportError, makeParts, type ImportResult } from './types'

type Kind = 'wall' | 'door' | 'window'

/** One building element: its outline seen from above and its vertical extent, in cm. */
interface Element3D {
  kind: Kind
  footprint: Vec2[]
  bottom: number
  top: number
}

let api: IfcAPI | null = null

async function getApi(): Promise<IfcAPI> {
  if (!api) {
    const fresh = new IfcAPI()
    await fresh.Init(() => wasmUrl, true)
    api = fresh
  }
  return api
}

export async function importIfc(file: File, levelIndex: number): Promise<ImportResult> {
  const ifc = await getApi()
  // Keep real coordinates so level heights stay correct; moveToOrigin() handles the x/y offset.
  const modelID = ifc.OpenModel(new Uint8Array(await file.arrayBuffer()), { COORDINATE_TO_ORIGIN: false })
  if (modelID < 0) throw new ImportError(`"${file.name}" isn't a valid IFC file.`)

  const elements: Element3D[] = []
  try {
    const types: [number, Kind][] = [
      [IFCWALL, 'wall'],
      [IFCWALLSTANDARDCASE, 'wall'],
      [IFCDOOR, 'door'],
      [IFCWINDOW, 'window'],
    ]
    for (const [type, kind] of types) {
      ifc.StreamAllMeshesWithTypes(
        modelID,
        [type],
        (mesh) => {
          const el: Element3D = { kind, footprint: [], bottom: Infinity, top: -Infinity }
          for (let g = 0; g < mesh.geometries.size(); g++) {
            const placed = mesh.geometries.get(g)
            const geom = ifc.GetGeometry(modelID, placed.geometryExpressID)
            const verts = ifc.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize())
            const m = placed.flatTransformation // 4x4, column-major, metres, y up
            for (let i = 0; i < verts.length; i += 6) {
              const [x, y, z] = [verts[i], verts[i + 1], verts[i + 2]]
              const wx = m[0] * x + m[4] * y + m[8] * z + m[12]
              const wy = m[1] * x + m[5] * y + m[9] * z + m[13]
              const wz = m[2] * x + m[6] * y + m[10] * z + m[14]
              // Seen from above: x stays x, and the model's z (towards the viewer) is the plan's y.
              el.footprint.push({ x: wx * 100, y: wz * 100 })
              el.bottom = Math.min(el.bottom, wy * 100)
              el.top = Math.max(el.top, wy * 100)
            }
            geom.delete()
          }
          if (el.footprint.length >= 3) elements.push(el)
        },
        true, // convert the file's length unit (often mm) to metres
      )
    }
  } finally {
    ifc.CloseModel(modelID)
  }

  const walls = elements.filter((e) => e.kind === 'wall')
  if (!walls.length) throw new ImportError(`"${file.name}" has no walls in it.`)

  // Group walls into levels by the height of their base.
  const bases: number[] = []
  for (const b of walls.map((w) => w.bottom).sort((a, b) => a - b)) {
    if (!bases.length || b - bases[bases.length - 1] > 50) bases.push(b)
  }
  const names = bases.map((b) => {
    const count = walls.filter((w) => levelOf(w.bottom, bases) === bases.indexOf(b)).length
    return `Level ${(b / 100).toFixed(2)} m (${count} walls)`
  })
  const parts = makeParts('Level', names, levelIndex)
  const level = parts?.index ?? 0
  const base = bases[level]

  const suggestedWalls: Wall[] = []
  for (const w of walls) {
    if (levelOf(w.bottom, bases) !== level) continue
    const rect = minAreaRect(w.footprint)
    if (rect && rect.length > 1) suggestedWalls.push(wallFromRect(rect, w.top - w.bottom))
  }

  const loose: LooseOpening[] = []
  for (const e of elements) {
    if (e.kind === 'wall' || levelOf(e.bottom, bases) !== level) continue
    const rect = minAreaRect(e.footprint)
    if (!rect) continue
    loose.push({ kind: e.kind, center: rect.center, width: rect.length, height: e.top - e.bottom, sill: Math.max(0, e.bottom - base) })
  }

  // Openings are stored along their wall, so moving everything afterwards doesn't affect them.
  const suggestedOpenings = attachOpenings(suggestedWalls, loose)
  return moveToOrigin({
    ...emptyResult('ifc'),
    scaleKnown: true,
    suggestedWalls,
    suggestedOpenings,
    parts,
    note: `Found ${suggestedWalls.length} walls and ${suggestedOpenings.length} doors/windows. Units from file.`,
  })
}

/** Which level a height belongs to: the highest level base at or below it (with some tolerance). */
function levelOf(bottom: number, bases: number[]): number {
  let level = 0
  bases.forEach((b, i) => {
    if (bottom >= b - 50) level = i
  })
  return level
}
