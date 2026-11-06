import { acceptFurniture, displayName, modelOf, updateFurniture } from '../furniture/placement'
import { deleteSelected, duplicateSelected, toggleLockSelected, turnSelected } from '../furniture/actions'
import { blockedClearances, conflicts, moveFurniture, restack, surfacesUnder } from '../furniture/fit'
import { MODELS } from '../furniture/model'
import { formatLength } from '../model/geometry'
import type { OpeningKind, PlacedFurniture } from '../model/types'
import {
  acceptSuggestions,
  deleteSelection,
  setWallLength,
  splitWall,
  updateOpening,
  updateWall,
  wallLength,
} from '../model/walls'
import { useStore } from '../store/store'
import { ListField } from './ListField'
import { NumberField } from './NumberField'

/** Details of the selected wall, door/window or suggestion, with its sizes editable. */
export function SelectionPanel() {
  const plan = useStore((s) => s.plan)
  const sel = useStore((s) => s.selection)
  const { edit, select } = useStore.getState()
  if (!sel) return null

  const remove = () => {
    edit((p) => deleteSelection(p, sel))
    select(null)
  }

  if (sel.kind === 'furniture') return <FurniturePanel id={sel.id} />

  if (sel.kind === 'suggestion') {
    const w = plan.suggestedWalls.find((x) => x.id === sel.id)
    if (!w) return null
    return (
      <section>
        <h3>Suggested wall</h3>
        <p className="muted">
          {formatLength(wallLength(w))} long, {Math.round(w.thickness)} cm thick
        </p>
        <div className="buttons">
          <button
            className="primary"
            onClick={() => {
              edit((p) => acceptSuggestions(p, [w.id]))
              select({ kind: 'wall', id: w.id })
            }}
          >
            Accept (Enter)
          </button>
          <button onClick={remove}>Delete</button>
        </div>
      </section>
    )
  }

  if (sel.kind === 'wall') {
    const w = plan.walls.find((x) => x.id === sel.id)
    if (!w) return null
    const len = wallLength(w)
    return (
      <section>
        <h3>Wall</h3>
        <div className="fields">
          <NumberField label="Length" value={len} min={1} onChange={(v) => edit((p) => setWallLength(p, w.id, v))} />
          <NumberField label="Thickness" value={w.thickness} min={1} onChange={(v) => edit((p) => updateWall(p, w.id, { thickness: v }))} />
          <NumberField label="Height" value={w.height ?? plan.roomHeight} min={1} onChange={(v) => edit((p) => updateWall(p, w.id, { height: v }))} />
        </div>
        <p className="muted">Drag the wall to move it, or its square ends to reshape it. Double-click a wall to split it there.</p>
        <div className="buttons">
          <button onClick={() => edit((p) => splitWall(p, w.id, len / 2))}>Split in the middle</button>
          <button onClick={remove}>Delete</button>
        </div>
      </section>
    )
  }

  const o = plan.openings.find((x) => x.id === sel.id)
  if (!o) return null
  const set = (patch: Parameters<typeof updateOpening>[2]) => edit((p) => updateOpening(p, o.id, patch))
  return (
    <section>
      <h3>{o.kind === 'door' ? 'Door' : 'Window'}</h3>
      <label className="field">
        Type
        <select value={o.kind} onChange={(e) => set({ kind: e.target.value as OpeningKind, sill: e.target.value === 'door' ? 0 : o.sill || 90 })}>
          <option value="door">Door</option>
          <option value="window">Window</option>
        </select>
      </label>
      <div className="fields">
        <NumberField label="Width" value={o.width} min={10} onChange={(v) => set({ width: v })} />
        <NumberField label="Height" value={o.height} min={10} onChange={(v) => set({ height: v })} />
        {o.kind === 'window' && <NumberField label="Sill" value={o.sill} onChange={(v) => set({ sill: v })} />}
        <NumberField label="From wall start" value={o.offset} onChange={(v) => set({ offset: v })} />
      </div>
      <p className="muted">Drag it to slide it along the wall.</p>
      <div className="buttons">
        <button onClick={remove}>Delete</button>
      </div>
    </section>
  )
}

const MODEL_NAMES = Object.keys(MODELS).sort((a, b) => displayName(a).localeCompare(displayName(b)))

function FurniturePanel({ id }: { id: string }) {
  const plan = useStore((s) => s.plan)
  const { edit } = useStore.getState()
  const suggested = plan.suggestedFurniture.find((f) => f.id === id)
  const f = suggested ?? plan.furniture.find((x) => x.id === id)
  if (!f) return null
  const spec = MODELS[f.model]
  const model = modelOf(f)
  // Option changes can change what stands on it (a shelf moved): heights follow.
  const set = (patch: Partial<PlacedFurniture>) => edit((p) => restack(updateFurniture(p, f.id, patch)))
  const setValue = (key: string, v: number | string | number[]) => set({ values: { ...f.values, [key]: v } })
  // Another model keeps the options it shares with this one (a sofa's width stays when swapped).
  const swap = (name: string) => {
    const params = MODELS[name]?.params ?? {}
    const values = Object.fromEntries(Object.entries(f.values ?? {}).filter(([k]) => k in params))
    set({ model: name, values })
  }
  // What it can stand on: the floor, or any surface of what's under its middle.
  const under = suggested ? [] : surfacesUnder(f, f, plan)
  const standingKey = f.on ? `${f.on}:${f.surface}` : ''
  const standOn = (key: string) => {
    const pick = under.find((s) => `${s.host.id}:${s.index}` === key)
    set(pick ? { on: pick.host.id, surface: pick.index, z: pick.z } : { on: undefined, surface: undefined, z: undefined })
  }
  const clash = suggested ? undefined : conflicts(plan).get(f.id)
  const blocked = !suggested && blockedClearances(plan).has(f.id)
  const nameOf = (other: string) => {
    const o = plan.furniture.find((x) => x.id === other)
    return o ? displayName(o.model) : 'another piece'
  }
  return (
    <section>
      <h3>{suggested ? 'Suggested furniture' : 'Furniture'}</h3>
      <label className="field">
        Model
        <select value={f.model} onChange={(e) => swap(e.target.value)} disabled={f.locked}>
          {MODEL_NAMES.map((n) => (
            <option key={n} value={n}>
              {displayName(n)}
            </option>
          ))}
        </select>
      </label>
      {f.label && <p className="muted">From the plan: "{f.label}"</p>}
      {model && <p className="muted">{model.size.map(Math.round).join(' × ')} cm</p>}
      {clash && (
        <p className="error-text">
          {[clash.wall && 'Goes through a wall.', clash.with.length && `Overlaps ${clash.with.map(nameOf).join(', ')}.`].filter(Boolean).join(' ')}
        </p>
      )}
      {blocked && <p className="warn-text">Something is in the space it needs in front (or around it).</p>}
      <div className="fields">
        {Object.entries(spec?.params ?? {}).map(([key, p]) => {
          const current = f.values?.[key] ?? p.default
          if (p.type === 'number') {
            return <NumberField key={key} label={p.label ?? key} value={current as number} min={p.min ?? 1} onChange={(v) => setValue(key, v)} />
          }
          if (p.type === 'choice') {
            return (
              <label key={key} className="field">
                {p.label ?? key}
                <select value={current as string} onChange={(e) => setValue(key, e.target.value)}>
                  {p.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </label>
            )
          }
          return <ListField key={key} label={p.label ?? key} value={current as number[]} onChange={(v) => setValue(key, v)} />
        })}
        {!f.locked && (
          <NumberField
            label="Turned"
            unit="°"
            min={-360}
            value={f.rotation}
            onChange={(v) => edit((p) => moveFurniture(p, f.id, { x: f.x, y: f.y, rotation: ((v % 360) + 360) % 360 }))}
          />
        )}
      </div>
      {(under.length > 0 || f.on) && (
        <label className="field">
          Stands on
          <select value={standingKey} onChange={(e) => standOn(e.target.value)}>
            <option value="">the floor</option>
            {under.map((s) => (
              <option key={`${s.host.id}:${s.index}`} value={`${s.host.id}:${s.index}`}>
                {displayName(s.host.model)}: {s.label} ({Math.round(s.z)} cm)
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="muted">
        {f.locked
          ? 'Locked: it stays where it is (L to unlock).'
          : 'Drag it to move it; it snaps to walls and furniture (hold Alt not to). Drag the round handle to turn it in 15° steps, R turns it 90°. The thick edge is its front.'}
      </p>
      <div className="buttons">
        {suggested && (
          <button className="primary" onClick={() => edit((p) => acceptFurniture(p, [f.id]))}>
            Accept (Enter)
          </button>
        )}
        {!f.locked && <button onClick={() => turnSelected(90)}>Turn 90°</button>}
        {!suggested && <button onClick={duplicateSelected} title="Ctrl+D">Duplicate</button>}
        {!suggested && <button onClick={toggleLockSelected} title="L">{f.locked ? 'Unlock' : 'Lock'}</button>}
        <button onClick={deleteSelected}>Delete</button>
      </div>
    </section>
  )
}
