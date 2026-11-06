import { lazy, Suspense, useEffect, useState } from 'react'
import { PlanCanvas } from './editor/PlanCanvas'
import { furnitureKey } from './furniture/actions'
import { startAutosave, useStore, type Tool } from './store/store'
import { SidePanel } from './ui/SidePanel'
import { Toolbar } from './ui/Toolbar'

// three.js is big, so the 3D view is only loaded when it's first opened.
const Scene3D = lazy(() => import('./three/Scene3D'))

export function App() {
  const busy = useStore((s) => s.busy)
  const message = useStore((s) => s.message)
  const viewMode = useStore((s) => s.viewMode)
  const { openFile, setTool, fit, showMessage, undo, redo } = useStore.getState()
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    void startAutosave()
  }, [])

  // Keyboard shortcuts for undo/redo and the tools.
  useEffect(() => {
    const TOOL_KEYS: Record<string, Tool> = {
      v: 'select',
      h: 'pan',
      w: 'wall',
      d: 'door',
      n: 'window',
      c: 'calibrate',
      s: 'straighten',
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (furnitureKey(e)) return
      const k = e.key.toLowerCase()
      if (e.ctrlKey || e.metaKey) {
        if (k === 'z' && !e.shiftKey) undo()
        else if (k === 'y' || (k === 'z' && e.shiftKey)) redo()
        else return
        e.preventDefault()
        return
      }
      // In 3D, letters are for walking (W A S D), not for switching plan tools.
      if (e.altKey || useStore.getState().viewMode === '3d') return
      if (TOOL_KEYS[k]) setTool(TOOL_KEYS[k])
      else if (k === 'f') fit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setTool, fit, undo, redo])

  return (
    <div
      className="app"
      onDragOver={(e) => {
        // Only files open a plan; furniture dragged from the catalogue is dropped by the views.
        if (!e.dataTransfer.types.includes('Files')) return
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
        {viewMode === '2d' ? (
          <PlanCanvas />
        ) : (
          <Suspense fallback={<div className="scene-wrap loading">Loading 3D…</div>}>
            <Scene3D />
          </Suspense>
        )}
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
