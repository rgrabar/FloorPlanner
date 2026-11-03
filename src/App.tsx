import { useEffect, useState } from 'react'
import { PlanCanvas } from './editor/PlanCanvas'
import { startAutosave, useStore } from './store/store'
import { SidePanel } from './ui/SidePanel'
import { Toolbar } from './ui/Toolbar'

export function App() {
  const busy = useStore((s) => s.busy)
  const message = useStore((s) => s.message)
  const { openFile, setTool, fit, showMessage } = useStore.getState()
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    void startAutosave()
  }, [])

  // Keyboard shortcuts for the tools.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.ctrlKey || e.metaKey) return
      const k = e.key.toLowerCase()
      if (k === 'h') setTool('pan')
      else if (k === 'c') setTool('calibrate')
      else if (k === 's') setTool('straighten')
      else if (k === 'f') fit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setTool, fit])

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const file = e.dataTransfer.files[0]
        if (file) void openFile(file)
      }}
    >
      <Toolbar />
      <main className="main">
        <PlanCanvas />
        <SidePanel />
      </main>
      {busy && <div className="status busy">{busy}</div>}
      {message && (
        <div className={`status ${message.kind}`} role="alert">
          <pre>{message.text}</pre>
          <button onClick={() => showMessage(null)}>Close</button>
        </div>
      )}
      {dragging && <div className="drop-overlay">Drop to open</div>}
    </div>
  )
}
