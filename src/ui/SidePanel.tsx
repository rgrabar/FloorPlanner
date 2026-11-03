import { formatLength } from '../model/geometry'
import { planBounds } from '../model/plan'
import type { LayerRole, SourceFormat } from '../model/types'
import { useStore } from '../store/store'

const FORMAT_NAMES: Record<SourceFormat, string> = {
  image: 'Image',
  heic: 'HEIC photo',
  tiff: 'TIFF image',
  photo: 'Straightened photo',
  pdf: 'PDF',
  svg: 'SVG drawing',
  dxf: 'DXF drawing',
  ifc: 'IFC building model',
  sh3d: 'Sweet Home 3D',
}

const ROLES: { role: LayerRole; label: string }[] = [
  { role: 'wall', label: 'Walls' },
  { role: 'door', label: 'Doors' },
  { role: 'window', label: 'Windows' },
  { role: 'other', label: 'Other' },
  { role: 'hidden', label: 'Hide' },
]

export function SidePanel() {
  const plan = useStore((s) => s.plan)
  const file = useStore((s) => s.file)
  const { choosePart, setLayerRole, setTool } = useStore.getState()
  const src = plan.source
  const bounds = planBounds(plan)
  const doors = plan.suggestedOpenings.filter((o) => o.kind === 'door').length
  const windows = plan.suggestedOpenings.length - doors

  if (!src && !plan.background) {
    return (
      <aside className="side">
        <section>
          <h3>Getting started</h3>
          <ol className="steps">
            <li>Open or drop a floorplan.</li>
            <li>Straighten it if it's a photo taken at an angle.</li>
            <li>Calibrate the scale on a line of known length.</li>
          </ol>
          <p className="muted">Test files for every format are in the <code>samples</code> folder.</p>
        </section>
      </aside>
    )
  }

  return (
    <aside className="side">
      <section>
        <h3>Floorplan</h3>
        <p className="filename">{src?.fileName ?? 'Untitled'}</p>
        <p className="muted">{src && FORMAT_NAMES[src.format]}</p>
        {src?.parts && (
          <label className="field">
            {src.parts.label}
            <select value={src.parts.index} disabled={!file} onChange={(e) => void choosePart(Number(e.target.value))}>
              {src.parts.names.map((n, i) => (
                <option key={i} value={i}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
        {src?.parts && !file && <p className="muted">Open the file again to switch {src.parts.label.toLowerCase()}s.</p>}
        {src?.note && <p className="note">{src.note}</p>}
      </section>

      <section>
        <h3>Scale</h3>
        <p>
          <span className={`badge ${plan.scaleKnown ? 'ok' : 'warn'}`}>{plan.scaleKnown ? 'Set' : 'Not set'}</span>
          {plan.background && <span className="muted"> 1 px = {plan.background.cmPerPx.toFixed(3)} cm</span>}
        </p>
        {bounds && (
          <p className="muted">
            Plan size: {formatLength(bounds.maxX - bounds.minX)} × {formatLength(bounds.maxY - bounds.minY)}
          </p>
        )}
        <button onClick={() => setTool('calibrate')}>Calibrate…</button>
        {plan.background && (
          <button onClick={() => setTool('straighten')} style={{ marginLeft: 6 }}>
            Straighten photo…
          </button>
        )}
      </section>

      {plan.suggestedWalls.length + plan.rooms.length > 0 && (
        <section>
          <h3>Found in the file</h3>
          <ul className="counts">
            <li>{plan.suggestedWalls.length} walls</li>
            <li>{doors} doors</li>
            <li>{windows} windows</li>
            {plan.rooms.length > 0 && <li>{plan.rooms.length} rooms</li>}
          </ul>
          <p className="muted">Shown dashed. You'll accept or edit them in the wall editor (next milestone).</p>
        </section>
      )}

      {plan.layers.length > 0 && (
        <section>
          <h3>Layers</h3>
          <p className="muted">Choose what each layer contains. Lines on wall layers become wall suggestions later.</p>
          <div className="layers">
            {plan.layers.map((l) => (
              <label key={l.name} className="layer">
                <span className={`swatch role-${l.role}`} />
                <span className="layer-name" title={l.name}>
                  {l.name}
                </span>
                <span className="muted">{l.count}</span>
                <select value={l.role} onChange={(e) => setLayerRole(l.name, e.target.value as LayerRole)}>
                  {ROLES.map((r) => (
                    <option key={r.role} value={r.role}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </section>
      )}
    </aside>
  )
}
