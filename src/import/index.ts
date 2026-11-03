import { ImportError, type ImportOptions, type ImportResult } from './types'

export const SUPPORTED_TEXT =
  'PNG, JPG, WebP, GIF, BMP, TIFF, HEIC, PDF, SVG, DXF, DWG (after converting to DXF), IFC and Sweet Home 3D (.sh3d)'

export const ACCEPT =
  '.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff,.heic,.heif,.pdf,.svg,.dxf,.dwg,.ifc,.sh3d,.json'

const DWG_HELP =
  'DWG files can\'t be read in the browser. Convert it to DXF first:\n' +
  '  python tools/convert.py "<your file>.dwg"\n' +
  'This needs the free ODA File Converter (see README). Then open the .dxf file it creates.'

export async function importFile(file: File, opts: ImportOptions = {}): Promise<ImportResult> {
  const ext = file.name.toLowerCase().split('.').pop() ?? ''
  const part = opts.part ?? 0
  try {
    switch (ext) {
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'webp':
      case 'gif':
      case 'bmp':
        return await (await import('./image')).importImage(file)
      case 'tif':
      case 'tiff':
        return await (await import('./tiff')).importTiff(file, part)
      case 'heic':
      case 'heif':
        return await (await import('./heic')).importHeic(file)
      case 'pdf':
        return await (await import('./pdf')).importPdf(file, part)
      case 'svg':
        return await (await import('./svg')).importSvg(file)
      case 'dxf':
        return await (await import('./dxf')).importDxf(file)
      case 'dwg':
        throw new ImportError(DWG_HELP)
      case 'ifc':
        return await (await import('./ifc')).importIfc(file, part)
      case 'sh3d':
        return await (await import('./sh3d')).importSh3d(file, part)
    }
  } catch (e) {
    if (e instanceof ImportError) throw e
    console.error(e)
    const reason = e instanceof Error ? e.message : String(e)
    throw new ImportError(`Couldn't read "${file.name}". The file may be damaged or an unusual variant.\n(${reason})`)
  }
  throw new ImportError(`"${file.name}" isn't a supported format.\nSupported: ${SUPPORTED_TEXT}.`)
}
