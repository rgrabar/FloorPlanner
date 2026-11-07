import { create } from 'zustand'
import { importFile } from '../import'
import { makeBackground } from '../import/image'
import { straightenImage } from '../import/perspective'
import { planFromImport, withFoundWalls } from '../detect/planFromImport'
import { emptyPlan, scalePlan } from '../model/plan'
import type { LayerRole, Plan, Vec2 } from '../model/types'
import type { Selection } from '../model/walls'
import { loadAutosave, readProject, saveAutosave } from '../project/saveLoad'

export type Tool = 'select' | 'pan' | 'wall' | 'door' | 'window' | 'calibrate' | 'straighten'

export interface Message {
  kind: 'info' | 'error'
  text: string
}

/** Sizes used for new walls, doors and windows (cm). */
export interface DrawDefaults {
  wallThickness: number
  door: { width: number; height: number }
  window: { width: number; height: number; sill: number }
}

/** How the 3D view looks. */
export interface View3D {
  camera: 'orbit' | 'top' | 'walk'
  ceiling: boolean
  planOnFloor: boolean // the floorplan picture as the floor's texture
  floors: 'current' | 'below' | 'all' // which floors of the building are shown
}

const MAX_UNDO = 100

/** One floor of the building: its own plan (walls, furniture, floorplan picture) and undo history. */
export interface Floor {
  name: string
  plan: Plan
  file: File | null
  past: Plan[]
  future: Plan[]
}

interface State {
  // The floor being edited. Its plan, file and history live in `plan`, `file`, `past` and
  // `future`; `floors[floorIndex]` is only brought up to date when switching floors or saving.
  plan: Plan
  file: File | null // the imported file, kept to switch pages/levels
  floors: Floor[]
  floorIndex: number
  tool: Tool
  viewMode: '2d' | '3d'
  view3d: View3D
  selection: Selection
  defaults: DrawDefaults
  past: Plan[]
  future: Plan[]
  busy: string | null
  message: Message | null
  fitToken: number // bumped when the view should zoom to fit the plan
  highlightLayer: string | null // layer under the mouse in the side panel

  openFile(file: File): Promise<void>
  choosePart(index: number): Promise<void>
  calibrate(factor: number): void
  straighten(cornersPx: Vec2[]): Promise<void>
  setLayerRole(name: string, role: LayerRole): void
  findWalls(): void
  setHighlightLayer(name: string | null): void
  setTool(tool: Tool): void
  setViewMode(mode: '2d' | '3d'): void
  setView3d(patch: Partial<View3D>): void
  select(selection: Selection): void
  setDefaults(patch: Partial<DrawDefaults>): void
  /** An undoable change to the plan. */
  edit(change: (plan: Plan) => Plan): void
  /** Saves an undo step now, for changes made bit by bit with `mutate` (dragging). */
  checkpoint(): void
  mutate(change: (plan: Plan) => Plan): void
  undo(): void
  redo(): void
  newPlan(): void
  fit(): void
  showMessage(message: Message | null): void
  switchFloor(index: number): void
  addFloor(copyCurrent: boolean): void
  renameFloor(index: number, name: string): void
  deleteFloor(index: number): void
  /** Every floor, with the current one up to date. */
  allFloors(): Floor[]
  /** Replaces the whole building (opening a project). */
  loadFloors(floors: Floor[], index: number): void
}

/** The default name for a new floor above the others. */
function floorName(n: number) {
  return n === 0 ? 'Ground floor' : `Floor ${n}`
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export const useStore = create<State>()((set, get) => {
  /** Runs a slow job with a busy message, and shows any error instead of throwing. */
  async function run(label: string, job: () => Promise<void>) {
    set({ busy: label, message: null })
    try {
      await job()
    } catch (e) {
      console.error(e)
      set({ message: { kind: 'error', text: errorText(e) } })
    } finally {
      set({ busy: null })
    }
  }

  function confirmReplace() {
    const { plan, floors } = get()
    const where = floors.length > 1 ? ' on this floor' : ''
    return plan.walls.length === 0 || window.confirm(`Open a new floorplan? The walls you traced${where} will be replaced.`)
  }

  function current(): Floor {
    const s = get()
    return { ...s.floors[s.floorIndex], plan: s.plan, file: s.file, past: s.past, future: s.future }
  }

  /** Makes floor `index` (of `floors`) the one being edited. */
  function show(floors: Floor[], index: number) {
    const f = floors[index]
    set((s) => ({ floors, floorIndex: index, plan: f.plan, file: f.file, past: f.past, future: f.future, selection: null, tool: 'select', fitToken: s.fitToken + 1 }))
  }

  /** Replaces the whole plan (new file, new page): starts a fresh undo history. */
  function replacePlan(plan: Plan, extra: Partial<State> = {}) {
    set((s) => ({ plan, past: [], future: [], selection: null, tool: 'select', fitToken: s.fitToken + 1, ...extra }))
  }

  return {
    plan: emptyPlan(),
    file: null,
    floors: [{ name: floorName(0), plan: emptyPlan(), file: null, past: [], future: [] }],
    floorIndex: 0,
    tool: 'select',
    viewMode: '2d',
    view3d: { camera: 'orbit', ceiling: false, planOnFloor: false, floors: 'below' },
    selection: null,
    defaults: {
      wallThickness: 10,
      door: { width: 90, height: 210 },
      window: { width: 120, height: 120, sill: 90 },
    },
    past: [],
    future: [],
    busy: null,
    message: null,
    fitToken: 0,
    highlightLayer: null,

    async openFile(file) {
      if (!confirmReplace()) return
      if (file.name.toLowerCase().endsWith('.json')) {
        await run(`Opening ${file.name}…`, async () => {
          const project = await readProject(file)
          get().loadFloors(project.floors.map((f) => ({ ...f, file: null, past: [], future: [] })), project.index)
        })
        return
      }
      await run(`Reading ${file.name}…`, async () => {
        const result = await importFile(file)
        replacePlan(await planFromImport(result, file.name), { file })
      })
    },

    async choosePart(index) {
      const { file, plan } = get()
      if (!file || !plan.source?.parts || !confirmReplace()) return
      const label = plan.source.parts.names[index]
      await run(`Loading ${label}…`, async () => {
        replacePlan(await planFromImport(await importFile(file, { part: index }), file.name))
      })
    },

    calibrate(factor) {
      get().edit((p) => ({ ...scalePlan(p, factor), source: p.source && { ...p.source, note: undefined } }))
    },

    async straighten(cornersPx) {
      const bg = get().plan.background
      if (!bg) return
      await run('Straightening the photo…', async () => {
        const src = await straightenImage(bg.src, cornersPx)
        const background = await makeBackground(src, bg.cmPerPx)
        get().edit((p) => ({
          ...p,
          background: { ...background, x: bg.x, y: bg.y },
          scaleKnown: false,
          source: p.source && { ...p.source, format: 'photo', note: 'Photo straightened. Now calibrate the scale.' },
        }))
        set((s) => ({ tool: 'select', fitToken: s.fitToken + 1 }))
      })
    },

    setLayerRole(name, role) {
      get().edit((p) => ({ ...p, layers: p.layers.map((l) => (l.name === name ? { ...l, role } : l)) }))
    },

    findWalls() {
      const before = get().plan.suggestedWalls.length
      get().edit(withFoundWalls)
      const found = get().plan.suggestedWalls.length
      set({
        selection: null,
        message: {
          kind: 'info',
          text: found
            ? `Found ${found} walls and ${get().plan.suggestedOpenings.length} doors/windows. They're shown dashed: accept them or fix them.`
            : `No walls found${before ? ' (the old suggestions were cleared)' : ''}. Check which layers are set to Walls: walls need both outlines on them.`,
        },
      })
    },

    setHighlightLayer(name) {
      set({ highlightLayer: name })
    },

    setTool(tool) {
      set({ tool })
    },

    setViewMode(viewMode) {
      set({ viewMode })
    },

    setView3d(patch) {
      set((s) => ({ view3d: { ...s.view3d, ...patch } }))
    },

    select(selection) {
      set({ selection })
    },

    setDefaults(patch) {
      set((s) => ({ defaults: { ...s.defaults, ...patch } }))
    },

    edit(change) {
      set((s) => {
        const plan = change(s.plan)
        return plan === s.plan ? {} : { plan, past: [...s.past.slice(-MAX_UNDO + 1), s.plan], future: [] }
      })
    },

    checkpoint() {
      set((s) => ({ past: [...s.past.slice(-MAX_UNDO + 1), s.plan], future: [] }))
    },

    mutate(change) {
      set((s) => ({ plan: change(s.plan) }))
    },

    undo() {
      set((s) => {
        const prev = s.past[s.past.length - 1]
        if (!prev) return {}
        return { plan: prev, past: s.past.slice(0, -1), future: [s.plan, ...s.future], selection: null }
      })
    },

    redo() {
      set((s) => {
        const next = s.future[0]
        if (!next) return {}
        return { plan: next, past: [...s.past, s.plan], future: s.future.slice(1), selection: null }
      })
    },

    newPlan() {
      const { floors, plan } = get()
      const anything = floors.length > 1 || plan.walls.length > 0
      if (anything && !window.confirm('Start a new project? All floors and their walls and furniture will be cleared.')) return
      set({ message: null })
      show([{ name: floorName(0), plan: emptyPlan(), file: null, past: [], future: [] }], 0)
    },

    fit() {
      set((s) => ({ fitToken: s.fitToken + 1 }))
    },

    showMessage(message) {
      set({ message })
    },

    allFloors() {
      const s = get()
      return s.floors.map((f, i) => (i === s.floorIndex ? current() : f))
    },

    switchFloor(index) {
      const s = get()
      if (index === s.floorIndex || !s.floors[index]) return
      show(get().allFloors(), index)
    },

    addFloor(copyCurrent) {
      const floors = get().allFloors()
      const here = current()
      // A copy keeps the walls, doors, windows and the floorplan picture, but not the furniture.
      const plan = copyCurrent ? { ...here.plan, furniture: [], suggestedFurniture: [] } : emptyPlan()
      const floor: Floor = { name: floorName(floors.length), plan, file: copyCurrent ? here.file : null, past: [], future: [] }
      show([...floors, floor], floors.length)
    },

    renameFloor(index, name) {
      set((s) => ({ floors: s.floors.map((f, i) => (i === index ? { ...f, name } : f)) }))
    },

    deleteFloor(index) {
      const floors = get().allFloors()
      if (floors.length < 2) return
      const rest = floors.filter((_, i) => i !== index)
      show(rest, Math.min(get().floorIndex > index ? get().floorIndex - 1 : get().floorIndex, rest.length - 1))
    },

    loadFloors(floors, index) {
      show(floors.length ? floors : [{ name: floorName(0), plan: emptyPlan(), file: null, past: [], future: [] }], Math.max(0, Math.min(index, floors.length - 1)))
    },
  }
})

// ---------- autosave ----------

let saveTimer: number | undefined
let started = false

/** Restores the last session, then saves every change. Safe to call more than once. */
export async function startAutosave() {
  if (started) return
  started = true
  try {
    const saved = await loadAutosave()
    if (saved && !useStore.getState().plan.source) {
      useStore.getState().loadFloors(saved.floors.map((f) => ({ ...f, past: [], future: [] })), saved.index)
    }
  } catch (e) {
    console.warn('Could not restore autosave', e)
  }
  useStore.subscribe((s, prev) => {
    if (s.plan === prev.plan && s.file === prev.file && s.floors === prev.floors && s.floorIndex === prev.floorIndex) return
    clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      const state = useStore.getState()
      saveAutosave(state.allFloors(), state.floorIndex).catch((e) => console.warn('Autosave failed', e))
    }, 800)
  })
}

if (import.meta.env.DEV) (window as unknown as { fp: typeof useStore }).fp = useStore
