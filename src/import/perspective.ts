import { dist } from '../model/geometry'
import type { Vec2 } from '../model/types'
import { loadImage } from './image'

const MAX_SIDE = 3000

/** Puts four clicked corners in the order top-left, top-right, bottom-right, bottom-left. */
export function orderCorners(pts: Vec2[]): Vec2[] {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
  const sorted = [...pts].sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx))
  // Sorted by angle, starting from the left. Rotate so the top-left corner comes first.
  const tl = sorted.reduce((best, p, i) => (p.x + p.y < sorted[best].x + sorted[best].y ? i : best), 0)
  return [...sorted.slice(tl), ...sorted.slice(0, tl)]
}

/** Solves the 8 unknowns of a homography mapping `from[i]` to `to[i]`. */
function homography(from: Vec2[], to: Vec2[]): number[] {
  const A: number[][] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i]
    const { x: u, y: v } = to[i]
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
  }
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < 8; c++) {
    let p = c
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r
    ;[A[c], A[p]] = [A[p], A[c]]
    for (let r = 0; r < 8; r++) {
      if (r === c) continue
      const f = A[r][c] / A[c][c]
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k]
    }
  }
  return A.map((row, i) => row[8] / row[i])
}

type V3 = [number, number, number]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/**
 * The real width/height ratio of a photographed rectangle, from its four corners.
 * Assumes a normal camera (square pixels, centred lens), after Zhang & He, "Whiteboard scanning
 * and image enhancement" (2007). Falls back to the average side lengths when that doesn't work.
 */
function realAspect(tl: Vec2, tr: Vec2, br: Vec2, bl: Vec2, imgW: number, imgH: number): number {
  const fallback = (dist(tl, tr) + dist(bl, br)) / (dist(tl, bl) + dist(tr, br))
  const u0 = imgW / 2
  const v0 = imgH / 2
  const m1: V3 = [tl.x, tl.y, 1], m2: V3 = [tr.x, tr.y, 1], m3: V3 = [bl.x, bl.y, 1], m4: V3 = [br.x, br.y, 1]
  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3)
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2)
  const n2 = m2.map((v, i) => k2 * v - m1[i]) as V3
  const n3 = m3.map((v, i) => k3 * v - m1[i]) as V3
  if (Math.abs(n2[2] * n3[2]) < 1e-9) return fallback // no perspective: sides are already in proportion
  const f2 =
    -(
      n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0 + n2[2] * n3[2] * u0 * u0 +
      n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + n2[2] * n3[2] * v0 * v0
    ) / (n2[2] * n3[2])
  if (!(f2 > 0)) return fallback
  // |A^-1 n| for the camera matrix A = [[f, 0, u0], [0, f, v0], [0, 0, 1]].
  const len2 = (n: V3) => ((n[0] - u0 * n[2]) ** 2 + (n[1] - v0 * n[2]) ** 2) / f2 + n[2] ** 2
  const ratio = Math.sqrt(len2(n2) / len2(n3))
  return Number.isFinite(ratio) && ratio > 0.05 && ratio < 20 ? ratio : fallback
}

/**
 * Straightens a photo of a plan: the four corners (image pixels, any order) become a rectangle
 * with the plan's real proportions. Returns the new image as a PNG data URL.
 */
export async function straightenImage(src: string, corners: Vec2[]): Promise<string> {
  const [tl, tr, br, bl] = orderCorners(corners)
  const img = await loadImage(src)
  const aspect = realAspect(tl, tr, br, bl, img.naturalWidth, img.naturalHeight)
  // Keep roughly the photo's resolution along the longer side.
  const longest = Math.max(dist(tl, tr), dist(bl, br), dist(tl, bl), dist(tr, br))
  let w = aspect >= 1 ? longest : longest * aspect
  let h = aspect >= 1 ? longest / aspect : longest
  const shrink = Math.min(1, MAX_SIDE / Math.max(w, h))
  w = Math.round(w * shrink)
  h = Math.round(h * shrink)

  const srcCanvas = document.createElement('canvas')
  srcCanvas.width = img.naturalWidth
  srcCanvas.height = img.naturalHeight
  const sctx = srcCanvas.getContext('2d')!
  sctx.drawImage(img, 0, 0)
  const s = sctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height)

  // Map every output pixel back to the photo and sample it (bilinear).
  const [a, b, c, d, e, f, g, hh] = homography(
    [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }],
    [tl, tr, br, bl],
  )
  const out = new ImageData(w, h)
  const sw = s.width
  const sh = s.height
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const den = g * x + hh * y + 1
      const sx = (a * x + b * y + c) / den
      const sy = (d * x + e * y + f) / den
      const o = (y * w + x) * 4
      if (sx < 0 || sy < 0 || sx >= sw - 1 || sy >= sh - 1) {
        out.data[o] = out.data[o + 1] = out.data[o + 2] = out.data[o + 3] = 255
        continue
      }
      const x0 = Math.floor(sx), y0 = Math.floor(sy)
      const fx = sx - x0, fy = sy - y0
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4
      for (let ch = 0; ch < 4; ch++) {
        const top = s.data[i00 + ch] * (1 - fx) + s.data[i10 + ch] * fx
        const bottom = s.data[i01 + ch] * (1 - fx) + s.data[i11 + ch] * fx
        out.data[o + ch] = top * (1 - fy) + bottom * fy
      }
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d')!.putImageData(out, 0, 0)
  return canvas.toDataURL('image/png')
}
