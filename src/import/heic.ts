import { heicTo } from 'heic-to'
import { blobToDataUrl, imageResult } from './image'
import type { ImportResult } from './types'

export async function importHeic(file: File): Promise<ImportResult> {
  const jpeg = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.92 })
  return imageResult(await blobToDataUrl(jpeg), 'heic')
}
