import { MODELS } from '../furniture/model'
import { modelOf } from '../furniture/placement'
import { dist, minAreaRect, newId, projectOnWall, type Rect } from '../model/geometry'
import type { Opening, PlacedFurniture, Segment, Vec2, Wall } from '../model/types'

// Finds furniture drawn on a floorplan and suggests a model for each piece.
//
// Every drawn object (a group of touching lines, or a coloured patch in a picture) becomes a
// `Shape`: its ink as points in plan cm, and the rectangle around it. What it is comes from its
// label when it has one ("Sofa", "MALM", "WC"), otherwise from its real size and what's drawn
// inside: a wardrobe's X, a sofa's back and arms, a bed's pillow, a basin's round bowl.
// Each piece is turned so its back is against the nearest wall.

export interface Shape {
  points: Vec2[] // ink, sampled about every cm
  box: Rect // `axis` along the long side
  label?: string
  filled?: boolean // a solid patch (coloured furniture in an exported plan), not outlines
}

/** What a shape was recognised as. */
interface Guess {
  model: string
  // Which of the box's sides is the back: 'long' = one of the long sides, 'short' = one of the
  // short sides. `prefer` picks between the two from the drawing (+1 = the side towards +n or +axis).
  back: 'long' | 'short'
  prefer?: 1 | -1
  backDir?: Vec2 // known from the drawing (a desk's back is away from its chair): wins over walls
  label?: string
}

// ---------- shapes from lines ----------

/**
 * Groups touching lines into shapes. Only lines on `layers` are used (furniture is usually
 * drawn on its own layer or in its own colour, but any layer that isn't walls or openings will do).
 */
export function shapesFromLines(lines: Segment[], layers: Set<string>, tolerance = 1.5): Shape[] {
  const segs = lines.filter((l) => layers.has(l.layer) && dist(l.a, l.b) > 0.01)
  const parent = segs.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))

  // A coarse grid so only nearby lines are compared.
  const CELL = 20
  const grid = new Map<string, number[]>()
  segs.forEach((s, i) => {
    const x0 = Math.floor((Math.min(s.a.x, s.b.x) - tolerance) / CELL)
    const x1 = Math.floor((Math.max(s.a.x, s.b.x) + tolerance) / CELL)
    const y0 = Math.floor((Math.min(s.a.y, s.b.y) - tolerance) / CELL)
    const y1 = Math.floor((Math.max(s.a.y, s.b.y) + tolerance) / CELL)
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) return // a very long line: not furniture
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${x},${y}`
        const list = grid.get(key)
        for (const j of list ?? []) if (find(i) !== find(j) && segmentDistance(s, segs[j]) <= tolerance) parent[find(i)] = find(j)
        if (list) list.push(i)
        else grid.set(key, [i])
      }
    }
  })

  const groups = new Map<number, Segment[]>()
  segs.forEach((s, i) => {
    const r = find(i)
    const g = groups.get(r)
    if (g) g.push(s)
    else groups.set(r, [s])
  })

  const shapes: Shape[] = []
  for (const g of groups.values()) {
    const points: Vec2[] = []
    for (const s of g) {
      const n = Math.max(1, Math.ceil(dist(s.a, s.b)))
      for (let k = 0; k <= n; k++) points.push({ x: s.a.x + ((s.b.x - s.a.x) * k) / n, y: s.a.y + ((s.b.y - s.a.y) * k) / n })
    }
    const box = boxOf(points, mainDirection(g))
    if (box && box.length <= 450) shapes.push({ points, box })
  }
  return mergeInner(shapes).filter((s) => s.box.length >= 25)
}

/**
 * The direction most of the straight lines run in (modulo 90°), or null when there's no clear
 * one (round things). Boxes follow it, so a table with round chairs isn't measured askew.
 */
function mainDirection(segs: { a: Vec2; b: Vec2 }[]): Vec2 | null {
  const bins = new Float64Array(90)
  let total = 0
  for (const s of segs) {
    const len = dist(s.a, s.b)
    const deg = ((((Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x) * 180) / Math.PI) % 90) + 90) % 90
    bins[Math.round(deg) % 90] += len
    total += len
  }
  let best = 0
  let bestSum = 0
  for (let i = 0; i < 90; i++) {
    const sum = bins[(i + 89) % 90] + bins[i] + bins[(i + 1) % 90]
    if (sum > bestSum) {
      bestSum = sum
      best = i
    }
  }
  if (bestSum < total * 0.4) return null
  const r = (best * Math.PI) / 180
  return { x: Math.cos(r), y: Math.sin(r) }
}

/** The rectangle around the points along `dir` (and across it), or the smallest one when there's no direction. */
export function boxOf(points: Vec2[], dir: Vec2 | null): Rect | null {
  if (!dir) return minAreaRect(points)
  if (!points.length) return null
  const n = { x: -dir.y, y: dir.x }
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
  for (const p of points) {
    const u = p.x * dir.x + p.y * dir.y
    const v = p.x * n.x + p.y * n.y
    minU = Math.min(minU, u); maxU = Math.max(maxU, u)
    minV = Math.min(minV, v); maxV = Math.max(maxV, v)
  }
  const cu = (minU + maxU) / 2
  const cv = (minV + maxV) / 2
  const center = { x: dir.x * cu + n.x * cv, y: dir.y * cu + n.y * cv }
  return maxU - minU >= maxV - minV
    ? { center, axis: dir, length: maxU - minU, width: maxV - minV }
    : { center, axis: n, length: maxV - minV, width: maxU - minU }
}

/** Is p inside the box (with a margin in cm)? */
export function inBox(p: Vec2, box: Rect, margin = 0): boolean {
  const dx = p.x - box.center.x
  const dy = p.y - box.center.y
  const u = dx * box.axis.x + dy * box.axis.y
  const v = -dx * box.axis.y + dy * box.axis.x
  return Math.abs(u) <= box.length / 2 + margin && Math.abs(v) <= box.width / 2 + margin
}

/**
 * Details drawn inside a piece without touching it (a bed's pillow, a sink in a counter, a
 * cushion, a label) belong to it: shapes lying inside a bigger one are merged into it.
 */
export function mergeInner(shapes: Shape[]): Shape[] {
  const sorted = [...shapes].sort((a, b) => b.box.length * b.box.width - a.box.length * a.box.width)
  const kept: Shape[] = []
  for (const s of sorted) {
    const host = kept.find(
      (k) =>
        k.box.length * k.box.width > s.box.length * s.box.width &&
        inBox(s.box.center, k.box) &&
        s.points.filter((p) => inBox(p, k.box, 2)).length >= s.points.length * 0.9,
    )
    if (host) host.points.push(...s.points)
    else kept.push({ ...s, points: [...s.points] })
  }
  return kept
}

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy || 1
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t)
}

function segmentDistance(s: { a: Vec2; b: Vec2 }, q: { a: Vec2; b: Vec2 }): number {
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  if (cross(s.a, s.b, q.a) * cross(s.a, s.b, q.b) < 0 && cross(q.a, q.b, s.a) * cross(q.a, q.b, s.b) < 0) return 0
  return Math.min(
    pointSegmentDistance(s.a, q.a, q.b),
    pointSegmentDistance(s.b, q.a, q.b),
    pointSegmentDistance(q.a, s.a, s.b),
    pointSegmentDistance(q.b, s.a, s.b),
  )
}

// ---------- what's drawn inside a shape ----------

const CELL_CM = 2

/** The shape's ink on a grid in its own box: u along the long side, v across. */
export interface Features {
  L: number // cm, long side
  W: number // cm, short side
  cross: boolean // both diagonals drawn (wardrobes, cupboards, showers)
  // Lines inside the outline, as distances in cm from the side they're nearest to.
  // `side` is -1 for the side at -v (or -u) and +1 for the other.
  along: { offset: number; side: -1 | 1; cover: number }[] // parallel to the long side
  across: { offset: number; side: -1 | 1; cover: number }[] // parallel to the short side
  edgeAlong: [number, number] // how much of each long side (at -v, +v) is drawn
  edgeAcross: [number, number] // and of each short side
  free: number // share of the inside ink that isn't straight lines along the box (curves, text, angled lines)
  inked: number // share of the inside that is ink (high for filled shapes)
}

export function featuresOf(s: Shape): Features {
  const { box } = s
  const nu = Math.max(3, Math.round(box.length / CELL_CM))
  const nv = Math.max(3, Math.round(box.width / CELL_CM))
  const ink = new Uint8Array(nu * nv)
  const n = { x: -box.axis.y, y: box.axis.x }
  for (const p of s.points) {
    const dx = p.x - box.center.x
    const dy = p.y - box.center.y
    const u = Math.floor(((dx * box.axis.x + dy * box.axis.y) / box.length + 0.5) * nu)
    const v = Math.floor(((dx * n.x + dy * n.y) / box.width + 0.5) * nv)
    ink[Math.min(nu - 1, Math.max(0, u)) * nv + Math.min(nv - 1, Math.max(0, v))] = 1
  }
  const at = (u: number, v: number) => u >= 0 && v >= 0 && u < nu && v < nv && ink[u * nv + v] === 1
  const near = (u: number, v: number) => at(u, v) || at(u, v - 1) || at(u, v + 1) || at(u - 1, v) || at(u + 1, v)

  // How much of a line along the long side (at row v) is drawn, over the middle 90 %.
  const coverAlong = (v: number) => {
    let hit = 0
    let all = 0
    for (let u = Math.floor(nu * 0.05); u < Math.ceil(nu * 0.95); u++, all++) if (at(u, v) || at(u, v - 1) || at(u, v + 1)) hit++
    return hit / Math.max(1, all)
  }
  const coverAcross = (u: number) => {
    let hit = 0
    let all = 0
    for (let v = Math.floor(nv * 0.05); v < Math.ceil(nv * 0.95); v++, all++) if (at(u, v) || at(u - 1, v) || at(u + 1, v)) hit++
    return hit / Math.max(1, all)
  }

  // Inner lines: rows clearly inside the outline that are mostly drawn, one per run of rows.
  const lines = (count: number, cover: (i: number) => number) => {
    const found: { offset: number; side: -1 | 1; cover: number }[] = []
    const covers = Array.from({ length: count }, (_, i) => cover(i))
    const edge = Math.ceil(4 / CELL_CM)
    for (let i = edge; i < count - edge; i++) {
      const c = covers[i]
      if (c < 0.5 || c < covers[i - 1] || c < covers[i + 1]) continue
      if (found.length && Math.abs(found[found.length - 1].offset - Math.min(i, count - 1 - i) * CELL_CM) < 3) continue
      const side: -1 | 1 = i < count / 2 ? -1 : 1
      found.push({ offset: (side < 0 ? i + 0.5 : count - i - 0.5) * CELL_CM, side, cover: c })
    }
    return { found, covers }
  }
  const along = lines(nv, coverAlong)
  const across = lines(nu, coverAcross)

  // The diagonals: corner to corner, both ways.
  const diagonal = (flip: boolean) => {
    let hit = 0
    const N = 40
    for (let k = 0; k < N; k++) {
      const t = 0.1 + (0.8 * k) / (N - 1)
      const u = Math.floor(t * nu)
      const v = Math.floor((flip ? 1 - t : t) * nv)
      if (near(u, v)) hit++
    }
    return hit / N
  }
  const cross = diagonal(false) >= 0.75 && diagonal(true) >= 0.75

  // Inside ink that isn't on a mostly drawn row or column.
  let inside = 0
  let insideInk = 0
  let freeInk = 0
  const straightV = new Set<number>()
  const straightU = new Set<number>()
  along.covers.forEach((c, v) => c >= 0.5 && straightV.add(v))
  across.covers.forEach((c, u) => c >= 0.5 && straightU.add(u))
  for (let u = 1; u < nu - 1; u++) {
    for (let v = 1; v < nv - 1; v++) {
      inside++
      if (!ink[u * nv + v]) continue
      insideInk++
      const onLine = [-1, 0, 1].some((k) => straightV.has(v + k) || straightU.has(u + k))
      if (!onLine) freeInk++
    }
  }
  return {
    L: box.length,
    W: box.width,
    cross,
    along: along.found,
    across: across.found,
    edgeAlong: [Math.max(along.covers[0], along.covers[1] ?? 0), Math.max(along.covers[nv - 1], along.covers[nv - 2] ?? 0)],
    edgeAcross: [Math.max(across.covers[0], across.covers[1] ?? 0), Math.max(across.covers[nu - 1], across.covers[nu - 2] ?? 0)],
    free: insideInk ? freeInk / insideInk : 0,
    inked: inside ? insideInk / inside : 0,
  }
}

// ---------- names ----------

// Words on a plan that name furniture, in English, Croatian, German, Dutch and French, and
// IKEA's own product names. Checked in order: the first match wins.
const WORDS: [RegExp, string][] = [
  [/\b(sofa|couch|settee|kau[čc]|trosjed|dvosjed|sitzbank|canap[ée]|s[öo]derhamn|kivik|vimle|friheten|ektorp|klippan|landskrona|uppland|finnala|gr[öo]nlid|vallentuna|hyltarp|holmsund)/i, 'generic-sofa'],
  [/\b(arm ?chair|fotelj|sessel|fauteuil|po[äa]ng|strandmon|ekener|vedbo|koarp)/i, 'generic-armchair'],
  [/\b(nightstand|night stand|bedside|no[ćc]ni ormari[ćc]|nachttisch|nachtkastje|chevet|rast\b)/i, 'generic-nightstand'],
  [/\b(bed|krevet|bett|lit\b|malm|brimnes|tarva|songesand|neiden|slattum|kleppstad|nordli|tufjord|sagstua|sl[äa]kt|minnen|kritter|sundvik|treetale)/i, 'generic-bed'],
  [/\b(wardrobe|closet|garderob|ormar|kleiderschrank|kast\b|armoire|pax\b|hasvik|platsa|sm[åa]stad|rakkestad|visthus)/i, 'generic-wardrobe'],
  [/\b(desk|radni stol|schreibtisch|bureau|micke|alex\b|lagkapten|linnmon|bekant|id[åa]sen|trotten|mittzon|uppsp[äa]l)/i, 'generic-desk'],
  [/\b(office chair|uredska stolica|b[üu]rostuhl|markus|j[äa]rvfj[äa]llet|flintan|millberget)/i, 'generic-office-chair'],
  [/\b(coffee table|side table|klub ?stoli[ćc]|couchtisch|salontafel|table basse|lack\b|vittsj[öo]|gladom|borgeby)/i, 'generic-coffee-table'],
  [/\b(dining|table|stol\b|blagovaona|tisch|tafel|ekedalen|lisabo|ingatorp|melltorp|nordviken|m[öo]ckelby|stokke)/i, 'generic-dining-table'],
  [/\b(chair|stolica|stuhl|stoel|chaise|mammut|ingolf|adde\b|teodores|lerhamn|terje|kyrre)/i, 'generic-chair'],
  [/\b(book ?case|shelf|shelves|shelving|storage|polica|regal|boekenkast|biblioth[èe]que|billy|kallax|bror\b|ivar\b|hauga)/i, 'generic-bookcase'],
  [/\b(tv|television|televizor|fernseh|best[åa])/i, 'generic-tv-unit'],
  [/\b(fridge|refrigerator|hladnjak|fri[žz]ider|k[üu]hlschrank|koelkast|r[ée]frig[ée]rateur|frigo|freezer|tall unit)/i, 'generic-fridge'],
  [/\b(stove|cooker|hob\b|hob unit|oven|[šs]tednjak|herd\b|kookplaat|fornuis|cuisini[èe]re)/i, 'generic-stove'],
  [/\b(kitchen sink|sink|sudoper|sp[üu]le|[ée]vier)/i, 'generic-kitchen-sink'],
  [/\b(kitchen|base unit|kitchen base|counter|worktop|kuhinja|radna plo[čc]a|k[üu]che|keuken|cuisine|metod|knoxhult)/i, 'generic-kitchen-base'],
  [/\b(washing machine|washer|dryer|tumble|perilica|su[šs]ilica|waschmaschine|wasmachine|lave-linge|s[èe]che-linge)/i, 'generic-washing-machine'],
  [/\b(toilet|wc\b|w\.c\.|zahod|klozet|toilette)/i, 'generic-toilet'],
  [/\b(wash ?basin|basin|lavabo|umivaonik|waschbecken|wastafel|vanity)/i, 'generic-washbasin'],
  [/\b(bath ?tub|kada\b|badewanne|baignoire)/i, 'generic-bathtub'],
  [/\b(shower|tu[šs]\b|dusche|douche)/i, 'generic-shower'],
  [/\b(piano|klavir|klavier)/i, 'generic-box'],
]

/** The model a label names, or null. IKEA models whose name is in the label win. */
export function modelForLabel(label: string): string | null {
  const text = label.replace(/\s+/g, ' ').trim()
  if (!text) return null
  for (const [name, spec] of Object.entries(MODELS)) {
    // Not \b: IKEA names end in letters like Å, which \b doesn't count as part of a word.
    if (spec.ikea && new RegExp(`(^|[^\\p{L}])${spec.ikea.name}($|[^\\p{L}])`, 'iu').test(text)) return name
  }
  for (const [re, model] of WORDS) if (re.test(text)) return model
  return null
}

// ---------- what a shape is ----------

function guessFromLabel(s: Shape, f: Features): Guess | null {
  if (!s.label) return null
  const model = modelForLabel(s.label)
  if (!model) return null
  const kind = MODELS[model]?.generic?.kind
  // Beds and toilets stand with a short side to the wall, the rest with a long side.
  const back = kind === 'bed' || kind === 'toilet' || (kind === 'table' && f.L / f.W < 1.3) ? 'short' : 'long'
  return { model, back, label: s.label }
}

const within = (x: number, lo: number, hi: number) => x >= lo && x <= hi

/** A readable name (two real words) that isn't furniture. OCR noise alone doesn't count. */
function namesSomethingElse(label: string | undefined): boolean {
  if (!label) return false
  return (label.match(/\p{L}{3,}/gu) ?? []).length >= 2
}

function guessFromDrawing(f: Features): Guess | null {
  const { L, W } = f
  // Hardly any outline: dimension lines, arrows, hatching, not a piece of furniture.
  if (f.edgeAlong[0] + f.edgeAlong[1] + f.edgeAcross[0] + f.edgeAcross[1] < 1) return null
  const ratio = L / W
  const inner = (list: Features['along'], lo: number, hi: number) => list.filter((l) => within(l.offset, lo, hi))

  if (f.cross) {
    if (W >= 70 && L <= 130 && ratio < 1.4) return { model: 'generic-shower', back: 'long' }
    if (within(W, 30, 75) && L >= 40) return { model: 'generic-wardrobe', back: 'long' }
    return null
  }
  // Long, deep enough to lie on: a bed or a sofa.
  const backLines = inner(f.along, 8, 40) // a sofa's back cushion, along one long side
  const armLines = inner(f.across, 8, 35) // a sofa's arms, at both ends
  const pillowLines = inner(f.across, 15, 70) // a bed's pillow or turned-down cover, at one end
  const armsBothEnds = armLines.some((l) => l.side < 0) && armLines.some((l) => l.side > 0)
  const backOneSide = backLines.length > 0 && new Set(backLines.map((l) => l.side)).size === 1
  const ringed = inner(f.along, 3, 15).length >= 2 && new Set(inner(f.along, 3, 15).map((l) => l.side)).size === 2
  if (within(L, 160, 235) && within(W, 120, 220)) return bedGuess(pillowLines)
  if (within(L, 175, 235) && within(W, 75, 125)) {
    const sofa = (backOneSide ? 2 : 0) + (armsBothEnds ? 1 : 0)
    const bed = pillowLines.length > 0 && !armsBothEnds ? 2 : 0
    if (sofa > bed) return { model: 'generic-sofa', back: 'long', prefer: backLines[0]?.side }
    if (bed || L > 192 || !ringed) return bedGuess(pillowLines)
  }
  // A tub: an inner outline all round, rounded or straight.
  if (within(L, 140, 195) && within(W, 60, 95) && ringed) return { model: 'generic-bathtub', back: 'long' }
  if (within(L, 120, 330) && within(W, 70, 115) && (backOneSide || armsBothEnds)) {
    return { model: 'generic-sofa', back: 'long', prefer: backOneSide ? backLines[0].side : undefined }
  }
  // About 60 deep: kitchen units when divided into cabinets or with a sink or hob drawn in, else a wardrobe.
  if (within(W, 50, 72) && L >= 90) {
    const kitchen = f.free > 0.15 || f.across.length >= 2 || f.inked > 0.06
    return { model: kitchen ? 'generic-kitchen-base' : 'generic-wardrobe', back: 'long' }
  }
  // A toilet: narrow, with a tank across one end and a bowl.
  const tank = inner(f.across, 5, 25)
  if (within(L, 45, 80) && within(W, 30, 50) && ratio >= 1.4 && (f.free > 0.1 || tank.length > 0 || f.inked > 0.12)) {
    return { model: 'generic-toilet', back: 'short', prefer: new Set(tank.map((l) => l.side)).size === 1 ? tank[0].side : undefined }
  }
  // Shelves and low cabinets: straight lines only (a toilet of the same size has a round bowl).
  if (within(W, 25, 50) && L >= 65 && f.free < 0.2) return { model: L >= 120 ? 'generic-tv-unit' : 'generic-bookcase', back: 'long' }
  // An armchair: a square seat with a back or arms drawn in. A table of that size is plain.
  if (within(L, 60, 105) && within(W, 55, 100) && ratio < 1.4 && (backLines.length > 0 || armsBothEnds)) {
    return { model: 'generic-armchair', back: 'long', prefer: backOneSide ? backLines[0].side : undefined }
  }
  if (within(L, 70, 220) && within(W, 70, 120) && ratio <= 2.2) {
    return { model: 'generic-dining-table', back: ratio < 1.3 ? 'short' : 'long' }
  }
  // Straight sides all round (a circle only grazes its box's sides).
  const sides = [...f.edgeAlong, ...f.edgeAcross].filter((c) => c >= 0.85).length
  const outlined = sides === 4
  if (within(L, 52, 68) && ratio < 1.2 && f.free > 0.3 && outlined) return { model: 'generic-washing-machine', back: 'long' } // a square with a round drum
  if (within(L, 60, 105) && within(W, 55, 100) && ratio < 1.4) return { model: 'generic-armchair', back: 'long' }
  // A basin: a straight-sided cabinet with the bowl drawn inside.
  if (within(L, 48, 100) && within(W, 30, 58) && ratio < 2 && sides >= 3 && (f.free > 0.1 || f.inked > 0.05)) return { model: 'generic-washbasin', back: 'long' }
  if (within(L, 35, 60) && within(W, 32, 60) && ratio < 1.5 && sides >= 2) return { model: 'generic-chair', back: 'long' }
  return null
}

/** A bed's head is at the end with the pillow line, when one end has one. */
function bedGuess(pillows: Features['across']): Guess {
  const sides = new Set(pillows.map((l) => l.side))
  return { model: 'generic-bed', back: 'short', prefer: sides.size === 1 ? pillows[0].side : undefined }
}

// ---------- placing ----------

/** Distance from p to the nearest wall face (0 inside a wall). */
function wallDistance(p: Vec2, walls: Wall[]): number {
  let best = Infinity
  for (const w of walls) {
    const { t, d, length } = projectOnWall(p, w)
    const along = t < 0 ? -t : t > length ? t - length : 0
    best = Math.min(best, Math.hypot(along, Math.max(0, d - w.thickness / 2)))
  }
  return best
}

function place(s: Shape, g: Guess, walls: Wall[]): PlacedFurniture | null {
  const spec = MODELS[g.model]
  if (!spec) return null
  const { box } = s
  const a = box.axis
  const n = { x: -a.y, y: a.x }
  // Candidate back directions (outward normals of the sides), and how far each side is from a wall.
  const dirs = g.back === 'long' ? [{ d: n, sign: 1 as const }, { d: { x: -n.x, y: -n.y }, sign: -1 as const }]
    : [{ d: a, sign: 1 as const }, { d: { x: -a.x, y: -a.y }, sign: -1 as const }]
  const half = g.back === 'long' ? box.width / 2 : box.length / 2
  const sideLen = g.back === 'long' ? box.length : box.width
  const tangent = g.back === 'long' ? a : n
  const gap = (dir: Vec2) => {
    const mid = { x: box.center.x + dir.x * half, y: box.center.y + dir.y * half }
    return Math.min(
      ...[-0.35, 0, 0.35].map((k) =>
        wallDistance({ x: mid.x + tangent.x * sideLen * k + dir.x * 2, y: mid.y + tangent.y * sideLen * k + dir.y * 2 }, walls),
      ),
    )
  }
  const gaps = dirs.map((x) => gap(x.d))
  // The side against a wall, unless the drawing says which side is the back and no wall is clearly closer.
  let pick = gaps[0] <= gaps[1] ? 0 : 1
  if (g.prefer) {
    const preferred = dirs.findIndex((x) => x.sign === g.prefer)
    if (gaps[preferred] < gaps[1 - preferred] + 25) pick = preferred
  }
  if (g.backDir) {
    const dot = (d: Vec2) => d.x * g.backDir!.x + d.y * g.backDir!.y
    pick = dot(dirs[0].d) >= dot(dirs[1].d) ? 0 : 1
  }
  const back = dirs[pick].d
  let rotation = ((((Math.atan2(back.x, -back.y) * 180) / Math.PI) % 360) + 360) % 360
  // Nearly square to the plan: exactly square.
  if (Math.abs(rotation - Math.round(rotation / 90) * 90) < 3) rotation = (Math.round(rotation / 90) * 90) % 360

  // Sizes: the drawn rectangle, for the model's own width and depth.
  const drawnWidth = g.back === 'long' ? box.length : box.width // along the back
  const drawnDepth = g.back === 'long' ? box.width : box.length
  const values: Record<string, number> = {}
  const params = spec.params ?? {}
  const setNum = (key: string, v: number) => {
    const p = params[key]
    if (p?.type !== 'number') return
    values[key] = Math.round(Math.min(p.max ?? Infinity, Math.max(p.min ?? 0, v)))
  }
  if (spec.generic?.kind === 'bed') {
    setNum('width', drawnWidth - 10)
    setNum('length', drawnDepth - 15)
  }
  else setNum('width', drawnWidth)
  setNum('depth', drawnDepth)

  // The back stays where it's drawn; a model deeper or shallower than the drawing grows forwards.
  const item: PlacedFurniture = { id: newId(), model: g.model, x: box.center.x, y: box.center.y, rotation: Math.round(rotation), values }
  const depth = modelOf(item)?.size[1] ?? drawnDepth
  const backMid = { x: box.center.x + back.x * (drawnDepth / 2), y: box.center.y + back.y * (drawnDepth / 2) }
  item.x = backMid.x - (back.x * depth) / 2
  item.y = backMid.y - (back.y * depth) / 2
  if (g.label) item.label = g.label
  return item
}

// ---------- putting it together ----------

export interface FurnitureOptions {
  walls: Wall[]
  openings?: Opening[]
}

/** Is p within the walls' bounds? Furniture is inside; titles, legends and dimensions mostly aren't. */
export function insideBuilding(p: Vec2, walls: Wall[]): boolean {
  if (!walls.length) return true
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const w of walls) {
    for (const q of [w.a, w.b]) {
      x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y)
      x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y)
    }
  }
  return p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1
}

/** Recognises shapes as furniture. Shapes that cross walls, sit in door swings or aren't recognised are skipped. */
export function recogniseFurniture(shapes: Shape[], { walls, openings = [] }: FurnitureOptions): PlacedFurniture[] {
  const byId = new Map(walls.map((w) => [w.id, w]))
  const inDoorway = (p: Vec2) =>
    openings.some((o) => {
      const w = byId.get(o.wallId)
      if (!w || o.kind !== 'door') return false
      const { t, d } = projectOnWall(p, w)
      return t > o.offset - 5 && t < o.offset + o.width + 5 && d < o.width + 5
    })
  // Clearly inside a wall. Furniture drawn up against a wall touches its face, and that's fine.
  const insideWall = (p: Vec2) =>
    walls.some((w) => {
      const { t, d, length } = projectOnWall(p, w)
      return t > 0 && t < length && d < w.thickness / 2 - 3
    })

  const out: PlacedFurniture[] = []
  const leftOver: Shape[] = []
  // Biggest first, so tables are known when their chairs come.
  const bySize = [...shapes].sort((a, b) => b.box.length * b.box.width - a.box.length * a.box.width)
  for (const shape of bySize) {
    if (!insideBuilding(shape.box.center, walls)) continue
    // Shapes made of wall or door lines aren't furniture.
    let wallInk = 0
    let doorInk = 0
    for (const p of shape.points) {
      if (insideWall(p)) wallInk++
      else if (inDoorway(p)) doorInk++
    }
    // A door's leaf and swing drawn on the furniture layer: door-sized, and in the doorway.
    const doorSized = shape.box.length <= 130
    if (wallInk > shape.points.length * 0.15 || (doorSized && doorInk > shape.points.length * 0.5)) continue

    const f = featuresOf(shape)
    const label = guessFromLabel(shape, f)
    const desk = label ? null : deskWithChair(shape, f)
    if (desk) {
      const item = place(desk.desk, { model: 'generic-desk', back: 'long', backDir: desk.back }, walls)
      if (item) out.push(item)
      leftOver.push(desk.chair)
      continue
    }
    // A patch named, but not as furniture ("Pipe shaft", "Storage"): leave it. (Writing inside
    // an outline may be the room's name instead, so outlines are still judged by their drawing.)
    if (!label && shape.filled && namesSomethingElse(shape.label)) continue
    // Something chair-sized right at a table or desk is its chair.
    const chair = !label && shape.box.length < 70 ? chairBeside(shape.box.center, out) : null
    if (chair) {
      out.push(chair)
      continue
    }
    const g = label ?? guessFromDrawing(f)
    const item = g && place(shape, g, walls)
    if (item) out.push(item)
    else leftOver.push(shape)
  }
  out.push(...chairsAround(leftOver, out))
  return withContext(withoutDuplicates(out))
}

/**
 * A desk with its chair pushed in, drawn as one: a full-length line (the desk's front edge)
 * with only part of a chair beyond it. Split into the desk and what sticks out.
 */
function deskWithChair(s: Shape, f: Features): { desk: Shape; chair: Shape; back: Vec2 } | null {
  if (f.edgeAlong[0] + f.edgeAlong[1] + f.edgeAcross[0] + f.edgeAcross[1] < 1) return null
  const { box } = s
  const n = { x: -box.axis.y, y: box.axis.x }
  // The chair can stick out of a long side (lines along the box) or a short one (lines across).
  const ways = [
    { lines: f.along, edges: f.edgeAlong, depth: f.W, width: f.L, dir: n },
    { lines: f.across, edges: f.edgeAcross, depth: f.L, width: f.W, dir: box.axis },
  ]
  for (const way of ways) {
    for (const line of way.lines) {
      if (line.cover < 0.65 || !within(line.offset, 12, 45)) continue
      // The far side of the line is only partly drawn: a chair, not the edge of a bigger piece.
      if (way.edges[line.side < 0 ? 0 : 1] >= 0.6) continue
      const body = way.depth - line.offset
      if (!within(body, 40, 85) || !within(way.width, 70, 220)) continue
      const cut = line.side * (way.depth / 2 - line.offset) // where the line is
      const at = (p: Vec2) => ((p.x - box.center.x) * way.dir.x + (p.y - box.center.y) * way.dir.y) * line.side
      const deskPts = s.points.filter((p) => at(p) <= cut * line.side + 1)
      const chairPts = s.points.filter((p) => at(p) > cut * line.side + 1)
      const deskBox = boxOf(deskPts, box.axis)
      const chairBox = boxOf(chairPts, box.axis)
      if (!deskBox || !chairBox) return null
      // The desk's back is away from the chair.
      const back = { x: -way.dir.x * line.side, y: -way.dir.y * line.side }
      return { desk: { points: deskPts, box: deskBox }, chair: { points: chairPts, box: chairBox }, back }
    }
  }
  return null
}

/**
 * Small leftover shapes next to a table or desk are its chairs (often drawn as a few loose
 * strokes: a seat and a back). Each faces the table.
 */
function chairsAround(leftOver: Shape[], items: PlacedFurniture[]): PlacedFurniture[] {
  if (!items.some((i) => i.model === 'generic-dining-table' || i.model === 'generic-desk')) return []
  // Loose strokes close together are one chair.
  const groups: Shape[] = []
  for (const s of leftOver.filter((x) => x.box.length < 70)) {
    const near = groups.find((g) => boxGap(g.box, s.box) <= 6)
    if (near) {
      near.points.push(...s.points)
      near.box = boxOf(near.points, near.box.axis) ?? near.box
    } else groups.push({ points: [...s.points], box: s.box })
  }
  const chairs: PlacedFurniture[] = []
  for (const g of groups) {
    if (!within(g.box.length, 28, 70)) continue
    const chair = chairBeside(g.box.center, items)
    if (chair) chairs.push(chair)
  }
  return chairs
}

/** A chair at `c`, facing the table or desk it's next to, or null when it's next to none. */
function chairBeside(c: Vec2, items: PlacedFurniture[]): PlacedFurniture | null {
  for (const t of items) {
    if (t.model !== 'generic-dining-table' && t.model !== 'generic-desk') continue
    const m = modelOf(t)
    if (!m) continue
    // In the table's own axes: how far beyond its edges the chair's centre is.
    const r = (t.rotation * Math.PI) / 180
    const ax = [
      { x: Math.cos(r), y: Math.sin(r) },
      { x: -Math.sin(r), y: Math.cos(r) },
    ]
    const d = { x: c.x - t.x, y: c.y - t.y }
    const along = ax.map((a) => d.x * a.x + d.y * a.y)
    const beyond = along.map((v, k) => Math.abs(v) - m.size[k] / 2)
    if (Math.max(...beyond) > 45 || Math.min(...beyond) > 15) continue
    // The chair is off the side it's furthest beyond; its back faces away from the table.
    const k = beyond[0] > beyond[1] ? 0 : 1
    const sign = Math.sign(along[k]) || 1
    const back = { x: ax[k].x * sign, y: ax[k].y * sign }
    const rotation = Math.round(((((Math.atan2(back.x, -back.y) * 180) / Math.PI) % 360) + 360) % 360)
    const model = t.model === 'generic-desk' ? 'generic-office-chair' : 'generic-chair'
    return { id: newId(), model, x: c.x, y: c.y, rotation }
  }
  return null
}

/** The gap between two boxes, using their axis-aligned bounds (0 when they overlap). */
function boxGap(a: Rect, b: Rect): number {
  const ext = (r: Rect) => {
    const n = { x: -r.axis.y, y: r.axis.x }
    const hx = (Math.abs(r.axis.x) * r.length + Math.abs(n.x) * r.width) / 2
    const hy = (Math.abs(r.axis.y) * r.length + Math.abs(n.y) * r.width) / 2
    return { x0: r.center.x - hx, x1: r.center.x + hx, y0: r.center.y - hy, y1: r.center.y + hy }
  }
  const p = ext(a)
  const q = ext(b)
  const dx = Math.max(0, Math.max(p.x0, q.x0) - Math.min(p.x1, q.x1))
  const dy = Math.max(0, Math.max(p.y0, q.y0) - Math.min(p.y1, q.y1))
  return Math.hypot(dx, dy)
}

/**
 * The same piece found twice (from a file's outlines and from its picture): keep one, the one
 * with a name when there is one.
 */
function withoutDuplicates(items: PlacedFurniture[]): PlacedFurniture[] {
  const sorted = [...items].sort((a, b) => Number(!!b.label) - Number(!!a.label))
  const kept: PlacedFurniture[] = []
  for (const i of sorted) {
    const size = modelOf(i)?.size ?? [50, 50]
    if (kept.some((k) => dist(k, i) < Math.max(15, Math.min(size[0], size[1]) * 0.3))) continue
    kept.push(i)
  }
  return kept
}

/** Second looks with the neighbours known: a "chair" at a bed's head is a nightstand. */
function withContext(items: PlacedFurniture[]): PlacedFurniture[] {
  const beds = items.filter((i) => i.model === 'generic-bed')
  return items.map((i) => {
    if (i.model !== 'generic-chair' || i.label) return i
    const nearBedHead = beds.some((b) => {
      const r = (b.rotation * Math.PI) / 180
      const back = { x: b.x + Math.sin(r) * 100, y: b.y - Math.cos(r) * 100 }
      return dist(back, { x: i.x, y: i.y }) < 140
    })
    return nearBedHead ? { ...i, model: 'generic-nightstand', values: {} } : i
  })
}
