import { modelForLabel } from './furniture'
import type { PictureForFurniture, PicturePatch } from './furniturePicture'

// Reads the names written on furniture patches ("MALM", "Kitchen base", "Fridge") with OCR.
// Tesseract (and its English language data) is only loaded when a picture has patches with
// writing in them. Without it, or when it can't be loaded, furniture is judged by size alone.

const ZOOM = 3 // plan text is small: enlarge before reading

export async function readLabels(pic: PictureForFurniture, patches: PicturePatch[]): Promise<void> {
  const withText = patches.filter((p) => hasWriting(pic, p))
  if (!withText.length) return
  let worker: Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>> | null = null
  try {
    const { createWorker, PSM } = await import('tesseract.js')
    worker = await createWorker('eng')
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK })
    for (const p of withText) {
      // Names are written dark, or light with a dark edge: read both ways, keep the surer one.
      let best = { text: '', confidence: 0 }
      for (const light of [false, true]) {
        const { data } = await worker.recognize(cropForReading(pic, p, light))
        const text = tidy(data.text)
        if (text.length >= 2 && data.confidence > best.confidence) best = { text, confidence: data.confidence }
        if (best.confidence >= 80) break
      }
      // A furniture word read with less confidence still counts: stray marks at the edges lower it.
      if (best.confidence >= 40 || (best.confidence >= 20 && modelForLabel(best.text))) p.shape.label = best.text
    }
  } catch (e) {
    console.warn('Could not read the names on the furniture', e)
  } finally {
    await worker?.terminate()
  }
}

/** Dark pixels inside the patch (away from its edges): something is written there. */
function hasWriting(pic: PictureForFurniture, p: PicturePatch): boolean {
  const { x0, y0, x1, y1 } = p.px
  const m = 3
  let dark = 0
  for (let y = y0 + m; y <= y1 - m; y++) {
    for (let x = x0 + m; x <= x1 - m; x++) {
      const i = (y * pic.w + x) * 4
      if (0.299 * pic.rgba[i] + 0.587 * pic.rgba[i + 1] + 0.114 * pic.rgba[i + 2] < 110) dark++
    }
  }
  return dark >= 15
}

/** The inside of the patch, enlarged, as black writing on white. */
function cropForReading(pic: PictureForFurniture, p: PicturePatch, light: boolean): HTMLCanvasElement {
  const { x0, y0, x1, y1 } = p.px
  const m = 2 // skip the patch's outline
  const w = Math.max(1, x1 - x0 + 1 - 2 * m)
  const h = Math.max(1, y1 - y0 + 1 - 2 * m)
  const pad = 10
  const c = document.createElement('canvas')
  c.width = w * ZOOM + 2 * pad
  c.height = h * ZOOM + 2 * pad
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(pic.canvas, x0 + m, y0 + m, w, h, pad, pad, w * ZOOM, h * ZOOM)
  const img = ctx.getImageData(0, 0, c.width, c.height)
  const d = img.data
  const lum = (i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
  // Light writing: clearly lighter than the patch's own colour (its median).
  let limit = 0
  if (light) {
    const values: number[] = []
    for (let y = pad; y < c.height - pad; y += 3) for (let x = pad; x < c.width - pad; x += 3) values.push(lum((y * c.width + x) * 4))
    values.sort((a, b) => a - b)
    limit = values[values.length >> 1] + 30
  }
  for (let i = 0; i < d.length; i += 4) {
    const x = (i / 4) % c.width
    const y = Math.floor(i / 4 / c.width)
    const inside = x >= pad && y >= pad && x < c.width - pad && y < c.height - pad
    const ink = inside && (light ? lum(i) > limit : lum(i) < 120)
    d[i] = d[i + 1] = d[i + 2] = ink ? 0 : 255
  }
  ctx.putImageData(img, 0, 0)
  return c
}

/** OCR's stray marks out: keep words (two letters or more) and sizes like 160x80. */
function tidy(text: string): string {
  return text
    .split(/\s+/)
    .filter((t) => /\p{L}.*\p{L}|\d/u.test(t))
    .map((t) => t.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, ''))
    .filter(Boolean)
    .join(' ')
}
