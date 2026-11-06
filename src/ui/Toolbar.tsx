import { useRef, useState } from 'react'
import { ACCEPT } from '../import'
import { downloadProject } from '../project/saveLoad'
import { useStore, type Tool } from '../store/store'
import { ShoppingListDialog } from './ShoppingList'

const TOOLS: { tool: Tool; label: string; key: string; title: string; needsPlan?: boolean }[] = [
  { tool: 'select', label: 'Select', key: 'V', title: 'Select, move and reshape. Drag empty space to pan.' },
  { tool: 'wall', label: 'Wall', key: 'W', title: 'Draw walls by clicking points' },
  { tool: 'door', label: 'Door', key: 'D', title: 'Place a door on a wall' },
  { tool: 'window', label: 'Window', key: 'N', title: 'Place a window on a wall' },
  { tool: 'calibrate', label: 'Calibrate', key: 'C', title: 'Set the scale from a line of known length', needsPlan: true },
  { tool: 'straighten', label: 'Straighten photo', key: 'S', title: 'Fix a photo taken at an angle', needsPlan: true },
]

export function Toolbar() {
  const plan = useStore((s) => s.plan)
  const tool = useStore((s) => s.tool)
  const viewMode = useStore((s) => s.viewMode)
  const canUndo = useStore((s) => s.past.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  const floors = useStore((s) => s.floors)
  const floorIndex = useStore((s) => s.floorIndex)
  const { openFile, setTool, setViewMode, newPlan, fit, undo, redo, switchFloor, addFloor, allFloors } = useStore.getState()
  const input = useRef<HTMLInputElement>(null)
  const [shopping, setShopping] = useState(false)
  const hasPlan = !!plan.source || !!plan.background

  return (
    <header className="toolbar">
      <strong className="brand">FloorPlanner</strong>
      <div className="segmented">
        <button className={viewMode === '2d' ? 'active' : ''} onClick={() => setViewMode('2d')}>
          Plan
        </button>
        <button className={viewMode === '3d' ? 'active' : ''} onClick={() => setViewMode('3d')}>
          3D
        </button>
      </div>
      <button className="primary" onClick={() => input.current?.click()}>
        Open…
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) void openFile(file)
        }}
      />
      <button onClick={() => downloadProject(allFloors(), floorIndex)} disabled={!hasPlan && !plan.walls.length && floors.length < 2}>
        Save project
      </button>
      <button onClick={newPlan}>New</button>
      <select
        className="floor-picker"
        value={floorIndex}
        title="Which floor you're working on"
        onChange={(e) => (e.target.value === 'add' ? addFloor(false) : switchFloor(Number(e.target.value)))}
      >
        {floors.map((f, i) => (
          <option key={i} value={i}>
            {f.name}
          </option>
        ))}
        <option value="add">+ Add a floor</option>
      </select>
      <span className="sep" />
      <button onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
        Undo
      </button>
      <button onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)">
        Redo
      </button>
      <span className="sep" />
      {TOOLS.map((t) => (
        <button
          key={t.tool}
          className={tool === t.tool ? 'active' : ''}
          title={`${t.title} (${t.key})`}
          disabled={viewMode === '3d' || (t.needsPlan && !hasPlan)}
          onClick={() => setTool(t.tool)}
        >
          {t.label}
        </button>
      ))}
      <button onClick={fit} title="Zoom to fit (F)" disabled={viewMode === '3d'}>
        Fit
      </button>
      <span className="sep" />
      <button onClick={() => setShopping(true)} title="Every IKEA article placed, on all floors">
        Shopping list
      </button>
      <button onClick={() => exportView(`${floors[floorIndex]?.name ?? 'plan'}-${viewMode === '3d' ? '3d' : 'plan'}`)} title="Save what you see as a picture">
        Export PNG
      </button>
      {shopping && <ShoppingListDialog floors={allFloors()} onClose={() => setShopping(false)} />}
    </header>
  )
}

/** Saves the plan or 3D view as it is on screen. */
function exportView(name: string) {
  const canvas = document.querySelector<HTMLCanvasElement>('.canvas-wrap canvas, .scene-wrap canvas')
  if (!canvas) return
  canvas.toBlob((blob) => {
    if (!blob) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${name.replace(/[^\w\- ]+/g, '').trim() || 'view'}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }, 'image/png')
}
