import { useRef } from 'react'
import { ACCEPT } from '../import'
import { downloadProject } from '../project/saveLoad'
import { useStore, type Tool } from '../store/store'

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
  const canUndo = useStore((s) => s.past.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  const { openFile, setTool, newPlan, fit, undo, redo } = useStore.getState()
  const input = useRef<HTMLInputElement>(null)
  const hasPlan = !!plan.source || !!plan.background

  return (
    <header className="toolbar">
      <strong className="brand">FloorPlanner</strong>
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
      <button onClick={() => downloadProject(plan)} disabled={!hasPlan && !plan.walls.length}>
        Save project
      </button>
      <button onClick={newPlan}>New</button>
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
          disabled={t.needsPlan && !hasPlan}
          onClick={() => setTool(t.tool)}
        >
          {t.label}
        </button>
      ))}
      <button onClick={fit} title="Zoom to fit (F)">
        Fit
      </button>
    </header>
  )
}
