import { useEffect, useState } from 'react'
import { planFromImport } from '../detect/planFromImport'
import { importFile } from '../import'
import { boundsOf } from '../model/geometry'
import type { Plan, Vec2 } from '../model/types'
import { joinedEnds, pointOnWall, wallOutline } from '../model/walls'
import { scoreDetection, type Score, type Truth } from './score'

// Test bench for wall detection: http://localhost:5173/?bench  (or ?bench=pdf-app to filter)
// Runs the app's own import and detection on every test plan in bench/ (made by
// tools/make_bench.py, with known answers) and on the real plans in samples/, scores it,
// and saves an overlay picture of each to bench/out/ (dev server only).

const samples = import.meta.glob('../../samples/*.{pdf,png,jpg,svg,dxf}', { query: '?url', import: 'default', eager: true }) as Record<string, string>

interface Row {
  file: string
  style: string
  ms: number
  walls: number
  openings: number
  score?: Score
  scaleError?: number // estimated scale vs the true one (0 = exact)
  error?: string
}

const pct = (v: number) => `${Math.round(v * 100)}%`

export default function Bench() {
  const query = new URLSearchParams(location.search)
  const filter = query.get('bench') ?? ''
  const use = (query.get('use') ?? undefined) as 'picture' | 'lines' | undefined
  const [rows, setRows] = useState<Row[]>([])
  const [status, setStatus] = useState('Starting…')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const manifest: Truth[] = await fetch('/bench/manifest.json').then((r) => (r.ok ? r.json() : []), () => [])
      const cases: { url: string; file: string; truth?: Truth }[] = [
        ...manifest.map((t) => ({ url: `/bench/${t.file}`, file: t.file, truth: t })),
        ...Object.entries(samples).map(([path, url]) => ({ url, file: path.split('/').pop()! })),
      ].filter((c) => c.file.includes(filter))
      const done: Row[] = []
      for (const [i, c] of cases.entries()) {
        if (cancelled) return
        setStatus(`${i + 1}/${cases.length}: ${c.file}`)
        const row: Row = { file: c.file, style: c.truth?.style.replace(/-\d+$/, '') ?? 'real', ms: 0, walls: 0, openings: 0 }
        try {
          const blob = await fetch(c.url).then((r) => r.blob())
          const t0 = performance.now()
          const imported = await importFile(new File([blob], c.file))
          const bg0 = imported.background
          const plan = await planFromImport(imported, c.file, use)
          row.ms = Math.round(performance.now() - t0)
          row.walls = plan.suggestedWalls.length
          row.openings = plan.suggestedOpenings.length
          // Detection may re-estimate the scale; the known answers are in the importer's units.
          const bg1 = plan.background
          const k = bg0 && bg1 ? bg0.cmPerPx / bg1.cmPerPx : 1
          const back = (p: Vec2) => (bg0 && bg1 ? { x: bg0.x + (p.x - bg1.x) * k, y: bg0.y + (p.y - bg1.y) * k } : p)
          const walls = plan.suggestedWalls.map((w) => ({ ...w, a: back(w.a), b: back(w.b), thickness: w.thickness * k }))
          const openings = plan.suggestedOpenings.map((o) => ({ ...o, offset: o.offset * k, width: o.width * k }))
          if (c.truth) {
            row.score = scoreDetection(c.truth, walls, openings)
            if (bg0 && bg1) row.scaleError = k / c.truth.scale - 1
          }
          await save(`${c.file}.png`, await overlay({ ...plan, background: bg0, suggestedWalls: walls, suggestedOpenings: openings }, c.truth))
        } catch (e) {
          row.error = e instanceof Error ? e.message : String(e)
        }
        done.push(row)
        setRows([...done])
      }
      await save('results.json', new Blob([JSON.stringify(done, null, 1)], { type: 'application/json' }))
      setStatus(`Done: ${done.length} plans. Pictures and results.json are in bench/out/.`)
    })()
    return () => {
      cancelled = true
    }
  }, [filter, use])

  const scored = rows.filter((r) => r.score)
  const styles = [...new Set(scored.map((r) => r.style))]
  const avg = (rs: Row[], f: (s: Score) => number) => rs.reduce((t, r) => t + f(r.score!), 0) / rs.length

  return (
    <div style={{ padding: 16, overflow: 'auto', height: '100%' }}>
      <h2>Wall detection bench</h2>
      <p>{status}</p>
      {scored.length > 0 && (
        <table className="bench">
          <thead>
            <tr>
              <th>Style</th><th>Plans</th><th>Walls found</th><th>Walls real</th><th>Missed walls</th><th>Offset</th>
              <th>Thickness</th><th>Doors/windows found</th><th>D/W real</th><th>Kind mix-ups</th><th>Scale error</th>
            </tr>
          </thead>
          <tbody>
            {[...styles, 'all'].map((st) => {
              const rs = st === 'all' ? scored : scored.filter((r) => r.style === st)
              return (
                <tr key={st} style={st === 'all' ? { fontWeight: 600 } : undefined}>
                  <td>{st}</td>
                  <td>{rs.length}</td>
                  <td>{pct(avg(rs, (s) => s.wallRecall))}</td>
                  <td>{pct(avg(rs, (s) => s.wallPrecision))}</td>
                  <td>{rs.reduce((t, r) => t + r.score!.missedWalls, 0)}</td>
                  <td>{avg(rs, (s) => s.offsetCm).toFixed(1)} cm</td>
                  <td>{avg(rs, (s) => s.thicknessCm).toFixed(1)} cm</td>
                  <td>{pct(avg(rs, (s) => s.openingRecall))}</td>
                  <td>{pct(avg(rs, (s) => s.openingPrecision))}</td>
                  <td>{rs.reduce((t, r) => t + r.score!.kindErrors, 0)}</td>
                  <td>{pct(rs.reduce((t, r) => t + Math.abs(r.scaleError ?? 0), 0) / rs.length)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <table className="bench">
        <thead>
          <tr>
            <th>File</th><th>ms</th><th>Walls</th><th>D/W</th><th>Found</th><th>Real</th><th>Missed</th><th>D/W found</th><th>Error</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.file}>
              <td>{r.file}</td>
              <td>{r.ms}</td>
              <td>{r.walls}</td>
              <td>{r.openings}</td>
              <td>{r.score && pct(r.score.wallRecall)}</td>
              <td>{r.score && pct(r.score.wallPrecision)}</td>
              <td>{r.score?.missedWalls}</td>
              <td>{r.score && pct(r.score.openingRecall)}</td>
              <td className="error-text">{r.error}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

async function save(name: string, blob: Blob) {
  await fetch(`/__bench/save?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob })
}

/**
 * The plan with what was found: true walls as green outlines, found walls in blue with red
 * centrelines, doors orange, windows cyan, true openings as small magenta circles.
 */
async function overlay(plan: Plan, truth?: Truth): Promise<Blob> {
  const pts: Vec2[] = plan.suggestedWalls.flatMap((w) => [w.a, w.b])
  const bg = plan.background
  if (bg) pts.push({ x: bg.x, y: bg.y }, { x: bg.x + bg.widthPx * bg.cmPerPx, y: bg.y + bg.heightPx * bg.cmPerPx })
  if (truth) pts.push(...truth.walls.flatMap((w) => [w.a, w.b]))
  if (!bg) for (const l of plan.lines) pts.push(l.a, l.b)
  const b = boundsOf(pts) ?? { minX: 0, minY: 0, maxX: 100, maxY: 100 }
  const k = 1800 / Math.max(b.maxX - b.minX, b.maxY - b.minY, 1)
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil((b.maxX - b.minX) * k) + 20
  canvas.height = Math.ceil((b.maxY - b.minY) * k) + 20
  const ctx = canvas.getContext('2d')!
  const S = (p: Vec2) => ({ x: (p.x - b.minX) * k + 10, y: (p.y - b.minY) * k + 10 })
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  if (bg) {
    const img = new Image()
    img.src = bg.src
    await img.decode()
    const tl = S({ x: bg.x, y: bg.y })
    ctx.globalAlpha = 0.35
    ctx.drawImage(img, tl.x, tl.y, bg.widthPx * bg.cmPerPx * k, bg.heightPx * bg.cmPerPx * k)
    ctx.globalAlpha = 1
  } else {
    ctx.strokeStyle = '#bbb'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const l of plan.lines) {
      ctx.moveTo(S(l.a).x, S(l.a).y)
      ctx.lineTo(S(l.b).x, S(l.b).y)
    }
    ctx.stroke()
  }

  const poly = (p: Vec2[]) => {
    ctx.beginPath()
    p.map(S).forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)))
    ctx.closePath()
  }
  for (const w of plan.suggestedWalls) {
    poly(wallOutline(w, joinedEnds(w, plan.suggestedWalls)))
    ctx.fillStyle = 'rgba(37, 99, 235, 0.35)'
    ctx.fill()
    ctx.strokeStyle = '#dc2626'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(S(w.a).x, S(w.a).y)
    ctx.lineTo(S(w.b).x, S(w.b).y)
    ctx.stroke()
  }
  if (truth) {
    ctx.strokeStyle = '#16a34a'
    ctx.lineWidth = 1.5
    for (const w of truth.walls) {
      poly(wallOutline({ ...w, id: '' }, { a: false, b: false }))
      ctx.stroke()
    }
  }
  const byId = new Map(plan.suggestedWalls.map((w) => [w.id, w]))
  for (const o of plan.suggestedOpenings) {
    const w = byId.get(o.wallId)
    if (!w) continue
    const a = S(pointOnWall(w, o.offset))
    const c = S(pointOnWall(w, o.offset + o.width))
    ctx.strokeStyle = o.kind === 'door' ? '#ea580c' : '#0891b2'
    ctx.lineWidth = Math.max(4, w.thickness * k)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(c.x, c.y)
    ctx.stroke()
  }
  if (truth) {
    for (const o of truth.openings) {
      const c = S(o.center)
      ctx.strokeStyle = o.kind === 'door' ? '#c026d3' : '#7c3aed'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(c.x, c.y, 7, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'))
}
