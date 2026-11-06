import { acceptFurniture } from '../furniture/placement'
import { formatLength } from '../model/geometry'
import { planBounds } from '../model/plan'
import type { LayerRole, SourceFormat } from '../model/types'
import { acceptSuggestions, clearSuggestions } from '../model/walls'
import { useStore } from '../store/store'
import { Catalogue } from './Catalogue'
import { SelectionPanel } from './SelectionPanel'

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
  const { choosePart, setLayerRole, setTool, setHighlightLayer, findWalls, edit, select } = useStore.getState()
  const src = plan.source
  const bounds = planBounds(plan)
  const floors = useStore((s) => s.floors)
  const count = (kind: string, list: { kind: string }[]) => list.filter((o) => o.kind === kind).length
  const hasWallLayers = plan.layers.some((l) => l.role === 'wall')

  if (!src && !plan.background && !plan.walls.length) {
    return (
      <aside className="side">
        <section>
          <h3>Getting started</h3>
          <ol className="steps">
            <li>Open or drop a floorplan.</li>
            <li>Straighten it if it's a photo taken at an angle.</li>
            <li>Calibrate the scale on a line of known length.</li>
            <li>Trace the walls with the Wall tool, or accept the walls found in the file.</li>
            <li>Add doors and windows.</li>
          </ol>
          <p className="muted">Test files for every format are in the <code>samples</code> folder.</p>
        </section>
        {floors.length > 1 && <FloorsSection />}
      </aside>
    )
  }

  return (
    <aside className="side">
      <SelectionPanel />

      <section>
        <h3>Walls</h3>
        <ul className="counts">
          <li>
            {plan.walls.length} walls, {count('door', plan.openings)} doors, {count('window', plan.openings)} windows
          </li>
        </ul>
        {plan.suggestedWalls.length > 0 && (
          <>
            <p className="muted">
              Suggested (dashed): {plan.suggestedWalls.length} walls, {count('door', plan.suggestedOpenings)} doors,{' '}
              {count('window', plan.suggestedOpenings)} windows. Click one to accept or delete it.
            </p>
            <div className="buttons">
              <button
                className="primary"
                onClick={() => {
                  edit((p) => acceptSuggestions(p))
                  select(null)
                }}
              >
                Accept all
              </button>
              <button onClick={() => edit(clearSuggestions)}>Clear suggestions</button>
            </div>
          </>
        )}
        {plan.lines.length > 0 && (
          <div className="buttons">
            <button onClick={findWalls} disabled={!hasWallLayers} title={hasWallLayers ? '' : 'Set at least one layer to Walls first'}>
              Find walls in wall layers
            </button>
          </div>
        )}
        {!plan.walls.length && !plan.suggestedWalls.length && (
          <p className="muted">Use the Wall tool (W) to trace walls: click along the middle of each wall.</p>
        )}
      </section>

      <FurnitureSection />

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

      {plan.rooms.length > 0 && (
        <section>
          <h3>Rooms</h3>
          <p className="muted">{plan.rooms.length} rooms from the file.</p>
        </section>
      )}

      {plan.layers.length > 0 && (
        <section>
          <h3>Layers</h3>
          <p className="muted">
            Point at a layer to see its lines (pink). Choose what each one contains, then use "Find walls in wall
            layers". Walls need both of their outlines on a wall layer.
          </p>
          <div className="layers" onMouseLeave={() => setHighlightLayer(null)}>
            {plan.layers.map((l) => (
              <label key={l.name} className="layer" onMouseEnter={() => setHighlightLayer(l.name)}>
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

      <FloorsSection />
    </aside>
  )
}

function FurnitureSection() {
  const plan = useStore((s) => s.plan)
  const { edit, select } = useStore.getState()
  const suggested = plan.suggestedFurniture.length

  return (
    <>
      <section>
        <h3>Furniture</h3>
        <p className="muted">{plan.furniture.length} pieces placed.</p>
        {suggested > 0 && (
          <>
            <p className="muted">Found on the plan (purple): {suggested} pieces. Click one to check it, change its model or delete it.</p>
            <div className="buttons">
              <button
                className="primary"
                onClick={() => {
                  edit((p) => acceptFurniture(p))
                  select(null)
                }}
              >
                Accept all furniture
              </button>
              <button onClick={() => edit((p) => ({ ...p, suggestedFurniture: [] }))}>Clear</button>
            </div>
          </>
        )}
      </section>
      <Catalogue />
    </>
  )
}

/** The building's floors: rename, copy (walls without furniture), delete. Switch in the toolbar. */
function FloorsSection() {
  const floors = useStore((s) => s.floors)
  const floorIndex = useStore((s) => s.floorIndex)
  const { switchFloor, addFloor, renameFloor, deleteFloor } = useStore.getState()
  return (
    <section>
      <h3>Floors</h3>
      <ul className="floors">
        {floors.map((f, i) => (
          <li key={i} className={i === floorIndex ? 'active' : ''}>
            <input
              value={f.name}
              onChange={(e) => renameFloor(i, e.target.value)}
              onFocus={() => switchFloor(i)}
              aria-label={`Name of floor ${i + 1}`}
            />
            {floors.length > 1 && (
              <button
                title="Delete this floor"
                onClick={() => window.confirm(`Delete "${f.name}" with its walls and furniture?`) && deleteFloor(i)}
              >
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="buttons">
        <button onClick={() => addFloor(false)}>Add a floor</button>
        <button onClick={() => addFloor(true)} title="A new floor with this floor's walls, doors and windows, without furniture">
          Copy this floor
        </button>
      </div>
      <p className="muted">Each floor has its own floorplan, walls and furniture: open a file while a floor is chosen to fill it.</p>
    </section>
  )
}
