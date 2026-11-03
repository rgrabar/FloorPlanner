import { create } from 'zustand'
import { importFile } from '../import'
import { makeBackground } from '../import/image'
import { straightenImage } from '../import/perspective'
import type { ImportResult } from '../import/types'
import { emptyPlan, layersFromLines, scalePlan } from '../model/plan'
import type { LayerRole, Plan, Vec2 } from '../model/types'
import type { Selection } from '../model/walls'
import { wallsFromLines } from '../model/wallsFromLines'
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

const MAX_UNDO = 100

interface State {
  plan: Plan
  file: File | null // the imported file, kept to switch pages/levels
  tool: Tool
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
}

function planFromImport(r: ImportResult, fileName: string): Plan {
  const plan: Plan = {
    ...emptyPlan(),
    source: { fileName, format: r.format, parts: r.parts, note: r.note },
    scaleKnown: r.scaleKnown,
    background: r.background,
    lines: r.lines,
    layers: layersFromLines(r.lines),
    suggestedWalls: r.suggestedWalls,
    suggestedOpenings: r.suggestedOpenings,
    rooms: r.rooms,
  }
  // Vector files with recognisable wall layers get wall suggestions straight away.
  if (!plan.suggestedWalls.length && plan.layers.some((l) => l.role === 'wall')) return withFoundWalls(plan)
  return plan
}

function withFoundWalls(plan: Plan): Plan {
  const found = wallsFromLines(plan.lines, new Map(plan.layers.map((l) => [l.name, l.role])))
  return { ...plan, suggestedWalls: found.walls, suggestedOpenings: found.openings }
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
    const { plan } = get()
    return plan.walls.length === 0 || window.confirm('Open a new floorplan? The walls you traced will be replaced.')
  }

  /** Replaces the whole plan (new file, new page): starts a fresh undo history. */
  function replacePlan(plan: Plan, extra: Partial<State> = {}) {
    set((s) => ({ plan, past: [], future: [], selection: null, tool: 'select', fitToken: s.fitToken + 1, ...extra }))
  }

  return {
    plan: emptyPlan(),
    file: null,
    tool: 'select',
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
        await run(`Opening ${file.name}…`, async () => replacePlan(await readProject(file), { file: null }))
        return
      }
      await run(`Reading ${file.name}…`, async () => {
        const result = await importFile(file)
        replacePlan(planFromImport(result, file.name), { file })
      })
    },

    async choosePart(index) {
      const { file, plan } = get()
      if (!file || !plan.source?.parts || !confirmReplace()) return
      const label = plan.source.parts.names[index]
      await run(`Loading ${label}…`, async () => {
        replacePlan(planFromImport(await importFile(file, { part: index }), file.name))
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
      if (!confirmReplace()) return
      replacePlan(emptyPlan(), { file: null, message: null })
    },

    fit() {
      set((s) => ({ fitToken: s.fitToken + 1 }))
    },

    showMessage(message) {
      set({ message })
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
      useStore.setState((s) => ({ plan: saved.plan, file: saved.file, fitToken: s.fitToken + 1 }))
    }
  } catch (e) {
    console.warn('Could not restore autosave', e)
  }
  useStore.subscribe((s, prev) => {
    if (s.plan === prev.plan && s.file === prev.file) return
    clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      saveAutosave(s.plan, s.file).catch((e) => console.warn('Autosave failed', e))
    }, 800)
  })
}

if (import.meta.env.DEV) (window as unknown as { fp: typeof useStore }).fp = useStore
