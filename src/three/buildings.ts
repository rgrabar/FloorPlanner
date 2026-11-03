import * as THREE from 'three'
import { boundsOf, projectOnWall, type Bounds } from '../model/geometry'
import type { Opening, Plan, Wall } from '../model/types'
import { joinedEnds, wallLength, wallOutline } from '../model/walls'

// Turns the plan (centimetres, x right, y down) into 3D geometry (metres, y up).
// Plan x becomes 3D x, plan y becomes 3D z.

export const M = 0.01 // metres per centimetre

/** A wall's own frame: x along the wall from its start, y up, z across it. */
function wallFrame(w: Wall): THREE.Matrix4 {
  const len = wallLength(w) || 1
  const ux = (w.b.x - w.a.x) / len
  const uz = (w.b.y - w.a.y) / len
  return new THREE.Matrix4()
    .makeBasis(new THREE.Vector3(ux, 0, uz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-uz, 0, ux))
    .setPosition(w.a.x * M, 0, w.a.y * M)
}

interface Cut {
  start: number
  end: number
  bottom: number
  top: number
  kind: Opening['kind']
}

/** The openings of one wall, clipped to it, sorted, without overlaps (cm). */
function cutsFor(w: Wall, openings: Opening[], height: number, from: number, to: number): Cut[] {
  const cuts = openings
    .filter((o) => o.wallId === w.id)
    .map((o) => ({
      start: Math.max(from + 1, o.offset),
      end: Math.min(to - 1, o.offset + o.width),
      bottom: Math.max(0, o.sill),
      top: Math.min(height - 2, o.sill + o.height),
      kind: o.kind,
    }))
    .filter((c) => c.end - c.start > 1 && c.top - c.bottom > 1)
    .sort((p, q) => p.start - q.start)
  return cuts.filter((c, i) => i === 0 || c.start >= cuts[i - 1].end)
}

export interface WallMesh {
  wall: Wall
  geometry: THREE.BufferGeometry
  glass: THREE.BufferGeometry[]
}

/**
 * One solid per wall, with real openings: doors (touching the floor) are notches in the
 * wall's outline, windows are holes. Joined ends are extended so corners close.
 */
export function buildWalls(plan: Plan): WallMesh[] {
  return plan.walls.map((w) => {
    const len = wallLength(w)
    const ends = joinedEnds(w, plan.walls)
    const from = ends.a ? -w.thickness / 2 : 0
    const to = len + (ends.b ? w.thickness / 2 : 0)
    const height = w.height ?? plan.roomHeight
    const cuts = cutsFor(w, plan.openings, height, from, to)

    const shape = new THREE.Shape()
    shape.moveTo(from, 0)
    for (const c of cuts.filter((c) => c.bottom < 1)) {
      shape.lineTo(c.start, 0)
      shape.lineTo(c.start, c.top)
      shape.lineTo(c.end, c.top)
      shape.lineTo(c.end, 0)
    }
    shape.lineTo(to, 0)
    shape.lineTo(to, height)
    shape.lineTo(from, height)
    shape.closePath()
    for (const c of cuts.filter((c) => c.bottom >= 1)) {
      const hole = new THREE.Path()
      hole.moveTo(c.start, c.bottom)
      hole.lineTo(c.end, c.bottom)
      hole.lineTo(c.end, c.top)
      hole.lineTo(c.start, c.top)
      hole.closePath()
      shape.holes.push(hole)
    }

    const frame = wallFrame(w)
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: w.thickness, bevelEnabled: false })
    geometry.translate(0, 0, -w.thickness / 2)
    geometry.scale(M, M, M)
    geometry.applyMatrix4(frame)

    // A pane of glass in the middle of each window.
    const glass = cuts
      .filter((c) => c.kind === 'window')
      .map((c) => {
        const g = new THREE.BoxGeometry((c.end - c.start) * M, (c.top - c.bottom) * M, 0.01)
        g.translate(((c.start + c.end) / 2) * M, ((c.bottom + c.top) / 2) * M, 0)
        return g.applyMatrix4(frame)
      })
    return { wall: w, geometry, glass }
  })
}

/** The area the building covers (cm), from its walls, or null without walls. */
export function buildingBounds(plan: Plan): Bounds | null {
  return boundsOf(plan.walls.flatMap((w) => wallOutline(w, joinedEnds(w, plan.walls))))
}

/**
 * Whether a person (radius ~20 cm) at plan point (x, y) in cm would bump into a wall.
 * Door openings that are tall enough to walk through don't count.
 */
export function bumpsIntoWall(plan: Plan, x: number, y: number, radius = 20): boolean {
  const p = { x, y }
  return plan.walls.some((w) => {
    const { t, d, length } = projectOnWall(p, w)
    if (d > w.thickness / 2 + radius || t < -radius || t > length + radius) return false
    // Walking through a doorway (or a floor-to-ceiling opening) is fine.
    return !plan.openings.some(
      (o) => o.wallId === w.id && o.sill < 30 && o.sill + o.height > 170 && t > o.offset + radius / 2 && t < o.offset + o.width - radius / 2,
    )
  })
}
