// All plan coordinates are in centimetres, seen from above:
// x goes right, y goes down (towards the bottom of the drawing).

export interface Vec2 {
  x: number
  y: number
}

/** A loose line from a vector file (PDF, SVG, DXF), used as a tracing aid. */
export interface Segment {
  a: Vec2
  b: Vec2
  layer: string
}

export interface Wall {
  id: string
  a: Vec2 // centreline start
  b: Vec2 // centreline end
  thickness: number
  height?: number // cm; the plan's room height when not set
}

export type OpeningKind = 'door' | 'window'

export interface Opening {
  id: string
  wallId: string
  kind: OpeningKind
  offset: number // distance from wall start (a) to the opening's first edge
  width: number
  height: number
  sill: number // distance from floor to the bottom of the opening
}

/** A piece of furniture standing in the plan. */
export interface PlacedFurniture {
  id: string
  model: string // a furniture/ file name, e.g. "generic-sofa"
  x: number // centre, cm
  y: number
  rotation: number // degrees; 0 = the front faces down the plan (+y)
  values?: Record<string, number | string | number[]> // the model's options (width, depth...)
  label?: string // the plan's own text it was recognised from
  // Standing on another piece: its id, which of its surfaces, and the height there (cm).
  on?: string
  surface?: number
  z?: number
  locked?: boolean // can't be moved or turned
}

export interface Room {
  name?: string
  points: Vec2[]
}

/** The floorplan picture, placed with its top-left corner at (x, y). */
export interface Background {
  src: string // data URL
  widthPx: number
  heightPx: number
  cmPerPx: number
  x: number
  y: number
}

export type LayerRole = 'wall' | 'door' | 'window' | 'other' | 'hidden'

export interface Layer {
  name: string
  role: LayerRole
  count: number
}

export type SourceFormat =
  | 'image'
  | 'heic'
  | 'tiff'
  | 'photo'
  | 'pdf'
  | 'svg'
  | 'dxf'
  | 'ifc'
  | 'sh3d'

/** A file can contain several parts to choose from: PDF pages, IFC or Sweet Home 3D levels. */
export interface Parts {
  label: string // "Page", "Level"
  names: string[]
  index: number
}

export interface PlanSource {
  fileName: string
  format: SourceFormat
  parts?: Parts
  note?: string
}

export interface Plan {
  version: 1
  source: PlanSource | null
  scaleKnown: boolean
  roomHeight: number // cm, for walls without their own height
  background: Background | null
  lines: Segment[]
  layers: Layer[]
  // Confirmed geometry (traced or accepted by me, milestone 2).
  walls: Wall[]
  openings: Opening[]
  // Geometry found in the imported file, waiting to be accepted.
  suggestedWalls: Wall[]
  suggestedOpenings: Opening[]
  rooms: Room[]
  furniture: PlacedFurniture[]
  // Furniture recognised on the floorplan, waiting to be accepted.
  suggestedFurniture: PlacedFurniture[]
}
