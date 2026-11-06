import { newId } from '../model/geometry'
import type { PlacedFurniture } from '../model/types'
import { useStore } from '../store/store'
import { dropOrphans, moveFurniture } from './fit'
import { axes, modelOf } from './placement'

// What can be done to the selected piece, from the keyboard (both views) and the side panel.

function selectedPiece(): PlacedFurniture | null {
  const { plan, selection } = useStore.getState()
  if (selection?.kind !== 'furniture') return null
  return plan.furniture.find((f) => f.id === selection.id) ?? plan.suggestedFurniture.find((f) => f.id === selection.id) ?? null
}

/** Turns the selected piece (and what stands on it) by `degrees`, clockwise seen from above. */
export function turnSelected(degrees: number) {
  const f = selectedPiece()
  if (!f || f.locked) return
  useStore.getState().edit((p) => moveFurniture(p, f.id, { x: f.x, y: f.y, rotation: (((f.rotation + degrees) % 360) + 360) % 360 }))
}

/** A copy of the selected piece beside it (to its right), selected. Its options come along. */
export function duplicateSelected() {
  const f = selectedPiece()
  if (!f) return
  const { edit, select } = useStore.getState()
  const step = (modelOf(f)?.size[0] ?? 50) + 10
  const { u } = axes(f)
  const copy: PlacedFurniture = { ...f, id: newId(), x: f.x + u.x * step, y: f.y + u.y * step, locked: false, label: undefined }
  edit((p) => ({ ...p, furniture: [...p.furniture, copy] }))
  select({ kind: 'furniture', id: copy.id })
}

export function toggleLockSelected() {
  const f = selectedPiece()
  if (!f) return
  useStore.getState().edit((p) => ({ ...p, furniture: p.furniture.map((o) => (o.id === f.id ? { ...o, locked: !o.locked } : o)) }))
}

export function deleteSelected() {
  const f = selectedPiece()
  if (!f) return
  const { edit, select } = useStore.getState()
  edit((p) =>
    dropOrphans({
      ...p,
      furniture: p.furniture.filter((o) => o.id !== f.id),
      suggestedFurniture: p.suggestedFurniture.filter((o) => o.id !== f.id),
    }),
  )
  select(null)
}

/** Keys for the selected piece: R / Shift+R turn, Ctrl+D copies, L locks, Delete removes. */
export function furnitureKey(e: KeyboardEvent): boolean {
  if (!selectedPiece()) return false
  const k = e.key.toLowerCase()
  if ((e.ctrlKey || e.metaKey) && k === 'd') duplicateSelected()
  else if (e.ctrlKey || e.metaKey || e.altKey) return false
  else if (k === 'r') turnSelected(e.shiftKey ? -90 : 90)
  else if (k === 'l') toggleLockSelected()
  else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected()
  else return false
  e.preventDefault()
  return true
}
