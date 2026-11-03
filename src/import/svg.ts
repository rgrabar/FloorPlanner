import type { Segment, Vec2 } from '../model/types'
import { makeBackground, UNKNOWN_SCALE_NOTE } from './image'
import { emptyResult, ImportError, type ImportResult } from './types'

const MIN_SIDE = 2000 // render small SVGs bigger so the background stays sharp

export async function importSvg(file: File): Promise<ImportResult> {
  const text = await file.text()
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const root = doc.documentElement
  if (root.nodeName !== 'svg' || doc.querySelector('parsererror')) {
    throw new ImportError(`"${file.name}" isn't a valid SVG file.`)
  }

  // Work out the drawing's own coordinate box (its user units).
  const vb = root.getAttribute('viewBox')?.split(/[\s,]+/).map(Number)
  const w0 = parseFloat(root.getAttribute('width') ?? '') || vb?.[2] || 1000
  const h0 = parseFloat(root.getAttribute('height') ?? '') || vb?.[3] || 1000
  const box = vb && vb.length === 4 && vb.every(Number.isFinite) ? vb : [0, 0, w0, h0]
  const pxPerUnit = Math.max(1, MIN_SIDE / Math.max(box[2], box[3]))
  const widthPx = Math.round(box[2] * pxPerUnit)
  const heightPx = Math.round(box[3] * pxPerUnit)
  root.setAttribute('viewBox', box.join(' '))
  root.setAttribute('width', String(widthPx))
  root.setAttribute('height', String(heightPx))

  const serialized = new XMLSerializer().serializeToString(root)
  const src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(serialized)))
  const background = await makeBackground(src)

  // The browser resolves transforms for us once the SVG is in the page.
  const host = document.createElement('div')
  host.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden'
  host.innerHTML = serialized
  document.body.appendChild(host)
  try {
    const svg = host.querySelector('svg')!
    const lines = extractLines(svg)
    return {
      ...emptyResult('svg'),
      background,
      lines,
      note: `${lines.length ? `Found ${lines.length} lines. ` : ''}${UNKNOWN_SCALE_NOTE}`,
    }
  } finally {
    host.remove()
  }
}

function extractLines(svg: SVGSVGElement): Segment[] {
  const lines: Segment[] = []
  const rootInverse = svg.getScreenCTM()?.inverse()
  if (!rootInverse) return lines

  for (const el of svg.querySelectorAll<SVGGraphicsElement>('line, polyline, polygon, rect, path')) {
    const ctm = el.getScreenCTM()
    if (!ctm) continue
    const m = rootInverse.multiply(ctm) // element units -> rendered pixels
    const toPx = (x: number, y: number): Vec2 => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f })
    const layer = layerName(el)
    const add = (a: Vec2, b: Vec2) => {
      if (Math.hypot(a.x - b.x, a.y - b.y) >= 1) lines.push({ a, b, layer })
    }
    for (const poly of shapePolylines(el)) {
      for (let i = 1; i < poly.length; i++) add(toPx(poly[i - 1].x, poly[i - 1].y), toPx(poly[i].x, poly[i].y))
    }
  }
  return lines
}

/** The nearest named group, so lines can be shown or hidden per group. */
function layerName(el: Element): string {
  for (let p = el.parentElement; p && p.nodeName !== 'svg'; p = p.parentElement) {
    const name = p.getAttribute('inkscape:label') ?? p.getAttribute('id')
    if (p.nodeName === 'g' && name) return name
  }
  return 'SVG'
}

function num(el: Element, attr: string) {
  return parseFloat(el.getAttribute(attr) ?? '0') || 0
}

function shapePolylines(el: Element): Vec2[][] {
  switch (el.nodeName) {
    case 'line':
      return [[{ x: num(el, 'x1'), y: num(el, 'y1') }, { x: num(el, 'x2'), y: num(el, 'y2') }]]
    case 'polyline':
    case 'polygon': {
      const n = (el.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number)
      const pts: Vec2[] = []
      for (let i = 0; i + 1 < n.length; i += 2) pts.push({ x: n[i], y: n[i + 1] })
      if (el.nodeName === 'polygon' && pts.length > 2) pts.push(pts[0])
      return [pts]
    }
    case 'rect': {
      const x = num(el, 'x'), y = num(el, 'y'), w = num(el, 'width'), h = num(el, 'height')
      return [[{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }]]
    }
    case 'path':
      return pathPolylines(el.getAttribute('d') ?? '')
  }
  return []
}

/** Reads the straight parts of an SVG path. Curves only move the pen (they're usually door swings). */
function pathPolylines(d: string): Vec2[][] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? []
  const result: Vec2[][] = []
  let poly: Vec2[] = []
  let cur: Vec2 = { x: 0, y: 0 }
  let start: Vec2 = cur
  let cmd = ''
  let i = 0
  const next = () => parseFloat(tokens[i++])
  const finish = () => {
    if (poly.length > 1) result.push(poly)
    poly = []
  }
  const lineTo = (p: Vec2) => {
    if (!poly.length) poly.push(cur)
    poly.push(p)
    cur = p
  }
  const moveTo = (p: Vec2) => {
    finish()
    cur = start = p
  }
  // Number of values each command takes.
  const arity: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 }

  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++]
    const lower = cmd.toLowerCase()
    if (!(lower in arity)) return result
    const rel = cmd !== cmd.toUpperCase()
    const ox = rel ? cur.x : 0
    const oy = rel ? cur.y : 0
    if (lower === 'z') {
      if (poly.length) lineTo(start)
      finish()
      cur = start
      cmd = ''
      continue
    }
    if (i + arity[lower] > tokens.length) break
    switch (lower) {
      case 'm':
        moveTo({ x: ox + next(), y: oy + next() })
        cmd = rel ? 'l' : 'L' // extra pairs after M are line-tos
        break
      case 'l':
        lineTo({ x: ox + next(), y: oy + next() })
        break
      case 'h':
        lineTo({ x: ox + next(), y: cur.y })
        break
      case 'v':
        lineTo({ x: cur.x, y: oy + next() })
        break
      default: {
        // c, s, q, t, a: skip to the end point
        i += arity[lower] - 2
        finish()
        cur = { x: ox + next(), y: oy + next() }
      }
    }
  }
  finish()
  return result
}
