import UTIF from 'utif'
import { imageResult } from './image'
import { ImportError, makeParts, type ImportResult } from './types'

export async function importTiff(file: File, page: number): Promise<ImportResult> {
  const buffer = await file.arrayBuffer()
  // Width and height are only filled in after decoding; t256 is the TIFF width tag.
  const pages = UTIF.decode(buffer).filter((p) => p.t256)
  if (!pages.length) throw new ImportError(`"${file.name}" has no readable images in it.`)
  const parts = makeParts('Page', pages.map((_, i) => `Page ${i + 1}`), page)
  const ifd = pages[parts?.index ?? 0]
  UTIF.decodeImage(buffer, ifd)
  const rgba = UTIF.toRGBA8(ifd)
  const canvas = document.createElement('canvas')
  canvas.width = ifd.width
  canvas.height = ifd.height
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), ifd.width, ifd.height), 0, 0)
  return { ...(await imageResult(canvas.toDataURL('image/png'), 'tiff')), parts }
}
