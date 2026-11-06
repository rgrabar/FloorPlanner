import { useMemo, useState } from 'react'
import { addFurniture, displayName } from '../furniture/placement'
import { expandModel, MODELS } from '../furniture/model'
import { planBounds } from '../model/plan'
import type { Plan, Vec2 } from '../model/types'
import { useStore } from '../store/store'
import { NumberField } from './NumberField'

// Every furniture model, searchable, to drag onto the plan or into 3D (or click to add).

/** What a dragged catalogue entry carries: the model's name. */
export const FURNITURE_DRAG = 'application/x-floorplanner-model'

const CATEGORY_NAMES: Record<string, string> = {
  seating: 'Seating',
  bed: 'Beds',
  table: 'Tables',
  desk: 'Desks',
  storage: 'Storage',
  kitchen: 'Kitchen',
  bathroom: 'Bathroom',
  appliance: 'Appliances',
  other: 'Other',
}

interface Entry {
  model: string
  name: string
  detail: string // the IKEA type and variant, or "standard size"
  size: string // W × D × H
  category: string
  search: string
}

const ENTRIES: Entry[] = Object.entries(MODELS)
  .map(([model, spec]) => {
    let size = ''
    try {
      size = expandModel(spec).size.map((v) => Math.round(v)).join(' × ') + ' cm'
    } catch {
      size = ''
    }
    const detail = spec.ikea ? [spec.ikea.type, spec.ikea.variant].filter(Boolean).join(' · ') : 'Standard size, adjustable'
    const name = spec.ikea ? spec.ikea.name : displayName(model)
    return { model, name, detail, size, category: spec.category, search: `${name} ${detail} ${spec.generic?.kind ?? ''} ${spec.category}`.toLowerCase() }
  })
  // IKEA models first (they're the real thing), then everyday ones, by name.
  .sort((a, b) => Number(!MODELS[a.model].ikea) - Number(!MODELS[b.model].ikea) || a.name.localeCompare(b.name))

const CATEGORIES = [...new Set(ENTRIES.map((e) => e.category))].sort((a, b) => (CATEGORY_NAMES[a] ?? a).localeCompare(CATEGORY_NAMES[b] ?? b))

/** The middle of the plan: where clicked items go, to be dragged from there. */
function middleOf(plan: Plan): Vec2 {
  const b = planBounds(plan)
  return b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : { x: 0, y: 0 }
}

/** Adds a piece at a plan position and selects it. Used by the catalogue, and by drops in 2D and 3D. */
export function placeFromCatalogue(model: string, at: Vec2, values?: Record<string, number>) {
  const { edit, select } = useStore.getState()
  let id = ''
  edit((p) => {
    const r = addFurniture(p, model, at)
    id = r.id
    return values ? { ...r.plan, furniture: r.plan.furniture.map((f) => (f.id === id ? { ...f, values } : f)) } : r.plan
  })
  select({ kind: 'furniture', id })
}

export function Catalogue() {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [box, setBox] = useState({ width: 80, depth: 50, height: 80 })

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return ENTRIES.filter((e) => (!category || e.category === category) && words.every((w) => e.search.includes(w)))
  }, [query, category])

  return (
    <section>
      <h3>Add furniture</h3>
      <div className="catalogue-filters">
        <input type="search" placeholder="Search (sofa, BILLY, kitchen…)" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_NAMES[c] ?? c}
            </option>
          ))}
        </select>
      </div>
      <p className="muted">Drag one onto the plan or into 3D, or click it to add it in the middle.</p>
      <ul className="catalogue">
        {shown.map((e) => (
          <li
            key={e.model}
            draggable
            title="Drag onto the plan or into 3D, or click to add"
            onDragStart={(ev) => {
              ev.dataTransfer.setData(FURNITURE_DRAG, e.model)
              ev.dataTransfer.effectAllowed = 'copy'
            }}
            onClick={() => placeFromCatalogue(e.model, middleOf(useStore.getState().plan))}
          >
            <strong>{e.name}</strong> <span className="muted">{e.size}</span>
            <br />
            <span className="muted">{e.detail}</span>
          </li>
        ))}
        {!shown.length && <li className="muted">Nothing matches.</li>}
      </ul>

      <h3 style={{ marginTop: 12 }}>Something else</h3>
      <p className="muted">A plain box with your own sizes, for anything not modelled yet. Swap it for a real model later.</p>
      <div className="fields">
        <NumberField label="Width" value={box.width} min={5} onChange={(v) => setBox({ ...box, width: v })} />
        <NumberField label="Depth" value={box.depth} min={5} onChange={(v) => setBox({ ...box, depth: v })} />
        <NumberField label="Height" value={box.height} min={5} onChange={(v) => setBox({ ...box, height: v })} />
      </div>
      <div className="buttons">
        <button onClick={() => placeFromCatalogue('generic-box', middleOf(useStore.getState().plan), box)}>Add box</button>
      </div>
    </section>
  )
}
