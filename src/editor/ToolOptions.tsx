import { useStore } from '../store/store'
import { NumberField } from '../ui/NumberField'

/** Sizes for the next wall, door or window, shown while that tool is active. */
export function ToolOptions() {
  const tool = useStore((s) => s.tool)
  const d = useStore((s) => s.defaults)
  const { setDefaults } = useStore.getState()

  if (tool === 'wall') {
    return (
      <div className="tool-options">
        <NumberField label="Thickness" value={d.wallThickness} min={1} onChange={(v) => setDefaults({ wallThickness: v })} />
      </div>
    )
  }
  if (tool === 'door') {
    return (
      <div className="tool-options">
        <NumberField label="Width" value={d.door.width} min={10} onChange={(v) => setDefaults({ door: { ...d.door, width: v } })} />
        <NumberField label="Height" value={d.door.height} min={10} onChange={(v) => setDefaults({ door: { ...d.door, height: v } })} />
      </div>
    )
  }
  if (tool === 'window') {
    return (
      <div className="tool-options">
        <NumberField label="Width" value={d.window.width} min={10} onChange={(v) => setDefaults({ window: { ...d.window, width: v } })} />
        <NumberField label="Height" value={d.window.height} min={10} onChange={(v) => setDefaults({ window: { ...d.window, height: v } })} />
        <NumberField label="Sill" value={d.window.sill} onChange={(v) => setDefaults({ window: { ...d.window, sill: v } })} />
      </div>
    )
  }
  return null
}
