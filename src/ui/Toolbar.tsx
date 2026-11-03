import { useRef } from 'react'
import { ACCEPT } from '../import'
import { downloadProject } from '../project/saveLoad'
import { useStore, type Tool } from '../store/store'

const TOOLS: { tool: Tool; label: string; key: string; title: string }[] = [
  { tool: 'pan', label: 'Pan', key: 'H', title: 'Drag to move around. The wheel zooms.' },
  { tool: 'calibrate', label: 'Calibrate', key: 'C', title: 'Set the scale from a line of known length' },
  { tool: 'straighten', label: 'Straighten photo', key: 'S', title: 'Fix a photo taken at an angle' },
]

export function Toolbar() {
  const plan = useStore((s) => s.plan)
  const tool = useStore((s) => s.tool)
  const { openFile, setTool, newPlan, fit } = useStore.getState()
  const input = useRef<HTMLInputElement>(null)

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
      <button onClick={() => downloadProject(plan)} disabled={!plan.source}>
        Save project
      </button>
      <button onClick={newPlan}>New</button>
      <span className="sep" />
      {TOOLS.map((t) => (
        <button
          key={t.tool}
          className={tool === t.tool ? 'active' : ''}
          title={`${t.title} (${t.key})`}
          disabled={t.tool !== 'pan' && !plan.source && !plan.background}
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
