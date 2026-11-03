import { OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei'
import { Canvas, useThree } from '@react-three/fiber'
import { useMemo, useState } from 'react'
import { NumberField } from '../ui/NumberField'
import { FurnitureMesh, SurfaceMarks } from './FurnitureMesh'
import { expandModel, MODELS, type Model, type ParamValue } from './model'

// A page to check one furniture model against IKEA's photos and dimension drawings:
//   http://localhost:5173/?preview=ikea-billy-80x28x202&view=front
// Views: 34 (from the front left, like IKEA's product photos), front, side (from the right,
// front on the left, like IKEA's side drawings) and top.

type ViewName = '34' | 'front' | 'side' | 'top'
const M = 0.01

export default function ModelPreview() {
  const params = new URLSearchParams(location.search)
  const names = Object.keys(MODELS).sort()
  const [name, setName] = useState(params.get('preview') || names[0] || '')
  const [view, setView] = useState<ViewName>((params.get('view') as ViewName) || '34')
  const [values, setValues] = useState<Record<string, ParamValue>>({})
  const [showSurfaces, setShowSurfaces] = useState(params.get('surfaces') === '1')
  const spec = MODELS[name]

  const result = useMemo((): { model?: Model; error?: string } => {
    if (!spec) return {}
    try {
      return { model: expandModel(spec, values) }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }, [spec, values])

  const choose = (n: string) => {
    setName(n)
    setValues({})
    const url = new URL(location.href)
    url.searchParams.set('preview', n)
    history.replaceState(null, '', url)
  }

  return (
    <div className="preview">
      <aside className="side preview-side">
        <section>
          <h3>Furniture model</h3>
          {names.length ? (
            <select value={name} onChange={(e) => choose(e.target.value)} style={{ width: '100%' }}>
              {names.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          ) : (
            <p className="muted">No models in furniture/ yet.</p>
          )}
          {spec?.ikea && (
            <p>
              <strong>{spec.ikea.name}</strong> {spec.ikea.type}
              {spec.ikea.variant && <span className="muted"> · {spec.ikea.variant}</span>}
              <br />
              <span className="item-links">
                {/* The same article can appear more than once (one per piece). */}
                {[...new Set(spec.ikea.items)].map((item) => (
                  <a key={item} href={`https://www.ikea.com/ie/en/search/?q=${item}`} target="_blank" rel="noreferrer">
                    {spec.ikea!.items.filter((i) => i === item).length > 1 && `${spec.ikea!.items.filter((i) => i === item).length} × `}
                    {item}
                  </a>
                ))}
              </span>
            </p>
          )}
          {result.model && (
            <p className="muted">
              {result.model.size.join(' × ')} cm · {result.model.parts.length} parts · {result.model.surfaces.length} surfaces
            </p>
          )}
          {result.error && <p className="error-text">{result.error}</p>}
        </section>

        {spec?.params && (
          <section>
            <h3>Options</h3>
            <div className="fields">
              {Object.entries(spec.params).map(([key, p]) => {
                const current = values[key] ?? p.default
                if (p.type === 'choice') {
                  return (
                    <label key={key} className="field">
                      {p.label ?? key}
                      <select value={current as string} onChange={(e) => setValues({ ...values, [key]: e.target.value })}>
                        {p.options.map((o) => (
                          <option key={o}>{o}</option>
                        ))}
                      </select>
                    </label>
                  )
                }
                if (p.type === 'number') {
                  return <NumberField key={key} label={p.label ?? key} value={current as number} onChange={(v) => setValues({ ...values, [key]: v })} />
                }
                return <ListField key={key} label={p.label ?? key} value={current as number[]} onChange={(v) => setValues({ ...values, [key]: v })} />
              })}
            </div>
          </section>
        )}

        <section>
          <h3>View</h3>
          <div className="segmented">
            {(['34', 'front', 'side', 'top'] as ViewName[]).map((v) => (
              <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
                {v === '34' ? '3/4' : v[0].toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
          <label className="check" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={showSurfaces} onChange={(e) => setShowSurfaces(e.target.checked)} />
            Show surfaces (green)
          </label>
        </section>
      </aside>

      <div className="scene-wrap preview-scene">
        {result.model && (
          <Canvas shadows dpr={[1, 2]}>
            <color attach="background" args={['#ffffff']} />
            <hemisphereLight args={['#ffffff', '#e4e0d8', 2.6]} />
            <directionalLight
              position={[-1.5, 3, 2.5]}
              intensity={1.1}
              castShadow
              shadow-mapSize={[2048, 2048]}
              shadow-bias={-0.0004}
              shadow-normalBias={0.02}
            />
            <group position={[(-result.model.size[0] / 2) * M, 0, (-result.model.size[1] / 2) * M]}>
              <FurnitureMesh model={result.model} />
              {showSurfaces && <SurfaceMarks model={result.model} />}
            </group>
            <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
              <planeGeometry args={[20, 20]} />
              <shadowMaterial opacity={0.15} />
            </mesh>
            <PreviewCamera key={`${view}-${name}`} view={view} size={result.model.size} />
          </Canvas>
        )}
      </div>
    </div>
  )
}

function PreviewCamera({ view, size }: { view: ViewName; size: [number, number, number] }) {
  const { size: vp } = useThree()
  const [W, D, H] = size.map((v) => v * M)
  const midY = H / 2
  if (view === '34') {
    const far = Math.max(W, D, H) * 2.2
    return (
      <>
        <PerspectiveCamera makeDefault fov={35} position={[-far * 0.55, H * 0.75 + far * 0.25, far * 0.85]} near={0.01} far={100} />
        <OrbitControls makeDefault target={[0, midY, 0]} />
      </>
    )
  }
  // Flat views, scaled to fit, for comparing with dimension drawings.
  const [across, tall] = view === 'front' ? [W, H] : view === 'side' ? [D, H] : [W, D]
  const zoom = Math.min(vp.width / across, vp.height / tall) * 0.8
  const position: [number, number, number] = view === 'front' ? [0, midY, 10] : view === 'side' ? [10, midY, 0] : [0, 10, 0]
  return (
    <>
      <OrthographicCamera
        makeDefault
        position={position}
        up={view === 'top' ? [0, 0, -1] : [0, 1, 0]}
        zoom={zoom}
        near={0.01}
        far={100}
        onUpdate={(c) => c.lookAt(0, view === 'top' ? 0 : midY, 0)}
      />
      <OrbitControls makeDefault target={[0, view === 'top' ? 0 : midY, 0]} enableRotate={false} />
    </>
  )
}

function ListField({ label, value, onChange }: { label: string; value: number[]; onChange(v: number[]): void }) {
  const [text, setText] = useState(value.join(', '))
  const commit = () => {
    const list = text.split(/[,;\s]+/).filter(Boolean).map(Number)
    if (list.every(Number.isFinite)) onChange(list)
    else setText(value.join(', '))
  }
  return (
    <label className="field" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      {label} (comma separated)
      <input value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    </label>
  )
}
