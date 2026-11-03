import DxfParser from 'dxf-parser'
import { applyAffine, boundsOf, composeAffine, IDENTITY, type Affine } from '../model/geometry'
import { moveToOrigin } from '../model/plan'
import type { Segment, Vec2 } from '../model/types'
import { emptyResult, ImportError, type ImportResult } from './types'

const MAX_LINES = 200_000

// $INSUNITS codes -> centimetres per drawing unit.
const UNITS: Record<number, [number, string]> = {
  1: [2.54, 'inches'],
  2: [30.48, 'feet'],
  4: [0.1, 'millimetres'],
  5: [1, 'centimetres'],
  6: [100, 'metres'],
}

// Only the fields used here; dxf-parser's own types are looser than its output.
interface Entity {
  type: string
  layer?: string
  vertices?: Vec2[]
  shape?: boolean
  name?: string
  position?: Vec2
  xScale?: number
  yScale?: number
  rotation?: number
}

interface Block {
  position?: Vec2
  entities?: Entity[]
}

export async function importDxf(file: File): Promise<ImportResult> {
  const text = await file.text()
  if (text.startsWith('AutoCAD Binary DXF')) {
    throw new ImportError('This is a binary DXF. Save it as an ASCII DXF in your CAD program and try again.')
  }
  const dxf = new DxfParser().parse(text)
  if (!dxf) throw new ImportError(`"${file.name}" isn't a valid DXF file.`)

  const blocks = dxf.blocks as unknown as Record<string, Block>
  const raw: Segment[] = []

  const walk = (entities: Entity[], m: Affine, parentLayer: string | null, depth: number) => {
    for (const e of entities) {
      if (raw.length >= MAX_LINES) return
      // Entities on layer 0 inside a block take the layer of the block reference.
      const layer = e.layer === '0' && parentLayer ? parentLayer : (e.layer ?? '0')
      const push = (a: Vec2, b: Vec2) => raw.push({ a: applyAffine(m, a.x, a.y), b: applyAffine(m, b.x, b.y), layer })

      if ((e.type === 'LINE' || e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') && e.vertices) {
        const v = e.vertices
        for (let i = 1; i < v.length; i++) push(v[i - 1], v[i])
        if (e.shape && v.length > 2) push(v[v.length - 1], v[0])
      } else if (e.type === 'INSERT' && e.name && depth < 8) {
        const block = blocks[e.name]
        if (!block?.entities) continue
        const r = ((e.rotation ?? 0) * Math.PI) / 180
        const sx = e.xScale ?? 1
        const sy = e.yScale ?? 1
        const pos = e.position ?? { x: 0, y: 0 }
        const base = block.position ?? { x: 0, y: 0 }
        // Move block base point to origin, scale, rotate, move to the insert position.
        let t: Affine = [1, 0, 0, 1, -base.x, -base.y]
        t = composeAffine([sx, 0, 0, sy, 0, 0], t)
        t = composeAffine([Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), pos.x, pos.y], t)
        walk(block.entities, composeAffine(m, t), layer, depth + 1)
      }
      // Arcs and circles are mostly door swings and fixtures, so they are left out.
    }
  }
  walk(dxf.entities as unknown as Entity[], IDENTITY, null, 0)

  if (!raw.length) throw new ImportError(`"${file.name}" has no lines or polylines in it.`)

  const code = Number(dxf.header?.$INSUNITS ?? 0)
  let [cmPerUnit, unitName] = UNITS[code] ?? [0, '']
  let note: string
  if (cmPerUnit) {
    note = `Units from file: ${unitName}.`
  } else {
    // No units in the file: guess from the drawing size (a home is roughly 5–30 m across).
    const b = boundsOf(raw.flatMap((l) => [l.a, l.b]))!
    const size = Math.max(b.maxX - b.minX, b.maxY - b.minY)
    ;[cmPerUnit, unitName] = size > 3000 ? UNITS[4] : size < 100 ? UNITS[6] : UNITS[5]
    note = `The file doesn't say its units; guessed ${unitName}. Calibrate if the size looks wrong.`
  }

  // DXF y points up; the plan's y points down.
  const lines = raw.map((l) => ({
    layer: l.layer,
    a: { x: l.a.x * cmPerUnit, y: -l.a.y * cmPerUnit },
    b: { x: l.b.x * cmPerUnit, y: -l.b.y * cmPerUnit },
  }))
  return moveToOrigin({ ...emptyResult('dxf'), scaleKnown: !!UNITS[code], lines, note })
}
