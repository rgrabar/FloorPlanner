import { dist, newId } from '../model/geometry'
import type { Vec2, Wall } from '../model/types'
import type { GapClassifier } from '../model/wallsFromLines'

// Finds walls in a picture of a plan (a rendered PDF page, a PNG, a scan). Walls in most plans
// are thick dark bands, while everything else (window lines, door swings, dimensions, text, grids)
// is drawn thin or light. So: find the dark pixels, keep the ones in bands thicker than the
// drawing's lines, and trace those bands into straight walls with a measured thickness.
// Works on pixels; the caller converts to plan units.

const MAX_SIDE = 3000

export interface Picture {
  w: number
  h: number
  dark: Uint8Array // 1 where ink is dark enough to be wall
  ink: Uint8Array // 1 where anything is drawn (lighter lines too)
  thin: Uint8Array // ink that isn't wall: lines, arcs, text (set by findWallPieces)
  scale: number // picture pixels per source image pixel (pictures over MAX_SIDE are shrunk)
}

export async function loadPicture(src: string): Promise<Picture> {
  const img = new Image()
  img.src = src
  await img.decode()
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.round(img.naturalWidth * scale)
  const h = Math.round(img.naturalHeight * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)
  const rgba = ctx.getImageData(0, 0, w, h).data

  const lum = new Uint8Array(w * h)
  const hist = new Uint32Array(256)
  for (let i = 0; i < w * h; i++) {
    const v = Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2])
    lum[i] = v
    hist[v]++
  }
  // Wall ink: darker than an automatic threshold between ink and paper, but never light grey.
  const darkLimit = Math.min(120, Math.max(60, otsu(hist, w * h)))
  // Drawn: clearly darker than the local background, so light grey door swings on pastel room
  // colours count, while faint grid lines don't.
  const background = maxFilter(lum, w, h, 4)
  const dark = new Uint8Array(w * h)
  const ink = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    dark[i] = lum[i] < darkLimit ? 1 : 0
    ink[i] = lum[i] < 200 || lum[i] <= background[i] - 15 ? 1 : 0
  }
  return { w, h, dark, ink, thin: ink, scale }
}

/** The brightest value within r pixels (a square), in two passes. */
function maxFilter(v: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, v[y * w + k])
      tmp[y * w + x] = m
    }
  }
  const out = new Uint8Array(w * h)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 0
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, tmp[k * w + x])
      out[y * w + x] = m
    }
  }
  return out
}

/** Otsu's threshold: the grey level that best separates a picture's two main tones. */
function otsu(hist: Uint32Array, total: number): number {
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0
  let wB = 0
  let best = 0
  let threshold = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) ** 2
    if (between > best) {
      best = between
      threshold = t
    }
  }
  return threshold
}

/** For every set pixel, the length of the horizontal and vertical runs it belongs to. */
function runLengths(mask: Uint8Array, w: number, h: number) {
  const H = new Uint16Array(w * h)
  const V = new Uint16Array(w * h)
  for (let y = 0; y < h; y++) {
    let x = 0
    while (x < w) {
      if (!mask[y * w + x]) {
        x++
        continue
      }
      const x0 = x
      while (x < w && mask[y * w + x]) x++
      const len = Math.min(65535, x - x0)
      for (let k = x0; k < x; k++) H[y * w + k] = len
    }
  }
  for (let x = 0; x < w; x++) {
    let y = 0
    while (y < h) {
      if (!mask[y * w + x]) {
        y++
        continue
      }
      const y0 = y
      while (y < h && mask[y * w + x]) y++
      const len = Math.min(65535, y - y0)
      for (let k = y0; k < y; k++) V[k * w + x] = len
    }
  }
  return { H, V }
}

/** Grows a mask by r pixels in every direction (a square neighbourhood), in two passes. */
function dilate(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    let last = -Infinity
    for (let x = 0; x < w + r; x++) {
      if (x < w && m[y * w + x]) last = x
      const cx = x - r
      if (cx >= 0 && x - last <= 2 * r) tmp[y * w + cx] = 1
    }
  }
  const out = new Uint8Array(w * h)
  for (let x = 0; x < w; x++) {
    let last = -Infinity
    for (let y = 0; y < h + r; y++) {
      if (y < h && tmp[y * w + x]) last = y
      const cy = y - r
      if (cy >= 0 && y - last <= 2 * r) out[cy * w + x] = 1
    }
  }
  return out
}

function transpose(m: Uint8Array, w: number, h: number): Uint8Array {
  const t = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) t[x * h + y] = m[y * w + x]
  return t
}

interface Slice {
  x: number
  y0: number
  y1: number
}

/**
 * Bands running left to right: in every column, the runs of wall pixels of wall-like thickness;
 * runs in neighbouring columns at the same height chain into a band. A band may cross a few
 * columns where another wall joins (fully dark there) and still continue.
 */
function horizontalBands(wall: Uint8Array, dark: Uint8Array, w: number, h: number, tMin: number, tMax: number): Slice[][] {
  const done: Slice[][] = []
  let active: { slices: Slice[]; y0: number; y1: number; lastX: number }[] = []
  const solid = (x0: number, x1: number, y0: number, y1: number) => {
    // Columns x0..x1 dark across y0..y1 (allowing a little noise)?
    let on = 0
    let all = 0
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        all++
        on += dark[y * w + x]
      }
    }
    return all > 0 && on >= all * 0.9
  }
  for (let x = 0; x < w; x++) {
    const used = new Set<number>()
    let y = 0
    while (y < h) {
      if (!wall[y * w + x]) {
        y++
        continue
      }
      const y0 = y
      while (y < h && wall[y * w + x]) y++
      const y1 = y - 1
      const len = y1 - y0 + 1
      if (len < tMin || len > tMax) continue
      let best = -1
      let bestD = Infinity
      active.forEach((c, i) => {
        if (used.has(i)) return
        const d = Math.abs(c.y0 - y0) + Math.abs(c.y1 - y1)
        if (d > 4 || d >= bestD) return
        if (c.lastX < x - 1 && !(x - c.lastX - 1 <= tMax && solid(c.lastX + 1, x - 1, Math.max(y0, c.y0), Math.min(y1, c.y1)))) return
        best = i
        bestD = d
      })
      const slice = { x, y0, y1 }
      if (best >= 0) {
        const c = active[best]
        c.slices.push(slice)
        c.y0 = y0
        c.y1 = y1
        c.lastX = x
        used.add(best)
      } else {
        active.push({ slices: [slice], y0, y1, lastX: x })
        used.add(active.length - 1)
      }
    }
    // Bands that can no longer continue are finished.
    if (x % 8 === 0 || x === w - 1) {
      const keep: typeof active = []
      for (const c of active) {
        if (c.lastX < x - tMax - 1 || x === w - 1) done.push(c.slices)
        else keep.push(c)
      }
      active = keep
    }
  }
  return done
}

interface Band {
  a: Vec2
  b: Vec2
  thickness: number
  length: number
  wobble: number // how far the band's middle strays from a straight line (RMS, pixels)
}

/** A straight wall through a band's slices: a least-squares line through their middles. */
function bandToWall(slices: Slice[], vertical: boolean): Band {
  const n = slices.length
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (const s of slices) {
    const x = s.x + 0.5
    const c = (s.y0 + s.y1 + 1) / 2
    sx += x
    sy += c
    sxx += x * x
    sxy += x * c
  }
  const den = n * sxx - sx * sx
  const slope = den > 0 ? (n * sxy - sx * sy) / den : 0
  const icept = (sy - slope * sx) / n
  const x0 = slices[0].x
  const x1 = slices[n - 1].x + 1
  const thick = slices.map((s) => s.y1 - s.y0 + 1).sort((p, q) => p - q)[n >> 1] * Math.cos(Math.atan(slope))
  const a = { x: x0, y: icept + slope * x0 }
  const b = { x: x1, y: icept + slope * x1 }
  const swap = (p: Vec2) => (vertical ? { x: p.y, y: p.x } : p)
  let sq = 0
  for (const sl of slices) sq += ((sl.y0 + sl.y1 + 1) / 2 - (icept + slope * (sl.x + 0.5))) ** 2
  const wobble = Math.sqrt(sq / n)
  return { a: swap(a), b: swap(b), thickness: thick, length: Math.hypot(x1 - x0, slope * (x1 - x0)), wobble }
}

export interface PictureWalls {
  walls: Wall[] // in picture pixels
  strokeWidth: number
  outlined: boolean // found as outlines (two thin lines) rather than filled bands
}

/** Wall pieces in a picture (pixels), split at doors and windows; joining them is up to the caller. */
export function findWallPieces(pic: Picture): PictureWalls {
  const { w, h, dark } = pic
  const { H, V } = runLengths(dark, w, h)

  // The drawing's line width: the most common thickness among thin dark marks.
  const counts = new Uint32Array(9)
  for (let i = 0; i < w * h; i++) {
    if (!dark[i]) continue
    const m = Math.min(H[i], V[i])
    if (m <= 8) counts[m]++
  }
  let stroke = 1
  for (let k = 1; k <= 6; k++) if (counts[k] > counts[stroke]) stroke = k
  const tMin = Math.max(3, 2 * stroke + 1)
  const tMax = Math.round(Math.max(w, h) * 0.05)

  // Wall pixels: dark, and in a band thicker than the drawing's lines in both directions.
  const wall = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) wall[i] = dark[i] && Math.min(H[i], V[i]) >= tMin ? 1 : 0
  // Thin ink: drawn lines (arcs, leaves, glazing, text), but not walls, the soft edge around
  // walls, or the inside of filled shapes like furniture. Doors and windows are told apart by it.
  const nearWall = dilate(wall, w, h, 3)
  const inkRuns = runLengths(pic.ink, w, h)
  const thinMax = Math.max(3, 2 * stroke + 2)
  const thin = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    thin[i] = pic.ink[i] && !nearWall[i] && Math.min(inkRuns.H[i], inkRuns.V[i]) <= thinMax ? 1 : 0
  }
  pic.thin = thin

  let kept = wallBands(wall, dark, w, h, tMin, tMax)
  const outlined = kept.length < 4
  if (outlined) {
    // Hardly any filled walls: an outlined plan (a CAD drawing as a picture). Fill between pairs
    // of thin parallel lines and look for bands in that instead.
    const lines = new Uint8Array(w * h)
    for (let i = 0; i < w * h; i++) lines[i] = pic.ink[i] && Math.min(inkRuns.H[i], inkRuns.V[i]) <= thinMax ? 1 : 0
    // The faces of even thin walls are clearly further apart than doubled strokes or lettering.
    const filled = outlineFill(lines, w, h, Math.max(tMin + 2, 2 * stroke + 4), tMax, thinMax)
    kept = wallBands(filled, filled, w, h, tMin, tMax)
  }

  return {
    walls: kept.map((b) => ({ id: newId(), a: b.a, b: b.b, thickness: b.thickness })),
    strokeWidth: stroke,
    outlined,
  }
}

/** Straight wall bands in a wall mask, without text strokes and other small marks. */
function wallBands(wall: Uint8Array, solid: Uint8Array, w: number, h: number, tMin: number, tMax: number): Band[] {
  const all: Band[] = [
    ...horizontalBands(wall, solid, w, h, tMin, tMax).map((s) => bandToWall(s, false)),
    ...horizontalBands(transpose(wall, w, h), transpose(solid, w, h), h, w, tMin, tMax).map((s) => bandToWall(s, true)),
  ]
  // Walls are straight: a band following a curve (a door swing filled in) isn't one.
  const bands = all.filter((b) => b.length >= 1.2 * b.thickness && b.length >= 2 * tMin && b.wobble <= 0.15 * b.thickness + 1)

  // Text strokes and small marks can look like short thick bands. Walls are at least as thick as
  // the thinnest walls that clearly are walls: bands long compared to their thickness, ignoring
  // the thinnest tenth of their total length (a letter "l" is long for its thickness too).
  const clear = bands.filter((b) => b.length >= 8 * b.thickness).sort((p, q) => p.thickness - q.thickness)
  const clearLength = clear.reduce((t, b) => t + b.length, 0)
  let thinnest = 0
  let acc = 0
  for (const b of clear) {
    acc += b.length
    if (acc >= clearLength * 0.1) {
      thinnest = b.thickness
      break
    }
  }
  let kept = clear.length ? bands.filter((b) => b.thickness >= 0.75 * thinnest) : bands.filter((b) => b.length >= 3 * b.thickness)

  // Walls follow the building's main directions. The main direction comes from the clear walls
  // (angles folded into 0..90°, averaged on a circle). Off-direction bands are kept only when
  // they're long and thin, like a real angled wall.
  if (clear.length) {
    let sx = 0
    let sy = 0
    for (const b of clear) {
      const a = Math.atan2(b.b.y - b.a.y, b.b.x - b.a.x) * 4
      sx += Math.cos(a) * b.length
      sy += Math.sin(a) * b.length
    }
    const main = Math.atan2(sy, sx) / 4
    const offMain = (b: Band) => {
      const d = (((Math.atan2(b.b.y - b.a.y, b.b.x - b.a.x) - main) % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2)
      return Math.min(d, Math.PI / 2 - d)
    }
    kept = kept.filter((b) => offMain(b) <= (4 * Math.PI) / 180 || b.length >= 6 * b.thickness)
  }

  // Short pieces (a pier between two windows, a jamb) are kept when they line up with a wall:
  // same line, similar thickness. A lone dark square isn't a wall.
  const inLine = (s: Band, b: Band) => {
    const len = dist(b.a, b.b) || 1
    const ux = (b.b.x - b.a.x) / len
    const uy = (b.b.y - b.a.y) / len
    const sx = (s.b.x - s.a.x) / (dist(s.a, s.b) || 1)
    const sy = (s.b.y - s.a.y) / (dist(s.a, s.b) || 1)
    if (Math.abs(sx * ux + sy * uy) < 0.98) return false
    const mid = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 }
    const across = Math.abs(-(mid.x - b.a.x) * uy + (mid.y - b.a.y) * ux)
    return across <= 0.2 * b.thickness && Math.abs(s.thickness - b.thickness) <= 0.25 * b.thickness
  }
  for (const s of all) {
    if (s.length >= 1.2 * s.thickness || s.length < 0.5 * s.thickness || s.length < tMin) continue
    if (kept.some((b) => inLine(s, b))) kept.push(s)
  }
  return kept
}

/**
 * Outlined walls: two thin parallel lines with nothing between. In every column (and row), each
 * pair of neighbouring thin lines a wall-thickness apart is filled. Evenly spaced triples (window
 * glazing: two faces and a middle line) are left alone, so windows stay gaps in the wall.
 */
function outlineFill(lines: Uint8Array, w: number, h: number, gMin: number, gMax: number, lineMax: number): Uint8Array {
  const out = new Uint8Array(w * h)
  const scan = (count: number, len: number, idx: (line: number, k: number) => number) => {
    for (let line = 0; line < count; line++) {
      // Crossings of thin lines along this column/row; long runs (lines running along it) break the sequence.
      const runs: [number, number][] = []
      let k = 0
      while (k < len) {
        if (!lines[idx(line, k)]) {
          k++
          continue
        }
        const s = k
        while (k < len && lines[idx(line, k)]) k++
        if (k - s <= lineMax) runs.push([s, k - 1])
        else runs.push([-1, -1]) // a barrier
      }
      for (let i = 0; i + 1 < runs.length; i++) {
        const [s0, e0] = runs[i]
        const [s1, e1] = runs[i + 1]
        if (s0 < 0 || s1 < 0) continue
        const gap = s1 - e0 - 1
        if (gap < gMin || gap > gMax) continue
        const before = i > 0 && runs[i - 1][0] >= 0 ? s0 - runs[i - 1][1] - 1 : Infinity
        const after = i + 2 < runs.length && runs[i + 2][0] >= 0 ? runs[i + 2][0] - e1 - 1 : Infinity
        // Another line about as close on either side: glazing or furniture, not a wall's two faces.
        if (before <= gap * 1.3 || after <= gap * 1.3) continue
        for (let q = s0; q <= e1; q++) out[idx(line, q)] = 1
      }
    }
  }
  scan(w, h, (x, y) => y * w + x) // columns: fills horizontal walls
  scan(h, w, (y, x) => y * w + x) // rows: fills vertical walls
  return out
}

export interface GapEvidence {
  from: number // the opening's stretch along the gap, in pixels from A (from === to: all wall)
  to: number
  glass: number // share of that stretch with glazing lines
  lines: number // separate lines running along that stretch (faces included)
  arc: number // best share of a door swing found over that stretch (0..1)
  leaf: number // share of a door leaf found along the best swing's start
  gapPx: number
}

/** Pixel lookups with a small tolerance (r pixels around the point). */
function sampler(pic: Picture) {
  const { w, h } = pic
  return (m: Uint8Array, x: number, y: number, r: number) => {
    const cx = Math.round(x)
    const cy = Math.round(y)
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const px = cx + dx
        const py = cy + dy
        if (px >= 0 && py >= 0 && px < w && py < h && m[py * w + px]) return true
      }
    }
    return false
  }
}

const steps = (k: number) => Array.from({ length: k }, (_, i) => (i + 0.5) / k)

/**
 * A door's quarter-circle swing and leaf from either end of an opening (A to B), on either side
 * of the wall. Door frames move the swing's centre a little away from the wall's corner and make
 * the leaf narrower than the opening, so nearby centres and radii are tried.
 */
function doorEvidence(pic: Picture, A: Vec2, B: Vec2, t: number) {
  const at = sampler(pic)
  const gap = dist(A, B)
  const u = { x: (B.x - A.x) / gap, y: (B.y - A.y) / gap }
  const n = { x: -u.y, y: u.x }
  const frac = (pts: Vec2[], r: number) => pts.filter((p) => at(pic.thin, p.x, p.y, r)).length / pts.length
  let arc = 0
  let leaf = 0
  for (const [hinge, along] of [[A, u], [B, { x: -u.x, y: -u.y }]] as const) {
    for (const side of [1, -1]) {
      const out = { x: n.x * side, y: n.y * side }
      for (const inset of [0, 0.05, 0.1]) {
        for (const lift of [-0.25, 0, 0.25]) {
          // The swing's centre: the jamb on the wall's face, moved a little into the gap / across.
          const c = {
            x: hinge.x + along.x * gap * inset + out.x * t * (0.5 + lift),
            y: hinge.y + along.y * gap * inset + out.y * t * (0.5 + lift),
          }
          for (let f = 0.8; f <= 1.051; f += 0.05) {
            const r = gap * (1 - inset) * f
            const pts = steps(18).map((k) => {
              const th = (k * Math.PI) / 2
              return { x: c.x + r * (Math.cos(th) * out.x + Math.sin(th) * along.x), y: c.y + r * (Math.cos(th) * out.y + Math.sin(th) * along.y) }
            })
            const hits = frac(pts, 2)
            if (hits > arc) {
              arc = hits
              leaf = frac(steps(16).map((k) => ({ x: c.x + out.x * r * (0.1 + 0.85 * k), y: c.y + out.y * r * (0.1 + 0.85 * k) })), 1)
            }
          }
        }
      }
    }
  }
  return { arc, leaf }
}

/**
 * Measures what a gap in a wall (A to B, in picture pixels, wall thickness t) looks like. Walk
 * along it: each point is wall (dark, or only the wall's two face lines in an outlined plan),
 * glazing (a line running along the wall inside it), or open. The opening is the longest stretch
 * that isn't wall; a door swing and glazing are looked for over exactly that stretch.
 */
export function gapEvidence(pic: Picture, A: Vec2, B: Vec2, t: number): GapEvidence {
  const at = sampler(pic)
  const gap = dist(A, B)
  const u = { x: (B.x - A.x) / gap, y: (B.y - A.y) / gap }
  const n = { x: -u.y, y: u.x }
  const P = (s: number, o: number) => ({ x: A.x + u.x * s + n.x * o, y: A.y + u.y * s + n.y * o })

  // Is the wall around the gap filled (dark) or outlined?
  const beside = [-1, 1].flatMap((dir) =>
    steps(6).flatMap((k) => {
      const s = dir < 0 ? -(t * 0.5 + t * 1.5 * k) : gap + t * 0.5 + t * 1.5 * k
      return [-0.2, 0.2].map((f) => P(s, t * f))
    }),
  )
  const filled = beside.filter((p) => at(pic.dark, p.x, p.y, 0)).length / beside.length >= 0.5

  // Walk along the gap: W (wall), G (glazing) or O (open) at each point.
  const N = Math.max(10, Math.min(300, Math.round(gap / 2)))
  const states: ('W' | 'G' | 'O')[] = []
  for (let i = 0; i < N; i++) {
    const s = (gap * (i + 0.5)) / N
    const darkHere = [-0.3, 0, 0.3].filter((f) => {
      const q = P(s, t * f)
      return at(pic.dark, q.x, q.y, 0)
    }).length >= 2
    // A glazing line runs along the wall: ink here and 2 px before and after (diagonal hatching doesn't).
    // Kept 2.5 px clear of the faces (outlined walls draw their faces a few pixels thick), and
    // sampled every half pixel so even 1 px lines are hit without any tolerance.
    let inner = false
    for (let o = -(t / 2 - 2.5); o <= t / 2 - 2.5 && !inner; o += 0.5) {
      inner = [-2, 0, 2].every((d) => {
        const q = P(s + d, o)
        return at(pic.thin, q.x, q.y, 0)
      })
    }
    const f1 = P(s, t / 2)
    const f2 = P(s, -t / 2)
    const faces = at(pic.thin, f1.x, f1.y, 1) && at(pic.thin, f2.x, f2.y, 1)
    states.push(darkHere ? 'W' : inner ? 'G' : faces ? (filled ? 'G' : 'W') : 'O')
  }

  // The longest stretch that isn't wall (a single wall sample inside it is noise).
  const wallAt = (i: number) => states[i] === 'W' && !(i > 0 && i < N - 1 && states[i - 1] !== 'W' && states[i + 1] !== 'W')
  let best = { from: 0, to: 0 }
  let runStart = -1
  for (let i = 0; i <= N; i++) {
    const isWall = i === N || wallAt(i)
    if (!isWall && runStart < 0) runStart = i
    if (isWall && runStart >= 0) {
      if (i - runStart > best.to - best.from) best = { from: runStart, to: i }
      runStart = -1
    }
  }
  if (best.to - best.from < 3) return { from: 0, to: 0, glass: 0, lines: 0, arc: 0, leaf: 0, gapPx: gap }
  const from = (best.from / N) * gap
  const to = (best.to / N) * gap

  const glass = states.slice(best.from, best.to).filter((x) => x === 'G').length / (best.to - best.from)
  // Separate lines along the stretch, faces included (glazing is often drawn on the faces).
  let lines = 0
  let inLine = false
  for (let o = -t / 2 - 1; o <= t / 2 + 1; o += 1) {
    const pts = steps(20).map((k) => P(from + (to - from) * k, o))
    const isLine = pts.filter((q) => at(pic.thin, q.x, q.y, 1)).length / pts.length >= 0.6
    if (isLine && !inLine) lines++
    inLine = isLine
  }
  const door = doorEvidence(pic, P(from, 0), P(to, 0), t)
  return { from, to, glass, lines, arc: door.arc, leaf: door.leaf, gapPx: gap }
}

/**
 * Decides what a gap in a wall is from the picture (see gapEvidence). `toPx` maps plan units to
 * picture pixels; `pxPerUnit` scales lengths.
 */
export function pictureGapClassifier(pic: Picture, toPx: (p: Vec2) => Vec2, pxPerUnit: number): GapClassifier {
  return (a, b, thickness) => {
    const A = toPx(a)
    const B = toPx(b)
    if (dist(A, B) < 3) return { kind: 'none' }
    const e = gapEvidence(pic, A, B, thickness * pxPerUnit)
    const from = e.from / pxPerUnit
    const to = e.to / pxPerUnit
    // No opening along it, or one too narrow for a door: wall drawn in pieces (or another style).
    if (to - from < 40) return { kind: 'wall' }
    if (e.arc >= 0.6 || (e.leaf >= 0.8 && e.arc >= 0.35)) return { kind: 'door', from, to }
    // Glazing is usually drawn with two or more lines; a single line is only trusted across a
    // small window, since across a wide gap it's more likely a boundary or a step.
    if (e.glass >= 0.5 && (e.lines >= 2 || to - from <= 150)) return { kind: 'window', from, to }
    // An empty gap is left open: in a picture it's usually a corridor or open plan, and a wall
    // invented across it would be worse than a missing one.
    return { kind: 'none' }
  }
}
