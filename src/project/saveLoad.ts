import { del, get, set } from 'idb-keyval'
import { emptyPlan } from '../model/plan'
import type { Plan } from '../model/types'

const APP = 'FloorPlanner'

/** A floor as saved: its name and plan (the imported file only goes into the autosave). */
export interface SavedFloor {
  name: string
  plan: Plan
}

export function downloadProject(floors: SavedFloor[], index: number) {
  const first = floors.find((f) => f.plan.source)?.plan ?? floors[0]?.plan
  const name = (first?.source?.fileName ?? 'floorplan').replace(/\.[^.]+$/, '')
  // `plan` (the floor shown) is kept for older versions of the app, which read only that.
  const data = { app: APP, plan: floors[index]?.plan, floors, floor: index }
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${name}.floorplan.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export async function readProject(file: File): Promise<{ floors: SavedFloor[]; index: number }> {
  let data: { app?: string; plan?: Partial<Plan>; floors?: { name?: string; plan?: Partial<Plan> }[]; floor?: number }
  try {
    data = JSON.parse(await file.text())
  } catch {
    throw new Error(`"${file.name}" isn't a FloorPlanner project.`)
  }
  if (data.app !== APP) throw new Error(`"${file.name}" isn't a FloorPlanner project.`)
  // Projects from before floors have one plan.
  const floors = data.floors?.length ? data.floors : data.plan ? [{ name: 'Ground floor', plan: data.plan }] : []
  if (!floors.length || floors.some((f) => f.plan?.version !== 1)) throw new Error(`"${file.name}" isn't a FloorPlanner project.`)
  return {
    floors: floors.map((f, i) => ({ name: f.name || (i ? `Floor ${i}` : 'Ground floor'), plan: { ...emptyPlan(), ...f.plan } })),
    index: data.floor ?? 0,
  }
}

// Autosave goes to IndexedDB rather than localStorage: plan images are often larger than
// localStorage's ~5 MB limit. The original files are kept too, so pages/levels can still be switched.

export async function saveAutosave(floors: (SavedFloor & { file: File | null })[], index: number) {
  await set('autosave-floors', { floors: floors.map((f) => ({ name: f.name, plan: f.plan })), index })
  await set('autosave-files', floors.map((f) => f.file))
  // The single-floor keys of older versions.
  await del('autosave-plan')
  await del('autosave-file')
}

export async function loadAutosave(): Promise<{ floors: (SavedFloor & { file: File | null })[]; index: number } | null> {
  const saved = await get<{ floors: SavedFloor[]; index: number }>('autosave-floors')
  if (saved?.floors.length) {
    const files = (await get<(File | null)[]>('autosave-files')) ?? []
    return {
      floors: saved.floors.map((f, i) => ({ name: f.name, plan: { ...emptyPlan(), ...f.plan }, file: files[i] ?? null })),
      index: saved.index,
    }
  }
  const plan = await get<Plan>('autosave-plan')
  if (!plan) return null
  return { floors: [{ name: 'Ground floor', plan: { ...emptyPlan(), ...plan }, file: (await get<File>('autosave-file')) ?? null }], index: 0 }
}
