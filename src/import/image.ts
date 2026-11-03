import type { Background } from '../model/types'
import { emptyResult, type ImportResult } from './types'

export const UNKNOWN_SCALE_NOTE = 'Scale unknown. Use Calibrate and click two points with a known distance.'

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image()
  img.src = src
  await img.decode()
  return img
}

export async function makeBackground(src: string, cmPerPx = 1): Promise<Background> {
  const img = await loadImage(src)
  return { src, widthPx: img.naturalWidth, heightPx: img.naturalHeight, cmPerPx, x: 0, y: 0 }
}

/** For formats that decode to a bitmap first (HEIC, TIFF). */
export async function imageResult(src: string, format: ImportResult['format']): Promise<ImportResult> {
  return { ...emptyResult(format), background: await makeBackground(src), note: UNKNOWN_SCALE_NOTE }
}

export async function importImage(file: File): Promise<ImportResult> {
  return imageResult(await blobToDataUrl(file), 'image')
}
