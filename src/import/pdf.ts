import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { applyAffine, composeAffine, type Affine } from '../model/geometry'
import type { Segment, Vec2 } from '../model/types'
import { makeBackground } from './image'
import { emptyResult, makeParts, type ImportResult } from './types'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const MAX_RENDER_SIDE = 3000 // px
const MAX_LINES = 100_000
// One PDF point at the common architectural scale 1:100, in real centimetres.
const CM_PER_POINT_AT_1_TO_100 = (2.54 / 72) * 100

// pdf.js path commands inside a constructPath operation.
const DRAW = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 }

export async function importPdf(file: File, pageIndex: number): Promise<ImportResult> {
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  const doc = await task.promise
  try {
    const names = Array.from({ length: doc.numPages }, (_, i) => `Page ${i + 1}`)
    const parts = makeParts('Page', names, pageIndex)
    const page = await doc.getPage((parts?.index ?? 0) + 1)

    const base = page.getViewport({ scale: 1 })
    const scale = Math.min(4, MAX_RENDER_SIDE / Math.max(base.width, base.height))
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvas, canvasContext: ctx, viewport }).promise

    // Guess 1:100 until I calibrate. Lines are extracted in render pixels, then converted.
    const cmPerPx = CM_PER_POINT_AT_1_TO_100 / scale
    const lines = (await extractLines(page, viewport.transform as Affine, scale)).map((l) => ({
      ...l,
      a: { x: l.a.x * cmPerPx, y: l.a.y * cmPerPx },
      b: { x: l.b.x * cmPerPx, y: l.b.y * cmPerPx },
    }))

    // Text: where each piece of writing's middle is, in plan cm.
    const texts: { text: string; at: Vec2 }[] = []
    const content = await page.getTextContent()
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue
      const m = pdfjs.Util.transform(viewport.transform, item.transform)
      const x = m[4] + (item.width * scale) / 2
      const y = m[5] - (item.height * scale) / 2
      texts.push({ text: item.str.trim(), at: { x: x * cmPerPx, y: y * cmPerPx } })
    }

    return {
      ...emptyResult('pdf'),
      background: await makeBackground(canvas.toDataURL('image/png'), cmPerPx),
      lines,
      texts,
      parts,
      note: lines.length
        ? `Found ${lines.length} vector lines. Scale assumed 1:100. Calibrate to be sure.`
        : 'This PDF is a scanned picture (no vector lines). Scale assumed 1:100. Calibrate to be sure.',
    }
  } finally {
    await task.destroy()
  }
}

/** The drawing style in effect, saved and restored together with the transform. */
interface GState {
  ctm: Affine
  stroke: string
  fill: string
  lineWidth: number
}

/**
 * Walks the page's drawing operations and collects every straight line, in render pixels.
 * PDFs have no real layers, but plans are usually drawn with one colour and pen width per kind
 * of thing (walls, furniture, dimensions, text), so each style becomes a layer.
 */
async function extractLines(page: pdfjs.PDFPageProxy, viewportTransform: Affine, pxPerPoint: number): Promise<Segment[]> {
  const ops = await page.getOperatorList()
  const OPS = pdfjs.OPS
  const lines: Segment[] = []
  const stack: GState[] = []
  let gs: GState = { ctm: viewportTransform, stroke: '#000000', fill: '#000000', lineWidth: 1 }

  const layerFor = (paintOp: number) => {
    if (paintOp === OPS.fill || paintOp === OPS.eoFill) return `${colorName(gs.fill)} filled shapes`
    // Pen width as printed on paper, in mm, rounded so near-equal widths share a layer.
    const scale = Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2]))
    const mm = (gs.lineWidth * scale * MM_PER_POINT) / pxPerPoint
    const width = mm < 0.05 ? 'hairlines' : `lines ${(Math.round(mm * 20) / 20).toFixed(2)} mm`
    return `${colorName(gs.stroke)} ${width}`
  }

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]
    const args = ops.argsArray[i]
    if (fn === OPS.save) stack.push({ ...gs })
    else if (fn === OPS.restore) gs = stack.pop() ?? gs
    else if (fn === OPS.transform) gs.ctm = composeAffine(gs.ctm, args as Affine)
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push({ ...gs })
      if (args[0]) gs.ctm = composeAffine(gs.ctm, args[0] as Affine)
    } else if (fn === OPS.paintFormXObjectEnd) gs = stack.pop() ?? gs
    else if (fn === OPS.setStrokeRGBColor) gs.stroke = hexColor(args)
    else if (fn === OPS.setFillRGBColor) gs.fill = hexColor(args)
    else if (fn === OPS.setLineWidth) gs.lineWidth = args[0] as number
    else if (fn === OPS.setGState) {
      for (const [key, value] of args[0] as [string, unknown][]) if (key === 'LW') gs.lineWidth = value as number
    } else if (fn === OPS.constructPath) {
      const paintOp = args[0] as number
      if (paintOp === OPS.endPath) continue // clipping paths, not visible
      const data = (args[1] as ArrayLike<number>[] | undefined)?.[0]
      if (!data) continue
      const layer = layerFor(paintOp)
      const ctm = gs.ctm
      walkPath(data, (a, b) => {
        if (lines.length >= MAX_LINES) return
        const pa = applyAffine(ctm, a.x, a.y)
        const pb = applyAffine(ctm, b.x, b.y)
        if (Math.hypot(pa.x - pb.x, pa.y - pb.y) >= 2) lines.push({ a: pa, b: pb, layer })
      })
    }
  }
  return lines
}

const MM_PER_POINT = 25.4 / 72

/** pdf.js passes colours as "#rrggbb" or as [r, g, b] bytes, depending on version. */
function hexColor(args: unknown[]): string {
  const c = args.length === 1 ? args[0] : args
  if (typeof c === 'string') return c.toLowerCase()
  const [r, g, b] = Array.from(c as ArrayLike<number>)
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
}

/** A plain colour name, so layers read like "Green lines 0.25 mm". */
function colorName(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16)
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  if (max - min < 30) return max < 60 ? 'Black' : max > 220 ? 'White' : 'Grey'
  const hue = (() => {
    const d = max - min
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    return (h * 60 + 360) % 360
  })()
  const names: [number, string][] = [[15, 'Red'], [45, 'Orange'], [70, 'Yellow'], [165, 'Green'], [195, 'Cyan'], [255, 'Blue'], [290, 'Purple'], [335, 'Pink'], [360, 'Red']]
  return names.find(([limit]) => hue < limit)![1]
}

function walkPath(data: ArrayLike<number>, add: (a: Vec2, b: Vec2) => void) {
  let current: Vec2 = { x: 0, y: 0 }
  let start: Vec2 = current
  for (let i = 0; i < data.length; ) {
    switch (data[i++]) {
      case DRAW.moveTo:
        current = start = { x: data[i++], y: data[i++] }
        break
      case DRAW.lineTo: {
        const next = { x: data[i++], y: data[i++] }
        add(current, next)
        current = next
        break
      }
      case DRAW.curveTo: // curves are usually door swings; skip them but keep the position
        i += 4
        current = { x: data[i++], y: data[i++] }
        break
      case DRAW.quadraticCurveTo:
        i += 2
        current = { x: data[i++], y: data[i++] }
        break
      case DRAW.closePath:
        add(current, start)
        current = start
        break
      default:
        return // unknown command: stop rather than read garbage
    }
  }
}
