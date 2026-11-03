import { strFromU8, unzipSync } from 'fflate'
import { attachOpenings, newId, type LooseOpening } from '../model/geometry'
import type { Room, Wall } from '../model/types'
import { emptyResult, ImportError, makeParts, type ImportResult } from './types'

// Sweet Home 3D files are zip archives. Since version 5.3 they contain Home.xml,
// with all sizes in centimetres and y pointing down, just like this app.

export async function importSh3d(file: File, levelIndex: number): Promise<ImportResult> {
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (f) => f.name === 'Home.xml' })
  const xml = files['Home.xml']
  if (!xml) {
    throw new ImportError(
      `"${file.name}" was saved by an old Sweet Home 3D version. Open it in Sweet Home 3D 5.3 or newer, save it again, and try once more.`,
    )
  }
  const doc = new DOMParser().parseFromString(strFromU8(xml), 'application/xml')
  if (doc.querySelector('parsererror')) throw new ImportError(`"${file.name}" contains a damaged Home.xml.`)
  const home = doc.documentElement
  const num = (el: Element, attr: string, fallback = 0) => {
    const v = parseFloat(el.getAttribute(attr) ?? '')
    return Number.isFinite(v) ? v : fallback
  }

  const levels = [...home.getElementsByTagName('level')]
    .map((el) => ({ id: el.getAttribute('id'), name: el.getAttribute('name') ?? 'Level', elevation: num(el, 'elevation') }))
    .sort((a, b) => a.elevation - b.elevation)
  const parts = makeParts('Level', levels.map((l) => l.name), levelIndex)
  const levelId = levels[parts?.index ?? 0]?.id ?? null
  const onLevel = (el: Element) => levels.length < 2 || el.getAttribute('level') === levelId

  const defaultHeight = num(home, 'wallHeight', 250)
  const walls: Wall[] = []
  for (const el of home.getElementsByTagName('wall')) {
    if (!onLevel(el)) continue
    walls.push({
      id: newId(),
      a: { x: num(el, 'xStart'), y: num(el, 'yStart') },
      b: { x: num(el, 'xEnd'), y: num(el, 'yEnd') },
      thickness: num(el, 'thickness', 10),
      height: num(el, 'height', defaultHeight),
    })
  }

  const loose: LooseOpening[] = []
  for (const el of home.getElementsByTagName('doorOrWindow')) {
    if (!onLevel(el)) continue
    const label = `${el.getAttribute('name') ?? ''} ${el.getAttribute('catalogId') ?? ''}`.toLowerCase()
    const sill = num(el, 'elevation')
    const kind = /window|raam|fenster/.test(label) ? 'window' : /door|deur|tür/.test(label) ? 'door' : sill > 30 ? 'window' : 'door'
    loose.push({ kind, center: { x: num(el, 'x'), y: num(el, 'y') }, width: num(el, 'width'), height: num(el, 'height'), sill })
  }

  const rooms: Room[] = []
  for (const el of home.getElementsByTagName('room')) {
    if (!onLevel(el)) continue
    const points = [...el.getElementsByTagName('point')].map((p) => ({ x: num(p, 'x'), y: num(p, 'y') }))
    if (points.length >= 3) rooms.push({ name: el.getAttribute('name') ?? undefined, points })
  }

  if (!walls.length && !rooms.length) throw new ImportError(`"${file.name}" has no walls or rooms on this level.`)
  const suggestedOpenings = attachOpenings(walls, loose)
  return {
    ...emptyResult('sh3d'),
    scaleKnown: true,
    suggestedWalls: walls,
    suggestedOpenings,
    rooms,
    parts,
    note: `Found ${walls.length} walls, ${suggestedOpenings.length} doors/windows and ${rooms.length} rooms.`,
  }
}
