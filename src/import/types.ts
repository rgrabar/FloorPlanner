import type { Background, Opening, Parts, Room, Segment, SourceFormat, Vec2, Wall } from '../model/types'

/** What every importer returns. Everything is already in centimetres. */
export interface ImportResult {
  format: SourceFormat
  scaleKnown: boolean
  background: Background | null
  lines: Segment[]
  suggestedWalls: Wall[]
  suggestedOpenings: Opening[]
  rooms: Room[]
  parts?: Parts
  note?: string
  // Words written on the plan (PDF text), with where their middle is: furniture names, room names.
  texts?: { text: string; at: Vec2 }[]
}

export interface ImportOptions {
  part?: number
}

/** An error with a message that can be shown to me as-is. */
export class ImportError extends Error {}

export function emptyResult(format: SourceFormat): ImportResult {
  return {
    format,
    scaleKnown: false,
    background: null,
    lines: [],
    suggestedWalls: [],
    suggestedOpenings: [],
    rooms: [],
  }
}

/** Builds the page/level chooser, keeping the requested index in range. */
export function makeParts(label: string, names: string[], requested = 0): Parts | undefined {
  if (names.length < 2) return undefined
  return { label, names, index: Math.max(0, Math.min(names.length - 1, requested)) }
}
