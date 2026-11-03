import { create } from 'zustand'
import { importFile } from '../import'
import { makeBackground } from '../import/image'
import { straightenImage } from '../import/perspective'
import type { ImportResult } from '../import/types'
import { emptyPlan, layersFromLines, scalePlan } from '../model/plan'
import type { LayerRole, Plan, Vec2 } from '../model/types'
import { loadAutosave, readProject, saveAutosave } from '../project/saveLoad'

export type Tool = 'pan' | 'calibrate' | 'straighten'

export interface Message {
  kind: 'info' | 'error'
  text: string
}

interface State {
  plan: Plan
  file: File | null // the imported file, kept to switch pages/levels
  tool: Tool
  busy: string | null
  message: Message | null
  fitToken: number // bumped when the view should zoom to fit the plan
  highlightLayer: string | null // layer under the mouse in the side panel

  openFile(file: File): Promise<void>
  choosePart(index: number): Promise<void>
  calibrate(factor: number): void
  straighten(cornersPx: Vec2[]): Promise<void>
  setLayerRole(name: string, role: LayerRole): void
  setHighlightLayer(name: string | null): void
  setTool(tool: Tool): void
  newPlan(): void
  fit(): void
  showMessage(message: Message | null): void
}

function planFromImport(r: ImportResult, fileName: string): Plan {
  return {
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

  return {
    plan: emptyPlan(),
    file: null,
    tool: 'pan',
    busy: null,
    message: null,
    fitToken: 0,
    highlightLayer: null,

    async openFile(file) {
      if (!confirmReplace()) return
      if (file.name.toLowerCase().endsWith('.json')) {
        await run(`Opening ${file.name}…`, async () => {
          const plan = await readProject(file)
          set((s) => ({ plan, file: null, tool: 'pan', fitToken: s.fitToken + 1 }))
        })
        return
      }
      await run(`Reading ${file.name}…`, async () => {
        const result = await importFile(file)
        set((s) => ({ plan: planFromImport(result, file.name), file, tool: 'pan', fitToken: s.fitToken + 1 }))
      })
    },

    async choosePart(index) {
      const { file, plan } = get()
      if (!file || !plan.source?.parts || !confirmReplace()) return
      const label = plan.source.parts.names[index]
      await run(`Loading ${label}…`, async () => {
        const result = await importFile(file, { part: index })
        set((s) => ({ plan: planFromImport(result, file.name), fitToken: s.fitToken + 1 }))
      })
    },

    calibrate(factor) {
      set((s) => ({ plan: { ...scalePlan(s.plan, factor), source: s.plan.source && { ...s.plan.source, note: undefined } } }))
    },

    async straighten(cornersPx) {
      const bg = get().plan.background
      if (!bg) return
      await run('Straightening the photo…', async () => {
        const src = await straightenImage(bg.src, cornersPx)
        const background = await makeBackground(src, bg.cmPerPx)
        set((s) => ({
          plan: {
            ...s.plan,
            background: { ...background, x: bg.x, y: bg.y },
            scaleKnown: false,
            source: s.plan.source && { ...s.plan.source, format: 'photo', note: 'Photo straightened. Now calibrate the scale.' },
          },
          tool: 'pan',
          fitToken: s.fitToken + 1,
        }))
      })
    },

    setLayerRole(name, role) {
      set((s) => ({ plan: { ...s.plan, layers: s.plan.layers.map((l) => (l.name === name ? { ...l, role } : l)) } }))
    },

    setHighlightLayer(name) {
      set({ highlightLayer: name })
    },

    setTool(tool) {
      set({ tool })
    },

    newPlan() {
      if (!confirmReplace()) return
      set((s) => ({ plan: emptyPlan(), file: null, tool: 'pan', message: null, fitToken: s.fitToken + 1 }))
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
