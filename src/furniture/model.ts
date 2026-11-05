import { evaluate, ExprError, numberOf, type Value } from './expr'

// Furniture models: simple shapes in the item's own box, in cm.
// x left -> right seen from the front, y back (0) -> front (D), z up. See PROMPT.md 4C.
// tools/furniture.py expands models with the same rules (used by tools/check_model.py).

type Num = number | string

export type ParamSpec =
  | { type: 'list'; default: number[]; label?: string }
  | { type: 'choice'; options: string[]; default: string; label?: string }
  | { type: 'number'; default: number; min?: number; max?: number; label?: string }

interface Repeat {
  each?: string // name of a list parameter: repeat once per value ($v), index $i (0-based), $n = $i + 1
  when?: string // only include when this is true
}

export interface PartSpec extends Repeat {
  box?: Num[] // [x, y, z, w, d, h]
  cyl?: Num[] // [x, y, z, r, length]; along z: centre x,y and bottom z; along x/y: start at x/y, centre of the rest
  sphere?: Num[] // [cx, cy, cz, r]
  prism?: Num[] // [x, y, z, w, d, h], a wedge whose top slopes down towards `slope`
  axis?: 'x' | 'y' | 'z'
  slope?: 'front' | 'back' | 'left' | 'right'
  radius?: Num // rounded edges, for boxes
  color?: string // "#rrggbb" or "$name" (from colors, or a parameter)
  mat?: string // wood, metal, fabric, glass, plastic, stone
  name?: string
}

export interface SurfaceSpec extends Repeat {
  z: Num
  area?: Num[] // [x, y, w, d]; the whole footprint when left out
  label?: string // may use $n, $i, $v
}

export interface ModelSpec {
  size: Num[]
  category: string
  colors?: Record<string, string>
  clearance?: { front?: number; back?: number; left?: number; right?: number }
  // items: every article to buy (repeat an article for each piece); combination: the set's own number.
  ikea?: { name: string; type: string; items: string[]; variant?: string; combination?: string }
  // Everyday furniture in standard sizes. kind: what it is (sofa, bed...); long: which of the model's
  // own sides (width or depth) is the longer one when fitted to a drawn rectangle.
  generic?: { name: string; kind: string; long: 'width' | 'depth' }
  params?: Record<string, ParamSpec>
  parts: PartSpec[]
  surfaces?: SurfaceSpec[]
}

export type ParamValue = number | string | number[]

export interface Part {
  shape: 'box' | 'cyl' | 'sphere' | 'prism'
  box: [number, number, number, number, number, number] // bounding box [x, y, z, w, d, h]
  axis: 'x' | 'y' | 'z'
  slope: 'front' | 'back' | 'left' | 'right'
  radius: number
  color: string
  mat: string
  name?: string
}

export interface Surface {
  z: number
  area: [number, number, number, number]
  label: string
}

export interface Model {
  size: [number, number, number]
  category: string
  parts: Part[]
  surfaces: Surface[]
  clearance: { front: number; back: number; left: number; right: number }
  ikea?: ModelSpec['ikea']
  values: Record<string, ParamValue>
}

export function defaultValues(spec: ModelSpec): Record<string, ParamValue> {
  return Object.fromEntries(Object.entries(spec.params ?? {}).map(([k, p]) => [k, p.default]))
}

/** Calls `fn` once, or once per value of the `each` list, with $v/$i/$n set, when `when` holds. */
function repeat(r: Repeat, vars: Record<string, Value>, values: Record<string, ParamValue>, fn: (vars: Record<string, Value>) => void) {
  const list = r.each === undefined ? [null] : values[r.each]
  if (!Array.isArray(list)) throw new ExprError(`"each": "${r.each}" is not a list parameter`)
  list.forEach((v, i) => {
    const scope = v === null ? vars : { ...vars, v, i, n: i + 1 }
    if (r.when !== undefined && !evaluate(r.when, scope)) return
    fn(scope)
  })
}

function colorOf(field: string | undefined, colors: Record<string, string>, vars: Record<string, Value>): string {
  if (!field) return colors.main ?? '#cccccc'
  if (!field.startsWith('$')) return field
  const name = field.slice(1)
  if (name in colors) return colors[name]
  const v = evaluate(field, vars)
  return typeof v === 'string' && v in colors ? colors[v] : String(v)
}

/** Expands a model with chosen parameter values (defaults for the rest) into plain shapes. */
export function expandModel(spec: ModelSpec, chosen: Record<string, ParamValue> = {}): Model {
  const values = { ...defaultValues(spec), ...chosen }
  const vars: Record<string, Value> = {}
  for (const [k, v] of Object.entries(values)) if (!Array.isArray(v)) vars[k] = v
  const [W, D, H] = spec.size.map((s) => numberOf(s, vars))
  Object.assign(vars, { W, D, H })
  const colors = spec.colors ?? {}

  const parts: Part[] = []
  for (const p of spec.parts) {
    repeat(p, vars, values, (scope) => {
      const n = (f: Num[] | undefined, count: number) => {
        if (!f || f.length !== count) throw new ExprError(`A part needs ${count} numbers: ${JSON.stringify(p)}`)
        return f.map((x) => numberOf(x, scope))
      }
      const axis = p.axis ?? 'z'
      let shape: Part['shape']
      let box: Part['box']
      if (p.box) {
        shape = 'box'
        box = n(p.box, 6) as Part['box']
      } else if (p.prism) {
        shape = 'prism'
        box = n(p.prism, 6) as Part['box']
      } else if (p.cyl) {
        shape = 'cyl'
        const [x, y, z, r, len] = n(p.cyl, 5)
        box =
          axis === 'z' ? [x - r, y - r, z, 2 * r, 2 * r, len]
          : axis === 'x' ? [x, y - r, z - r, len, 2 * r, 2 * r]
          : [x - r, y, z - r, 2 * r, len, 2 * r]
      } else if (p.sphere) {
        shape = 'sphere'
        const [x, y, z, r] = n(p.sphere, 4)
        box = [x - r, y - r, z - r, 2 * r, 2 * r, 2 * r]
      } else {
        throw new ExprError(`A part needs box, cyl, sphere or prism: ${JSON.stringify(p)}`)
      }
      parts.push({
        shape,
        box,
        axis,
        slope: p.slope ?? 'front',
        radius: p.radius === undefined ? 0 : numberOf(p.radius, scope),
        color: colorOf(p.color, colors, scope),
        mat: p.mat ?? 'wood',
        name: p.name,
      })
    })
  }

  const surfaces: Surface[] = []
  for (const s of spec.surfaces ?? []) {
    repeat(s, vars, values, (scope) => {
      const area = (s.area ?? [0, 0, W, D]).map((x) => numberOf(x, scope)) as Surface['area']
      const label = (s.label ?? 'top').replace(/\$(n|i|v)\b/g, (_, k: string) => String(scope[k]))
      surfaces.push({ z: numberOf(s.z, scope), area, label })
    })
  }

  return {
    size: [W, D, H],
    category: spec.category,
    parts,
    surfaces,
    clearance: { front: 0, back: 0, left: 0, right: 0, ...spec.clearance },
    ikea: spec.ikea,
    values,
  }
}

// Every model file in furniture/, bundled into the app.
const files = import.meta.glob<ModelSpec>('../../furniture/*.json', { eager: true, import: 'default' })

export const MODELS: Record<string, ModelSpec> = Object.fromEntries(
  Object.entries(files).map(([path, spec]) => [path.split('/').pop()!.replace(/\.json$/, ''), spec]),
)
