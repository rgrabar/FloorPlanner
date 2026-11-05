import { minAreaRect, projectOnWall } from '../model/geometry'
import type { Vec2, Wall } from '../model/types'
import { boxOf, type Shape } from './furniture'

// Furniture in pictures of exported plans: solid coloured rectangles (often with a name written
// in them) on lighter room colours. Each patch of one colour becomes a shape; dark lines between
// pieces of the same colour (kitchen units side by side) keep them apart.

const MAX_SIDE = 3000

export interface PicturePatch {
  shape: Shape
  // The patch in picture pixels, for reading its label.
  px: { x0: number; y0: number; x1: number; y1: number }
}

export interface PictureForFurniture {
  w: number
  h: number
  rgba: Uint8ClampedArray
  scale: number // picture pixels per source pixel
  canvas: HTMLCanvasElement
}

export async function loadColours(src: string): Promise<PictureForFurniture> {
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
  return { w, h, rgba: ctx.getImageData(0, 0, w, h).data, scale, canvas }
}

/**
 * Solid patches of furniture colour: not paper or pale room colour, not dark ink. `cmPerPx` is
 * the size of a picture pixel, `toPlan` converts picture pixels to plan cm.
 */
export function patchesFromPicture(pic: PictureForFurniture, cmPerPx: number, toPlan: (p: Vec2) => Vec2): PicturePatch[] {
  const { w, h, rgba } = pic
  const lum = (i: number) => 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]
  // Mid tones only: paper and room colours are lighter, walls, lines and text darker.
  const candidate = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const l = lum(i)
    candidate[i] = l >= 95 && l <= 218 ? 1 : 0
  }

  // 1. Patches of one colour.
  const label = new Int32Array(w * h).fill(-1)
  const stack: number[] = []
  const found: Patch[] = []
  const TOL = 24 // how far (0–255, per channel) a pixel may be from the patch's average colour
  let next = 0
  for (let start = 0; start < w * h; start++) {
    if (!candidate[start] || label[start] >= 0) continue
    const id = next++
    let r = 0, g = 0, b = 0, count = 0
    let x0 = w, y0 = h, x1 = 0, y1 = 0
    label[start] = id
    stack.push(start)
    while (stack.length) {
      const i = stack.pop()!
      const x = i % w
      const y = (i - x) / w
      r += rgba[i * 4]
      g += rgba[i * 4 + 1]
      b += rgba[i * 4 + 2]
      count++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      const mr = r / count, mg = g / count, mb = b / count
      const visit = (j: number) => {
        if (!candidate[j] || label[j] >= 0) return
        if (Math.max(Math.abs(rgba[j * 4] - mr), Math.abs(rgba[j * 4 + 1] - mg), Math.abs(rgba[j * 4 + 2] - mb)) > TOL) return
        label[j] = id
        stack.push(j)
      }
      if (x > 0) visit(i - 1)
      if (x < w - 1) visit(i + 1)
      if (y > 0) visit(i - w)
      if (y < h - 1) visit(i + w)
    }
    if (count >= 30) found.push({ x0, y0, x1, y1, count, color: [r / count, g / count, b / count] })
  }

  // 2. A name written right across a piece cuts it in two: join same-coloured neighbours that
  // only writing separates (not a dark line, which is the edge between two pieces).
  const merged = joinAcrossWriting(found, pic, 8 / cmPerPx)

  // 3. Rectangles of furniture size.
  const patches: PicturePatch[] = []
  const minSide = 20 / cmPerPx // pieces are at least 20 cm across
  for (const { x0, y0, x1, y1, count } of merged) {
    const bw = x1 - x0 + 1
    const bh = y1 - y0 + 1
    if (bw < minSide || bh < minSide) continue
    // A rectangle: most of its box is this colour (text and inner details take the rest).
    if (count < bw * bh * 0.6) continue
    // Too big to be furniture: a room's floor colour.
    if (bw * cmPerPx > 450 || bh * cmPerPx > 450 || bw * bh * cmPerPx * cmPerPx > 7e4) continue
    const corners = [
      toPlan({ x: x0, y: y0 }),
      toPlan({ x: x1 + 1, y: y0 }),
      toPlan({ x: x1 + 1, y: y1 + 1 }),
      toPlan({ x: x0, y: y1 + 1 }),
    ]
    const points: Vec2[] = []
    for (let k = 0; k < 4; k++) {
      const a = corners[k]
      const c = corners[(k + 1) % 4]
      const n = Math.max(1, Math.ceil(Math.hypot(c.x - a.x, c.y - a.y)))
      for (let t = 0; t < n; t++) points.push({ x: a.x + ((c.x - a.x) * t) / n, y: a.y + ((c.y - a.y) * t) / n })
    }
    const wCm = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y)
    const hCm = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y)
    const center = { x: (corners[0].x + corners[2].x) / 2, y: (corners[0].y + corners[2].y) / 2 }
    const horizontal = { x: (corners[1].x - corners[0].x) / (wCm || 1), y: (corners[1].y - corners[0].y) / (wCm || 1) }
    const vertical = { x: (corners[3].x - corners[0].x) / (hCm || 1), y: (corners[3].y - corners[0].y) / (hCm || 1) }
    const box = wCm >= hCm ? { center, axis: horizontal, length: wCm, width: hCm } : { center, axis: vertical, length: hCm, width: wCm }
    patches.push({ shape: { points, box, filled: true }, px: { x0, y0, x1, y1 } })
  }
  return patches
}

interface Patch {
  x0: number
  y0: number
  x1: number
  y1: number
  count: number
  color: [number, number, number]
}

function joinAcrossWriting(list: Patch[], pic: PictureForFurniture, maxGap: number): Patch[] {
  const { w, rgba } = pic
  const dark = (x: number, y: number) => {
    const i = (y * w + x) * 4
    return 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2] < 110
  }
  const sameColor = (a: Patch, b: Patch) => Math.max(...a.color.map((v, k) => Math.abs(v - b.color[k]))) <= 20
  // Is there a dark line right across the gap (rows y0..y1 over columns x0..x1, or transposed)?
  const ruled = (vertical: boolean, from: number, to: number, lo: number, hi: number) => {
    for (let t = from; t <= to; t++) {
      let n = 0
      for (let k = lo; k <= hi; k++) if (vertical ? dark(k, t) : dark(t, k)) n++
      if (n >= (hi - lo + 1) * 0.85) return true
    }
    return false
  }
  const items = list.filter((p) => p.x1 - p.x0 >= 4 && p.y1 - p.y0 >= 2)
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < items.length && !changed; i++) {
      for (let j = 0; j < items.length && !changed; j++) {
        if (i === j) continue
        const a = items[i]
        const b = items[j]
        if (!sameColor(a, b)) continue
        const sameColumns = Math.abs(a.x0 - b.x0) <= 2 && Math.abs(a.x1 - b.x1) <= 2
        const sameRows = Math.abs(a.y0 - b.y0) <= 2 && Math.abs(a.y1 - b.y1) <= 2
        const gapDown = b.y0 - a.y1 - 1
        const gapRight = b.x0 - a.x1 - 1
        const join =
          (sameColumns && gapDown >= 0 && gapDown <= maxGap && !ruled(true, a.y1 + 1, b.y0 - 1, Math.max(a.x0, b.x0), Math.min(a.x1, b.x1))) ||
          (sameRows && gapRight >= 0 && gapRight <= maxGap && !ruled(false, a.x1 + 1, b.x0 - 1, Math.max(a.y0, b.y0), Math.min(a.y1, b.y1)))
        if (!join) continue
        const gapArea = sameColumns ? Math.max(0, gapDown) * (a.x1 - a.x0 + 1) : Math.max(0, gapRight) * (a.y1 - a.y0 + 1)
        items[i] = {
          x0: Math.min(a.x0, b.x0),
          y0: Math.min(a.y0, b.y0),
          x1: Math.max(a.x1, b.x1),
          y1: Math.max(a.y1, b.y1),
          count: a.count + b.count + gapArea,
          color: a.color.map((v, k) => (v * a.count + b.color[k] * b.count) / (a.count + b.count)) as Patch['color'],
        }
        items.splice(j, 1)
        changed = true
      }
    }
  }
  return items
}

/**
 * Furniture drawn as outlines in a picture: each connected piece of thin ink (lines that aren't
 * walls) becomes a shape. Ink on or right next to the walls is left out first, so a bed drawn
 * against a wall isn't joined to the wall's outline.
 */
export function shapesFromInk(
  thin: Uint8Array,
  w: number,
  h: number,
  unitsPerPx: number,
  toPlan: (p: Vec2) => Vec2,
  walls: Wall[],
): Shape[] {
  const mask = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    if (!thin[i]) continue
    const p = toPlan({ x: (i % w) + 0.5, y: Math.floor(i / w) + 0.5 })
    const onWall = walls.some((wall) => {
      const { t, d, length } = projectOnWall(p, wall)
      return t > -wall.thickness && t < length + wall.thickness && d < wall.thickness / 2 + 2
    })
    if (!onWall) mask[i] = 1
  }

  // Furniture stands square to the walls, unless it's clearly turned.
  const dir = wallDirection(walls)
  const seen = new Uint8Array(w * h)
  const shapes: Shape[] = []
  const stack: number[] = []
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || seen[start]) continue
    const pixels: number[] = []
    let x0 = w, y0 = h, x1 = 0, y1 = 0
    seen[start] = 1
    stack.push(start)
    while (stack.length) {
      const i = stack.pop()!
      pixels.push(i)
      const x = i % w
      const y = (i - x) / w
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const j = ny * w + nx
          if (mask[j] && !seen[j]) {
            seen[j] = 1
            stack.push(j)
          }
        }
      }
    }
    const longest = Math.max(x1 - x0 + 1, y1 - y0 + 1) * unitsPerPx
    if (pixels.length < 10 || longest < 20 || longest > 450) continue
    const points = pixels.map((i) => toPlan({ x: (i % w) + 0.5, y: Math.floor(i / w) + 0.5 }))
    const square = boxOf(points, dir)
    const turned = minAreaRect(points)
    const box = turned && square && turned.length * turned.width < square.length * square.width * 0.75 ? turned : square
    if (box) shapes.push(backToTheWall({ points, box }, walls))
  }
  return shapes
}

/** The direction most wall length runs in (modulo 90°). */
function wallDirection(walls: Wall[]): Vec2 {
  const bins = new Float64Array(90)
  for (const w of walls) {
    const deg = ((((Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x) * 180) / Math.PI) % 90) + 90) % 90
    bins[Math.round(deg) % 90] += Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
  }
  let best = 0
  for (let i = 1; i < 90; i++) if (bins[i] > bins[best]) best = i
  const r = (best * Math.PI) / 180
  return { x: Math.cos(r), y: Math.sin(r) }
}

/**
 * A piece against a wall loses its back edge with the wall's own lines. When a side of the
 * shape stops just short of a wall all along, it's put back: out to the wall's face.
 */
function backToTheWall(s: Shape, walls: Wall[]): Shape {
  const { box } = s
  const a = box.axis
  const n = { x: -a.y, y: a.x }
  const sides = [
    { out: n, along: a, half: box.width / 2, len: box.length },
    { out: { x: -n.x, y: -n.y }, along: a, half: box.width / 2, len: box.length },
    { out: a, along: n, half: box.length / 2, len: box.width },
    { out: { x: -a.x, y: -a.y }, along: n, half: box.length / 2, len: box.width },
  ]
  const points = [...s.points]
  let changed = false
  for (const side of sides) {
    // How far each of five points along this side is from the face of a wall running alongside.
    const gaps: number[] = []
    for (const k of [-0.4, -0.2, 0, 0.2, 0.4]) {
      const q = {
        x: box.center.x + side.out.x * side.half + side.along.x * side.len * k,
        y: box.center.y + side.out.y * side.half + side.along.y * side.len * k,
      }
      let best = Infinity
      for (const wall of walls) {
        const len = Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y) || 1
        const parallel = Math.abs(((wall.b.x - wall.a.x) / len) * side.along.x + ((wall.b.y - wall.a.y) / len) * side.along.y) > 0.98
        if (!parallel) continue
        const { t, d, length } = projectOnWall(q, wall)
        if (t < 0 || t > length) continue
        best = Math.min(best, d - wall.thickness / 2)
      }
      gaps.push(best)
    }
    if (!gaps.every((g) => g >= -2 && g <= 9)) continue
    const gap = gaps.sort((x, y) => x - y)[2]
    const base = { x: box.center.x + side.out.x * (side.half + gap), y: box.center.y + side.out.y * (side.half + gap) }
    for (let t = -side.len / 2; t <= side.len / 2; t += 1) points.push({ x: base.x + side.along.x * t, y: base.y + side.along.y * t })
    changed = true
  }
  return changed ? { points, box: boxOf(points, box.axis) ?? box } : s
}
