import { newId } from '../model/geometry'
import type { PlacedFurniture, Plan, Vec2 } from '../model/types'
import { expandModel, MODELS, type Model } from './model'

// Furniture in the plan: a model, placed by its centre and turned by `rotation` degrees.
// The model's own x axis (left -> right seen from the front) points along (cos r, sin r) in the
// plan, and its y axis (back -> front) along (-sin r, cos r): at 0° the front faces down the plan.

const expanded = new Map<string, Model | null>()

/** The model with this piece's options, or null when the model file is missing or broken. */
export function modelOf(item: PlacedFurniture): Model | null {
  const key = `${item.model}|${JSON.stringify(item.values ?? {})}`
  if (!expanded.has(key)) {
    const spec = MODELS[item.model]
    let model: Model | null = null
    try {
      model = spec ? expandModel(spec, item.values) : null
    } catch {
      model = null
    }
    expanded.set(key, model)
  }
  return expanded.get(key)!
}

export function displayName(modelName: string): string {
  const spec = MODELS[modelName]
  if (!spec) return modelName
  if (spec.generic) return spec.generic.name
  if (spec.ikea) return `${spec.ikea.name} ${spec.ikea.type.toLowerCase()}`
  return modelName
}

/** The plan directions of the model's own x (along the front) and y (towards the front) axes. */
export function axes(item: PlacedFurniture) {
  const r = (item.rotation * Math.PI) / 180
  return { u: { x: Math.cos(r), y: Math.sin(r) }, v: { x: -Math.sin(r), y: Math.cos(r) } }
}

/** The four corners of the footprint: back-left, back-right, front-right, front-left. */
export function footprint(item: PlacedFurniture): Vec2[] {
  const m = modelOf(item)
  const [w, d] = m ? m.size : [50, 50]
  const { u, v } = axes(item)
  const at = (a: number, b: number) => ({ x: item.x + u.x * a + v.x * b, y: item.y + u.y * a + v.y * b })
  return [at(-w / 2, -d / 2), at(w / 2, -d / 2), at(w / 2, d / 2), at(-w / 2, d / 2)]
}

export function insideFootprint(p: Vec2, item: PlacedFurniture, tolerance = 0): boolean {
  const m = modelOf(item)
  const [w, d] = m ? m.size : [50, 50]
  const { u, v } = axes(item)
  const dx = p.x - item.x
  const dy = p.y - item.y
  return Math.abs(dx * u.x + dy * u.y) <= w / 2 + tolerance && Math.abs(dx * v.x + dy * v.y) <= d / 2 + tolerance
}

export function addFurniture(plan: Plan, model: string, at: Vec2): { plan: Plan; id: string } {
  const id = newId()
  return { plan: { ...plan, furniture: [...plan.furniture, { id, model, x: at.x, y: at.y, rotation: 0 }] }, id }
}

export function updateFurniture(plan: Plan, id: string, patch: Partial<Omit<PlacedFurniture, 'id'>>): Plan {
  const change = (list: PlacedFurniture[]) => list.map((f) => (f.id === id ? { ...f, ...patch } : f))
  return { ...plan, furniture: change(plan.furniture), suggestedFurniture: change(plan.suggestedFurniture) }
}

export function acceptFurniture(plan: Plan, ids?: string[]): Plan {
  const take = new Set(ids ?? plan.suggestedFurniture.map((f) => f.id))
  return {
    ...plan,
    furniture: [...plan.furniture, ...plan.suggestedFurniture.filter((f) => take.has(f.id))],
    suggestedFurniture: plan.suggestedFurniture.filter((f) => !take.has(f.id)),
  }
}

export function removeFurniture(plan: Plan, id: string): Plan {
  return {
    ...plan,
    furniture: plan.furniture.filter((f) => f.id !== id),
    suggestedFurniture: plan.suggestedFurniture.filter((f) => f.id !== id),
  }
}
