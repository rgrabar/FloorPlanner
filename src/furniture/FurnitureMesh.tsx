import { RoundedBox } from '@react-three/drei'
import { useMemo } from 'react'
import * as THREE from 'three'
import type { Model, Part } from './model'

// Draws an expanded furniture model. Model cm (x right, y back->front, z up) become
// three.js metres: model x -> x, model z (up) -> y, model y -> z. The model's corner
// (0, 0, 0) sits at this group's origin; callers place and centre it.

const M = 0.01

const MATERIALS: Record<string, { roughness: number; metalness: number; opacity?: number }> = {
  wood: { roughness: 0.75, metalness: 0 },
  metal: { roughness: 0.35, metalness: 0.6 },
  fabric: { roughness: 1, metalness: 0 },
  plastic: { roughness: 0.5, metalness: 0 },
  stone: { roughness: 0.6, metalness: 0 },
  glass: { roughness: 0.05, metalness: 0, opacity: 0.35 },
}

function PartMaterial({ part }: { part: Part }) {
  const m = MATERIALS[part.mat] ?? MATERIALS.wood
  return (
    <meshStandardMaterial
      color={part.color}
      roughness={m.roughness}
      metalness={m.metalness}
      transparent={m.opacity !== undefined}
      opacity={m.opacity ?? 1}
    />
  )
}

/** A wedge: a box whose top edge on the `slope` side is lowered to the bottom. */
function prismGeometry(w: number, h: number, d: number, slope: Part['slope']) {
  const g = new THREE.BoxGeometry(w, h, d)
  const pos = g.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const low = slope === 'front' ? z > 0 : slope === 'back' ? z < 0 : slope === 'left' ? x < 0 : x > 0
    if (y > 0 && low) pos.setY(i, -h / 2)
  }
  g.computeVertexNormals()
  return g
}

function PartMesh({ part }: { part: Part }) {
  const [x, y, z, w, d, h] = part.box
  // Centre of the part's box in three.js coordinates.
  const center: [number, number, number] = [(x + w / 2) * M, (z + h / 2) * M, (y + d / 2) * M]
  const size: [number, number, number] = [w * M, h * M, d * M]
  const prism = useMemo(
    () => (part.shape === 'prism' ? prismGeometry(size[0], size[1], size[2], part.slope) : null),
    [part.shape, part.slope, size[0], size[1], size[2]],
  )

  if (part.shape === 'box' && part.radius > 0) {
    return (
      <RoundedBox args={size} radius={Math.min(part.radius * M, Math.min(...size) / 2)} smoothness={3} position={center} castShadow receiveShadow>
        <PartMaterial part={part} />
      </RoundedBox>
    )
  }
  if (part.shape === 'cyl') {
    // three.js cylinders run along y (up); turn them for x and y (depth) axes.
    const r = (part.axis === 'z' ? w / 2 : part.axis === 'x' ? d / 2 : w / 2) * M
    const len = (part.axis === 'z' ? h : part.axis === 'x' ? w : d) * M
    const rotation: [number, number, number] = part.axis === 'z' ? [0, 0, 0] : part.axis === 'x' ? [0, 0, Math.PI / 2] : [Math.PI / 2, 0, 0]
    return (
      <mesh position={center} rotation={rotation} castShadow receiveShadow>
        <cylinderGeometry args={[r, r, len, 24]} />
        <PartMaterial part={part} />
      </mesh>
    )
  }
  if (part.shape === 'sphere') {
    return (
      <mesh position={center} castShadow receiveShadow>
        <sphereGeometry args={[(w / 2) * M, 24, 16]} />
        <PartMaterial part={part} />
      </mesh>
    )
  }
  return (
    <mesh position={center} geometry={prism ?? undefined} castShadow receiveShadow>
      {!prism && <boxGeometry args={size} />}
      <PartMaterial part={part} />
    </mesh>
  )
}

export function FurnitureMesh({ model }: { model: Model }) {
  return (
    <group>
      {model.parts.map((p, i) => (
        <PartMesh key={i} part={p} />
      ))}
    </group>
  )
}

/** Translucent planes showing where things can be put (shelves, tops). */
export function SurfaceMarks({ model }: { model: Model }) {
  return (
    <group>
      {model.surfaces.map((s, i) => {
        const [x, y, w, d] = s.area
        return (
          <mesh key={i} position={[(x + w / 2) * M, s.z * M + 0.002, (y + d / 2) * M]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[w * M, d * M]} />
            <meshBasicMaterial color="#16a34a" transparent opacity={0.35} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
        )
      })}
    </group>
  )
}
