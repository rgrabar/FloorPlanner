import { formatLength } from '../model/geometry'
import type { OpeningKind } from '../model/types'
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
          <NumberField label="Height" value={w.height ?? 250} min={1} onChange={(v) => edit((p) => updateWall(p, w.id, { height: v }))} />
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
