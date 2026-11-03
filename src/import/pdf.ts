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
    const lines = (await extractLines(page, viewport.transform as Affine)).map((l) => ({
      ...l,
      a: { x: l.a.x * cmPerPx, y: l.a.y * cmPerPx },
      b: { x: l.b.x * cmPerPx, y: l.b.y * cmPerPx },
    }))

    return {
      ...emptyResult('pdf'),
      background: await makeBackground(canvas.toDataURL('image/png'), cmPerPx),
      lines,
      parts,
      note: lines.length
        ? `Found ${lines.length} vector lines. Scale assumed 1:100. Calibrate to be sure.`
        : 'This PDF is a scanned picture (no vector lines). Scale assumed 1:100. Calibrate to be sure.',
    }
  } finally {
    await task.destroy()
  }
}

/** Walks the page's drawing operations and collects every straight line, in render pixels. */
async function extractLines(page: pdfjs.PDFPageProxy, viewportTransform: Affine): Promise<Segment[]> {
  const ops = await page.getOperatorList()
  const OPS = pdfjs.OPS
  const lines: Segment[] = []
  const stack: Affine[] = []
  let ctm: Affine = viewportTransform

  const add = (a: Vec2, b: Vec2) => {
    if (lines.length >= MAX_LINES) return
    const pa = applyAffine(ctm, a.x, a.y)
    const pb = applyAffine(ctm, b.x, b.y)
    if (Math.hypot(pa.x - pb.x, pa.y - pb.y) >= 2) lines.push({ a: pa, b: pb, layer: 'PDF lines' })
  }

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]
    const args = ops.argsArray[i]
    if (fn === OPS.save) stack.push(ctm)
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm
    else if (fn === OPS.transform) ctm = composeAffine(ctm, args as Affine)
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm)
      if (args[0]) ctm = composeAffine(ctm, args[0] as Affine)
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm
    else if (fn === OPS.constructPath) {
      const paintOp = args[0] as number
      if (paintOp === OPS.endPath) continue // clipping paths, not visible
      const data = (args[1] as ArrayLike<number>[] | undefined)?.[0]
      if (data) walkPath(data, add)
    }
  }
  return lines
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
