// Reads a picture's scale from the numbers printed around the plan.
//
// Most plans have either a ruler (0, 100, 200 … along the edges) or chains of dimensions
// (104 · 377 · 189 … between ticks, each number in the middle of its part). Either way, along a
// row of numbers the distances on the picture follow their values:
//   ruler:  x[i+1] - x[i] = k · (v[i+1] - v[i])
//   chain:  x[i+1] - x[i] = k · (v[i] + v[i+1]) / 2
// where k is picture pixels per unit. Many numbers agreeing on one k make it reliable. The unit
// (cm, mm) is the one that agrees with a rough estimate (from the doors or walls).

/** A number found on the plan: its value and the middle of its text, in picture pixels. */
export interface PlacedNumber {
  value: number
  x: number
  y: number
  size: number // text height, px
  vertical: boolean // written turned 90° (dimensions along a vertical line)
}

export interface ScaleReading {
  pxPerUnit: number
  numbers: number // how many numbers agree
  kind: 'ruler' | 'dimensions'
}

// Plan numbers are small: smaller pictures are enlarged before reading.
const zoomFor = (w: number, h: number) => (Math.max(w, h) < 2500 ? 2 : 1.25)

/**
 * Numbers in the margins around the building (`building` in picture pixels): where rulers and
 * dimension chains are. Side margins are also read turned, for vertical dimension text.
 */
export async function readMarginNumbers(src: string, building: { x0: number; y0: number; x1: number; y1: number }): Promise<{ numbers: PlacedNumber[]; w: number; h: number }> {
  const img = new Image()
  img.src = src
  await img.decode()
  const w = img.naturalWidth
  const h = img.naturalHeight
  const ZOOM = zoomFor(w, h)
  const pad = 4
  // Dimension chains run close along the building; further out are titles and legends.
  const reach = Math.max(250, Math.round(Math.max(w, h) * 0.12))
  const strips = [
    { x0: 0, y0: Math.max(0, building.y0 - reach), x1: w, y1: building.y0 + pad, turn: false },
    { x0: 0, y0: building.y1 - pad, x1: w, y1: Math.min(h, building.y1 + reach), turn: false },
    { x0: Math.max(0, building.x0 - reach), y0: 0, x1: building.x0 + pad, y1: h, turn: false },
    { x0: building.x1 - pad, y0: 0, x1: Math.min(w, building.x1 + reach), y1: h, turn: false },
    { x0: Math.max(0, building.x0 - reach), y0: 0, x1: building.x0 + pad, y1: h, turn: true },
    { x0: building.x1 - pad, y0: 0, x1: Math.min(w, building.x1 + reach), y1: h, turn: true },
  ].filter((s) => s.x1 - s.x0 >= 16 && s.y1 - s.y0 >= 16)
  if (!strips.length) return { numbers: [], w, h }

  const numbers: PlacedNumber[] = []
  const { createWorker, PSM } = await import('tesseract.js')
  const worker = await createWorker('eng')
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, tessedit_char_whitelist: '0123456789' })
    for (const s of strips) {
      const sw = s.x1 - s.x0
      const sh = s.y1 - s.y0
      const c = document.createElement('canvas')
      // Turned strips are read with their text upright: rotated a quarter turn clockwise, so
      // text running up the page reads left to right.
      c.width = (s.turn ? sh : sw) * ZOOM
      c.height = (s.turn ? sw : sh) * ZOOM
      const ctx = c.getContext('2d')!
      ctx.fillStyle = 'white'
      ctx.fillRect(0, 0, c.width, c.height)
      if (s.turn) {
        ctx.translate(c.width, 0)
        ctx.rotate(Math.PI / 2)
      }
      ctx.drawImage(img, s.x0, s.y0, sw, sh, 0, 0, sw * ZOOM, sh * ZOOM)
      stretchContrast(ctx, c.width, c.height)
      const { data } = await worker.recognize(c, {}, { blocks: true })
      for (const block of data.blocks ?? []) {
        for (const para of block.paragraphs) {
          for (const line of para.lines) {
            for (const word of line.words) {
              const text = word.text.trim()
              if (!/^\d{1,5}$/.test(text) || word.confidence < 50) continue
              const b = word.bbox
              const cx = (b.x0 + b.x1) / 2 / ZOOM
              const cy = (b.y0 + b.y1) / 2 / ZOOM
              const size = (b.y1 - b.y0) / ZOOM
              // Back to the picture: a turned strip's (cx, cy) is (down the strip from its top, in from its left).
              const x = s.turn ? s.x0 + cy : s.x0 + cx
              const y = s.turn ? s.y0 + (sh - cx) : s.y0 + cy
              numbers.push({ value: Number(text), x, y, size, vertical: s.turn })
            }
          }
        }
      }
    }
  } finally {
    await worker.terminate()
  }
  // The side strips are read twice (upright and turned): keep one of each number.
  const unique = numbers.filter((n, i) => !numbers.slice(0, i).some((m) => m.value === n.value && Math.hypot(m.x - n.x, m.y - n.y) < n.size))
  return { numbers: unique, w, h }
}

/**
 * Grey paper and faded ink (scans, photos) to white and black: the darkest 1 % of the strip
 * becomes black and its typical paper colour white.
 */
function stretchContrast(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  const hist = new Uint32Array(256)
  for (let i = 0; i < d.length; i += 4) hist[Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++
  const total = d.length / 4
  const at = (share: number) => {
    let acc = 0
    for (let v = 0; v < 256; v++) {
      acc += hist[v]
      if (acc >= total * share) return v
    }
    return 255
  }
  const lo = at(0.01)
  const hi = at(0.5) // most of a margin is paper
  if (hi - lo < 20) return
  for (let i = 0; i < d.length; i += 4) {
    const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    const out = Math.max(0, Math.min(255, ((v - lo) / (hi - lo)) * 255))
    d[i] = d[i + 1] = d[i + 2] = out
  }
  ctx.putImageData(img, 0, 0)
}

/**
 * The scale the numbers agree on, or null. Rows of numbers (horizontal text, or vertical text
 * stacked along a column) are fitted as rulers and as dimension chains. `tilt` (radians) is how
 * far the plan is turned on the picture (a crooked scan): rows follow the walls, not the page.
 */
export function scaleFromNumbers(placed: PlacedNumber[], tilt = 0): ScaleReading | null {
  const cos = Math.cos(-tilt)
  const sin = Math.sin(-tilt)
  const numbers = placed.map((n) => ({ ...n, x: n.x * cos - n.y * sin, y: n.x * sin + n.y * cos }))
  // Lines of numbers: same y for horizontal rows, same x for columns (rulers down the side, and
  // vertical dimension chains).
  const lines: { pos: number; value: number }[][] = []
  const group = (key: (n: PlacedNumber) => number, along: (n: PlacedNumber) => number, pick: (n: PlacedNumber) => boolean) => {
    const sorted = numbers.filter(pick).sort((a, b) => key(a) - key(b))
    let current: PlacedNumber[] = []
    const flush = () => {
      if (current.length >= 2) lines.push(current.map((n) => ({ pos: along(n), value: n.value })).sort((a, b) => a.pos - b.pos))
      current = []
    }
    for (const n of sorted) {
      if (current.length && Math.abs(key(n) - key(current[current.length - 1])) > Math.max(3, n.size * 0.6)) flush()
      current.push(n)
    }
    flush()
  }
  group((n) => n.y, (n) => n.x, (n) => !n.vertical) // rows of upright numbers
  group((n) => n.x, (n) => n.y, (n) => !n.vertical) // a ruler down the side (upright numbers in a column)
  group((n) => n.x, (n) => n.y, (n) => n.vertical) // vertical dimension chains

  const candidates: { k: number; support: number; kind: ScaleReading['kind'] }[] = []
  for (const line of lines) {
    // Ruler: neighbours' spacing over their difference in value.
    const ruler: number[] = []
    const chain: number[] = []
    for (let i = 0; i + 1 < line.length; i++) {
      const dx = Math.abs(line[i + 1].pos - line[i].pos)
      const dv = Math.abs(line[i + 1].value - line[i].value)
      if (dv > 0 && dx > 0) ruler.push(dx / dv)
      const sum = (line[i].value + line[i + 1].value) / 2
      if (sum > 0 && dx > 0) chain.push(dx / sum)
    }
    for (const [ks, kind] of [
      [ruler, 'ruler'],
      [chain, 'dimensions'],
    ] as const) {
      // Even one pair counts, when other lines agree with it (checked below).
      const best = agreeing(ks)
      if (best) candidates.push({ k: best.k, support: best.count + 1, kind })
    }
  }
  if (!candidates.length) return null
  // Lines that agree with each other add up.
  let pick: ScaleReading | null = null
  for (const c of candidates) {
    const agree = candidates.filter((o) => Math.abs(o.k / c.k - 1) < 0.03)
    const support = agree.reduce((t, o) => t + o.support, 0)
    if (!pick || support > pick.numbers) {
      const k = agree.reduce((t, o) => t + o.k * o.support, 0) / support
      pick = { pxPerUnit: k, numbers: support, kind: c.kind }
    }
  }
  return pick && pick.numbers >= 4 ? pick : null
}

/** The value most of `ks` agree on (within 4 %), and how many agree. */
function agreeing(ks: number[]): { k: number; count: number } | null {
  let best: { k: number; count: number } | null = null
  for (const k of ks) {
    const near = ks.filter((o) => Math.abs(o / k - 1) < 0.04)
    if (!best || near.length > best.count) best = { k: near.reduce((t, o) => t + o, 0) / near.length, count: near.length }
  }
  return best
}

/**
 * Centimetres per picture pixel from a reading, in the unit (cm or mm) closest to a rough
 * estimate; null when neither is within a factor of 1.6 of it (the numbers measure something else).
 */
export function cmPerPxFrom(reading: ScaleReading, roughCmPerPx: number): number | null {
  let best: number | null = null
  for (const unitCm of [1, 0.1]) {
    const c = unitCm / reading.pxPerUnit
    const off = Math.abs(Math.log(c / roughCmPerPx))
    if (off < Math.log(1.6) && (best === null || off < Math.abs(Math.log(best / roughCmPerPx)))) best = c
  }
  return best
}
