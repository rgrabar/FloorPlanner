import { MapControls, OrbitControls, OrthographicCamera, PerspectiveCamera, PointerLockControls } from '@react-three/drei'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { create } from 'zustand'
import { FurnitureMesh } from '../furniture/FurnitureMesh'
import { blockedClearances, clearanceZones, conflicts, dragFurniture } from '../furniture/fit'
import { modelOf } from '../furniture/placement'
import type { Background, PlacedFurniture, Plan, Vec2 } from '../model/types'
import { useStore } from '../store/store'
import { FURNITURE_DRAG, placeFromCatalogue } from '../ui/Catalogue'
import { NumberField } from '../ui/NumberField'
import { buildingBounds, buildWalls, bumpsIntoWall, M } from './buildings'

// The building is moved so its centre sits at the 3D origin; `Center` converts back.
interface Center {
  x: number // metres
  z: number
  size: number // metres, the longer side of the building
}

const EYE_HEIGHT = 1.65
const WALK_SPEED = 1.4 // m/s
const RUN_SPEED = 3

export default function Scene3D() {
  const plan = useStore((s) => s.plan)
  const view = useStore((s) => s.view3d)
  const bounds = useMemo(() => buildingBounds(plan), [plan])
  // Turns a point on the screen into a point on the floor (set up inside the canvas).
  const floorAt = useRef<((clientX: number, clientY: number) => Vec2 | null) | null>(null)

  if (!bounds) {
    return (
      <div className="scene-wrap">
        <div className="empty">
          <h2>No walls yet</h2>
          <p>Trace walls (or accept the suggested ones) in the Plan view, then come back here.</p>
        </div>
      </div>
    )
  }

  const c: Center = {
    x: ((bounds.minX + bounds.maxX) / 2) * M,
    z: ((bounds.minY + bounds.maxY) / 2) * M,
    size: Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * M,
  }
  const floor = { w: (bounds.maxX - bounds.minX) * M, d: (bounds.maxY - bounds.minY) * M }

  return (
    <div
      className="scene-wrap"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(FURNITURE_DRAG)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(e) => {
        const model = e.dataTransfer.getData(FURNITURE_DRAG)
        const at = model && floorAt.current?.(e.clientX, e.clientY)
        if (!model || !at) return
        e.preventDefault()
        placeFromCatalogue(model, at)
      }}
    >
      <Canvas shadows dpr={[1, 2]} gl={{ preserveDrawingBuffer: true }}>
        <FloorPicker center={c} target={floorAt} />
        <color attach="background" args={['#e8ecf1']} />
        <Lights size={c.size} />
        <group position={[-c.x, 0, -c.z]}>
          <Walls plan={plan} center={c} fade={view.camera === 'orbit'} />
          <FurnitureLayer plan={plan} center={c} interactive={view.camera !== 'walk'} />
          {view.planOnFloor && plan.background && <PlanOnFloor bg={plan.background} />}
        </group>
        {/* Floor under the building, and the ground around it. */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]} receiveShadow>
          <planeGeometry args={[floor.w, floor.d]} />
          <meshStandardMaterial color="#d8c4a0" roughness={0.8} />
        </mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow>
          <planeGeometry args={[c.size * 6, c.size * 6]} />
          <meshStandardMaterial color="#dfe3e8" roughness={1} />
        </mesh>
        {view.ceiling && (
          <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, plan.roomHeight * M, 0]}>
            <planeGeometry args={[floor.w, floor.d]} />
            <meshStandardMaterial color="#fbfaf7" />
          </mesh>
        )}
        {view.camera === 'orbit' && <OrbitRig size={c.size} />}
        {view.camera === 'top' && <TopRig floor={floor} />}
        {view.camera === 'walk' && <WalkRig plan={plan} center={c} />}
      </Canvas>
      <SceneBar />
      {view.camera === 'walk' && <WalkHelp />}
    </div>
  )
}

function Lights({ size }: { size: number }) {
  const s = Math.max(size, 5)
  return (
    <>
      {/* A high sun: short shadows that don't hide the rooms. */}
      <hemisphereLight args={['#ffffff', '#d6d0c4', 1.7]} />
      <directionalLight
        position={[s * 0.35, s * 1.6, s * 0.25]}
        intensity={1.2}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-s}
        shadow-camera-right={s}
        shadow-camera-top={s}
        shadow-camera-bottom={-s}
        shadow-camera-far={s * 4}
        shadow-bias={-0.0005}
      />
    </>
  )
}

/** Do the 2D segments p1–p2 and q1–q2 cross? */
function crosses(p1: THREE.Vector2, p2: THREE.Vector2, q1: THREE.Vector2, q2: THREE.Vector2) {
  const d = (a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  return d(p1, p2, q1) * d(p1, p2, q2) < 0 && d(q1, q2, p1) * d(q1, q2, p2) < 0
}

function Walls({ plan, center, fade }: { plan: Plan; center: Center; fade: boolean }) {
  const meshes = useMemo(() => buildWalls(plan), [plan])
  const materials = useMemo(
    () => meshes.map(() => new THREE.MeshStandardMaterial({ color: '#f4f2ed', roughness: 0.92 })),
    [meshes],
  )
  const glass = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#9fd3f5', transparent: true, opacity: 0.35, roughness: 0.1 }),
    [],
  )
  useEffect(
    () => () => {
      for (const m of meshes) {
        m.geometry.dispose()
        m.glass.forEach((g) => g.dispose())
      }
      materials.forEach((m) => m.dispose())
    },
    [meshes, materials],
  )

  // In orbit view, walls between the camera and what it looks at fade out.
  const cam2 = useMemo(() => new THREE.Vector2(), [])
  const target2 = useMemo(() => new THREE.Vector2(), [])
  const a2 = useMemo(() => new THREE.Vector2(), [])
  const b2 = useMemo(() => new THREE.Vector2(), [])
  useFrame(({ camera, controls }) => {
    const target = (controls as unknown as { target?: THREE.Vector3 } | null)?.target
    cam2.set(camera.position.x + center.x, camera.position.z + center.z)
    target2.set((target?.x ?? 0) + center.x, (target?.z ?? 0) + center.z)
    meshes.forEach(({ wall }, i) => {
      a2.set(wall.a.x * M, wall.a.y * M)
      b2.set(wall.b.x * M, wall.b.y * M)
      const hide = fade && crosses(cam2, target2, a2, b2)
      const m = materials[i]
      m.opacity += ((hide ? 0.12 : 1) - m.opacity) * 0.2
      const see = m.opacity < 0.98
      if (m.transparent !== see) {
        m.transparent = see
        m.depthWrite = !see
        m.needsUpdate = true
      }
    })
  })

  return (
    <>
      {meshes.map((m, i) => (
        <group key={m.wall.id}>
          <mesh geometry={m.geometry} material={materials[i]} castShadow receiveShadow />
          {m.glass.map((g, j) => (
            <mesh key={j} geometry={g} material={glass} />
          ))}
        </group>
      ))}
    </>
  )
}

/**
 * The placed furniture. Click a piece to select it and drag it along the floor: it snaps to walls
 * and other pieces like in the plan (Alt for no snapping). Pieces that overlap or go through a wall
 * show red; the selected one gets a blue outline. Clearance zones are faint on the floor.
 */
function FurnitureLayer({ plan, center, interactive }: { plan: Plan; center: Center; interactive: boolean }) {
  const selection = useStore((s) => s.selection)
  const { camera, gl, controls } = useThree()
  const clash = useMemo(() => conflicts(plan), [plan])
  const blocked = useMemo(() => blockedClearances(plan), [plan])
  const selectedId = selection?.kind === 'furniture' ? selection.id : null

  // The floor point under the mouse, in plan cm.
  const floorAt = (clientX: number, clientY: number): Vec2 | null => {
    const r = gl.domElement.getBoundingClientRect()
    const ray = new THREE.Raycaster()
    ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), camera)
    const hit = new THREE.Vector3()
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return null
    return { x: (hit.x + center.x) / M, y: (hit.z + center.z) / M }
  }

  const startDrag = (f: PlacedFurniture, e: ThreeEvent<PointerEvent>) => {
    if (!interactive || e.button !== 0) return
    e.stopPropagation()
    const { select, checkpoint, mutate } = useStore.getState()
    select({ kind: 'furniture', id: f.id })
    if (f.locked) return
    const start = floorAt(e.nativeEvent.clientX, e.nativeEvent.clientY)
    if (!start) return
    const grab = { x: start.x - f.x, y: start.y - f.y }
    const orbit = controls as unknown as { enabled: boolean } | null
    if (orbit) orbit.enabled = false
    let started = false
    const move = (ev: PointerEvent) => {
      const p = floorAt(ev.clientX, ev.clientY)
      if (!p) return
      if (!started) {
        checkpoint()
        started = true
      }
      const current = useStore.getState().plan.furniture.find((x) => x.id === f.id)
      if (current) mutate((pl) => dragFurniture(pl, current, { x: p.x - grab.x, y: p.y - grab.y }, ev.altKey ? 0 : 12))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (orbit) orbit.enabled = true
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <>
      {plan.furniture.map((f) => (
        <Piece key={f.id} item={f} selected={f.id === selectedId} clash={clash.has(f.id)} onPointerDown={(e) => startDrag(f, e)} />
      ))}
      {plan.furniture.flatMap((f) =>
        clearanceZones(f).map((zone, i) => <FloorPatch key={`${f.id}-${i}`} poly={zone} color={blocked.has(f.id) ? '#ea580c' : '#16a34a'} />),
      )}
    </>
  )
}

/** A piece of furniture: centred on its plan position and turned (plan angles run clockwise seen from above). */
function Piece({ item, selected, clash, onPointerDown }: { item: PlacedFurniture; selected: boolean; clash: boolean; onPointerDown(e: ThreeEvent<PointerEvent>): void }) {
  const model = modelOf(item)
  const outline = useMemo(() => {
    if (!model) return null
    const [w, d, h] = model.size
    return new THREE.EdgesGeometry(new THREE.BoxGeometry(w * M + 0.02, h * M + 0.02, d * M + 0.02))
  }, [model])
  if (!model) return null
  const [w, d, h] = model.size
  return (
    <group
      position={[item.x * M, (item.z ?? 0) * M, item.y * M]}
      rotation={[0, (-item.rotation * Math.PI) / 180, 0]}
      onPointerDown={onPointerDown}
    >
      <group position={[(-w / 2) * M, 0, (-d / 2) * M]}>
        <FurnitureMesh model={model} />
      </group>
      {clash && (
        <mesh position={[0, (h / 2) * M, 0]}>
          <boxGeometry args={[w * M + 0.01, h * M + 0.01, d * M + 0.01]} />
          <meshBasicMaterial color="#ef4444" transparent opacity={0.3} depthWrite={false} />
        </mesh>
      )}
      {selected && outline && (
        <lineSegments geometry={outline} position={[0, (h / 2) * M, 0]}>
          <lineBasicMaterial color="#2563eb" />
        </lineSegments>
      )}
    </group>
  )
}

/** A faint area on the floor (a clearance zone). */
function FloorPatch({ poly, color }: { poly: Vec2[]; color: string }) {
  const geometry = useMemo(() => {
    const shape = new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x * M, p.y * M)))
    const g = new THREE.ShapeGeometry(shape)
    // Shapes are drawn in x/y; the floor is x/z.
    g.rotateX(Math.PI / 2)
    return g
  }, [poly])
  useEffect(() => () => geometry.dispose(), [geometry])
  return (
    <mesh geometry={geometry} position={[0, 0.003, 0]}>
      <meshBasicMaterial color={color} transparent opacity={0.18} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  )
}

/** Gives the page a way to find the floor point under the mouse, for dropping furniture. */
function FloorPicker({ center, target }: { center: Center; target: React.MutableRefObject<((x: number, y: number) => Vec2 | null) | null> }) {
  const { camera, gl } = useThree()
  useEffect(() => {
    const ray = new THREE.Raycaster()
    const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const hit = new THREE.Vector3()
    target.current = (clientX, clientY) => {
      const r = gl.domElement.getBoundingClientRect()
      ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), camera)
      if (!ray.ray.intersectPlane(floor, hit)) return null
      // The building is drawn shifted so its middle is at the origin.
      return { x: (hit.x + center.x) / M, y: (hit.z + center.z) / M }
    }
    return () => {
      target.current = null
    }
  }, [camera, gl, center, target])
  return null
}

function PlanOnFloor({ bg }: { bg: Background }) {
  const texture = useMemo(() => {
    const t = new THREE.TextureLoader().load(bg.src)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 8
    return t
  }, [bg.src])
  useEffect(() => () => texture.dispose(), [texture])
  const w = bg.widthPx * bg.cmPerPx * M
  const h = bg.heightPx * bg.cmPerPx * M
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[bg.x * M + w / 2, 0.004, bg.y * M + h / 2]} receiveShadow>
      <planeGeometry args={[w, h]} />
      <meshStandardMaterial map={texture} transparent opacity={0.85} />
    </mesh>
  )
}

// ---------- cameras ----------

function OrbitRig({ size }: { size: number }) {
  return (
    <>
      <PerspectiveCamera makeDefault fov={50} near={0.05} far={size * 20 + 100} position={[size * 0.75, size * 1.05, size * 1.15]} />
      <OrbitControls makeDefault target={[0, 0.5, 0]} maxPolarAngle={Math.PI / 2 - 0.05} enableDamping />
    </>
  )
}

/** Straight down, without perspective, plan "up" at the top of the screen. */
function TopRig({ floor }: { floor: { w: number; d: number } }) {
  const { size } = useThree()
  const zoom = Math.min(size.width / floor.w, size.height / floor.d) * 0.85
  return (
    <>
      <OrthographicCamera makeDefault position={[0, 50, 0]} up={[0, 0, -1]} zoom={zoom} near={0.1} far={200} onUpdate={(c) => c.lookAt(0, 0, 0)} />
      <MapControls makeDefault target={[0, 0, 0]} enableRotate={false} screenSpacePanning />
    </>
  )
}

/** A free spot near the middle of the building to start walking from. */
function startSpot(plan: Plan, center: Center): THREE.Vector3 {
  const cx = center.x / M
  const cy = center.z / M
  for (let r = 0; r < 2000; r += 25) {
    for (let k = 0; k < Math.max(1, (r / 25) * 8); k++) {
      const angle = (k / Math.max(1, (r / 25) * 8)) * Math.PI * 2
      const x = cx + Math.cos(angle) * r
      const y = cy + Math.sin(angle) * r
      if (!bumpsIntoWall(plan, x, y, 30)) return new THREE.Vector3(x * M - center.x, EYE_HEIGHT, y * M - center.z)
    }
  }
  return new THREE.Vector3(0, EYE_HEIGHT, 0)
}

function WalkRig({ plan, center }: { plan: Plan; center: Center }) {
  const start = useMemo(() => startSpot(plan, center), [plan, center])
  const keys = useRef(new Set<string>())
  const setLocked = useWalkState((s) => s.setLocked)

  useEffect(() => {
    const down = (e: KeyboardEvent) => keys.current.add(e.code)
    const up = (e: KeyboardEvent) => keys.current.delete(e.code)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      setLocked(false)
    }
  }, [setLocked])

  const forward = useMemo(() => new THREE.Vector3(), [])
  const right = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ camera }, dt) => {
    const k = keys.current
    const ahead = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0)
    const side = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0)
    if (!ahead && !side) return
    camera.getWorldDirection(forward)
    forward.y = 0
    forward.normalize()
    right.set(-forward.z, 0, forward.x)
    const step = forward.multiplyScalar(ahead).add(right.multiplyScalar(side))
    step.normalize().multiplyScalar((k.has('ShiftLeft') || k.has('ShiftRight') ? RUN_SPEED : WALK_SPEED) * Math.min(dt, 0.1))
    // Slide along walls: try the whole step, then each direction on its own.
    const blocked = (x: number, z: number) => bumpsIntoWall(plan, (x + center.x) / M, (z + center.z) / M)
    const p = camera.position
    if (!blocked(p.x + step.x, p.z + step.z)) p.set(p.x + step.x, EYE_HEIGHT, p.z + step.z)
    else if (!blocked(p.x + step.x, p.z)) p.x += step.x
    else if (!blocked(p.x, p.z + step.z)) p.z += step.z
  })

  return (
    <>
      <PerspectiveCamera makeDefault fov={70} near={0.05} far={500} position={start} />
      <PointerLockControls selector="#walk-start" onLock={() => setLocked(true)} onUnlock={() => setLocked(false)} />
    </>
  )
}

// Whether the mouse is captured for walking (shared between the canvas and the overlay).
const useWalkState = create<{ locked: boolean; setLocked(v: boolean): void }>()((set) => ({
  locked: false,
  setLocked: (locked) => set({ locked }),
}))

function WalkHelp() {
  const locked = useWalkState((s) => s.locked)
  if (locked) return <div className="walk-help">W A S D to move · Shift to run · mouse to look · Esc to stop</div>
  return (
    <div className="walk-start-wrap">
      <button id="walk-start" className="primary walk-start">
        Click to start walking
      </button>
      <p>Then use W A S D (or the arrow keys) to move and the mouse to look around. Esc stops.</p>
    </div>
  )
}

// ---------- settings bar ----------

function SceneBar() {
  const view = useStore((s) => s.view3d)
  const roomHeight = useStore((s) => s.plan.roomHeight)
  const hasPicture = useStore((s) => !!s.plan.background)
  const { setView3d, edit } = useStore.getState()
  const modes: { mode: typeof view.camera; label: string }[] = [
    { mode: 'orbit', label: 'Orbit' },
    { mode: 'top', label: 'Top' },
    { mode: 'walk', label: 'Walk' },
  ]
  return (
    <div className="scene-bar">
      <div className="segmented">
        {modes.map((m) => (
          <button key={m.mode} className={view.camera === m.mode ? 'active' : ''} onClick={() => setView3d({ camera: m.mode })}>
            {m.label}
          </button>
        ))}
      </div>
      <NumberField label="Room height" value={roomHeight} min={50} onChange={(v) => edit((p) => ({ ...p, roomHeight: v }))} />
      <label className="check">
        <input type="checkbox" checked={view.ceiling} onChange={(e) => setView3d({ ceiling: e.target.checked })} />
        Ceiling
      </label>
      <label className="check" title={hasPicture ? '' : 'Only for floorplans with a picture'}>
        <input
          type="checkbox"
          checked={view.planOnFloor}
          disabled={!hasPicture}
          onChange={(e) => setView3d({ planOnFloor: e.target.checked })}
        />
        Plan on floor
      </label>
    </div>
  )
}
