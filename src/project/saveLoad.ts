import { del, get, set } from 'idb-keyval'
import { emptyPlan } from '../model/plan'
import type { Plan } from '../model/types'

const APP = 'FloorPlanner'

export function downloadProject(plan: Plan) {
  const name = (plan.source?.fileName ?? 'floorplan').replace(/\.[^.]+$/, '')
  const blob = new Blob([JSON.stringify({ app: APP, plan })], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${name}.floorplan.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export async function readProject(file: File): Promise<Plan> {
  let data: { app?: string; plan?: Partial<Plan> }
  try {
    data = JSON.parse(await file.text())
  } catch {
    throw new Error(`"${file.name}" isn't a FloorPlanner project.`)
  }
  if (data.app !== APP || data.plan?.version !== 1) throw new Error(`"${file.name}" isn't a FloorPlanner project.`)
  return { ...emptyPlan(), ...data.plan }
}

// Autosave goes to IndexedDB rather than localStorage: plan images are often larger than
// localStorage's ~5 MB limit. The original file is kept too, so pages/levels can still be switched.

export async function saveAutosave(plan: Plan, file: File | null) {
  await set('autosave-plan', plan)
  if (file) await set('autosave-file', file)
  else await del('autosave-file')
}

export async function loadAutosave(): Promise<{ plan: Plan; file: File | null } | null> {
  const plan = await get<Plan>('autosave-plan')
  if (!plan) return null
  return { plan: { ...emptyPlan(), ...plan }, file: (await get<File>('autosave-file')) ?? null }
}
