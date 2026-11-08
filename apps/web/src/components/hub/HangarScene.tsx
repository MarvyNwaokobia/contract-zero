'use client'

/**
 * The Operations Hub backdrop: the operator's forward hangar at dusk.
 *
 * Procedural, instanced geometry (no baked level art exists yet): a corrugated
 * hangar with a steel truss roof, an open door onto a dusk sky, light shafts,
 * hanging work lamps, hard cases, a workbench with the operator's rifle and a
 * mission tablet, and the operator (the Mixamo rig) standing at the ready.
 * Everything that costs frame time scales with the graphics preset.
 */

import { Suspense, useEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { OperatorRig, type OperatorApi } from '@/engine/scene/OperatorRig'
import { usePbr } from '@/engine/scene/usePbr'
import { QUALITY, type Quality } from '@/lib/settings'

const TEX = '/textures/hangar'
const W = 26 // hangar width (x)
const BACK = -18 // back wall z
const FRONT = 10
const H = 12

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Instanced boxes from a list of [x, y, z, sx, sy, sz, rotY]. */
function Boxes({ items, material, castShadow = false }: { items: number[][]; material: THREE.Material; castShadow?: boolean }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  useEffect(() => {
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    items.forEach(([x, y, z, sx, sy, sz, ry = 0], i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry)
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz))
      ref.current!.setMatrixAt(i, m)
    })
    ref.current!.instanceMatrix.needsUpdate = true
  }, [items])
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, items.length]} material={material} castShadow={castShadow} receiveShadow>
      <boxGeometry />
    </instancedMesh>
  )
}

function Shell() {
  const floor = usePbr('concrete_floor_worn_001', [10, 10], TEX)
  const wall = usePbr('corrugated_iron_02', [6, 2], TEX)
  const plate = usePbr('metal_plate', [2, 2], TEX)
  const floorMat = useMemo(() => new THREE.MeshStandardMaterial({ ...floor, color: '#7a746a', roughness: 0.42, metalness: 0.2 }), [floor])
  const wallMat = useMemo(() => new THREE.MeshStandardMaterial({ ...wall, color: '#6c6f74', roughness: 0.7, metalness: 0.45, side: THREE.DoubleSide }), [wall])
  const steel = useMemo(() => new THREE.MeshStandardMaterial({ ...plate, color: '#3d4148', roughness: 0.55, metalness: 0.7 }), [plate])
  const amberStrip = useMemo(() => new THREE.MeshStandardMaterial({ color: '#000', emissive: '#ff9a2e', emissiveIntensity: 3 }), [])
  const skylight = useMemo(() => new THREE.MeshStandardMaterial({ color: '#000', emissive: '#9fb8cf', emissiveIntensity: 1.4 }), [])

  const { columns, trusses, braces, catwalk } = useMemo(() => {
    const columns: number[][] = []
    const trusses: number[][] = []
    const braces: number[][] = []
    for (let z = BACK + 2; z <= FRONT - 2; z += 4) {
      columns.push([-W / 2 + 0.4, H / 2, z, 0.5, H, 0.5], [W / 2 - 0.4, H / 2, z, 0.5, H, 0.5])
      trusses.push([0, H - 0.6, z, W, 0.35, 0.3], [0, H - 1.6, z, W, 0.18, 0.18])
      for (let x = -W / 2 + 2; x < W / 2 - 1; x += 2.6) braces.push([x, H - 1.1, z, 0.12, 1.2, 0.12, 0])
    }
    for (let x = -W / 2 + 1; x < W / 2; x += 3) trusses.push([x, H - 0.2, (BACK + FRONT) / 2, 0.22, 0.22, FRONT - BACK])
    // A mezzanine walkway along the left wall, with railing posts.
    const catwalk: number[][] = [[-W / 2 + 2, 5, -4, 3, 0.2, 20]]
    for (let z = -13.5; z <= 5.5; z += 1.5) catwalk.push([-W / 2 + 3.4, 5.55, z, 0.06, 1, 0.06])
    catwalk.push([-W / 2 + 3.4, 6.05, -4, 0.06, 0.06, 20])
    return { columns, trusses, braces, catwalk }
  }, [])

  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0, (BACK + FRONT) / 2]} material={floorMat} receiveShadow>
        <planeGeometry args={[W, FRONT - BACK]} />
      </mesh>
      {/* yellow floor safety lines */}
      {[-3.2, 3.2].map((x) => (
        <mesh key={x} rotation-x={-Math.PI / 2} position={[x, 0.005, -3]}>
          <planeGeometry args={[0.12, 22]} />
          <meshStandardMaterial color="#b38a2a" roughness={0.8} />
        </mesh>
      ))}
      {/* side walls */}
      {[-1, 1].map((s) => (
        <mesh key={s} position={[(s * W) / 2, H / 2, (BACK + FRONT) / 2]} rotation-y={(s * -Math.PI) / 2} material={wallMat}>
          <planeGeometry args={[FRONT - BACK, H]} />
        </mesh>
      ))}
      {/* back wall with a door opening (x −7..7, y 0..8) */}
      <mesh position={[-(W / 2 + 7) / 2, H / 2, BACK]} material={wallMat}><planeGeometry args={[W / 2 - 7, H]} /></mesh>
      <mesh position={[(W / 2 + 7) / 2, H / 2, BACK]} material={wallMat}><planeGeometry args={[W / 2 - 7, H]} /></mesh>
      <mesh position={[0, 8 + (H - 8) / 2, BACK]} material={wallMat}><planeGeometry args={[14, H - 8]} /></mesh>
      {/* door frame and the half-open shutter */}
      <Boxes material={steel} items={[[-7, 4, BACK, 0.5, 8, 0.6], [7, 4, BACK, 0.5, 8, 0.6], [0, 8.1, BACK, 14.5, 0.5, 0.6], [0, 7.2, BACK + 0.1, 14, 1.6, 0.15]]} />
      {/* roof */}
      <mesh position={[0, H, (BACK + FRONT) / 2]} rotation-x={Math.PI / 2} material={wallMat}><planeGeometry args={[W, FRONT - BACK]} /></mesh>
      {[-6, 0, 6].map((x) => (
        <mesh key={x} position={[x, H - 0.05, -4]} rotation-x={Math.PI / 2} material={skylight}><planeGeometry args={[1.6, 18]} /></mesh>
      ))}
      <Boxes material={steel} items={columns} castShadow />
      <Boxes material={steel} items={trusses} />
      <Boxes material={steel} items={braces} />
      <Boxes material={steel} items={catwalk} castShadow />
      {/* amber guide lights along the walls */}
      <Boxes material={amberStrip} items={[[-W / 2 + 0.15, 2.6, -4, 0.05, 0.08, 18], [W / 2 - 0.15, 2.6, -4, 0.05, 0.08, 18], [0, 8.45, BACK + 0.35, 13, 0.06, 0.05]]} />
    </group>
  )
}

/** Dusk sky and mountain silhouette seen through the door. */
function Outside() {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        depthWrite: false,
        fog: false,
        uniforms: {},
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
        fragmentShader: `
          varying vec2 vUv;
          float ridge(float x){ return 0.32 + 0.09*sin(x*7.3) + 0.05*sin(x*17.1+1.3) + 0.025*sin(x*41.0); }
          void main(){
            vec3 top = vec3(0.05,0.06,0.10), mid = vec3(0.42,0.20,0.10), low = vec3(0.70,0.38,0.16);
            float y = vUv.y;
            vec3 sky = mix(low, mid, smoothstep(0.28,0.5,y));
            sky = mix(sky, top, smoothstep(0.5,0.95,y));
            float sun = exp(-pow(distance(vUv*vec2(2.5,1.0), vec2(0.64*2.5,0.355))*28.0, 2.0));
            float glow = exp(-pow(distance(vUv*vec2(2.5,1.0), vec2(0.64*2.5,0.36))*5.0, 2.0));
            sky += vec3(1.0,0.62,0.30)*glow*0.35 + vec3(1.0,0.85,0.6)*sun*0.9;
            float m = step(y, ridge(vUv.x));
            vec3 hill = mix(vec3(0.07,0.05,0.05), vec3(0.16,0.10,0.08), smoothstep(0.0,0.4,y));
            hill = mix(hill, vec3(0.45,0.25,0.12), 0.35*exp(-abs(y-ridge(vUv.x))*30.0));
            gl_FragColor = vec4(mix(sky, hill, m), 1.0);
          }`,
      }),
    [],
  )
  return (
    <mesh position={[0, 8, BACK - 22]} material={mat}>
      <planeGeometry args={[90, 36]} />
    </mesh>
  )
}

/** Volumetric-looking shafts: additive cones that fade toward the floor. */
function Shafts() {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: { uColor: { value: new THREE.Color('#ffb066') }, uTime: { value: 0 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
        fragmentShader: `
          uniform vec3 uColor; uniform float uTime; varying vec2 vUv;
          void main(){
            float edge = sin(vUv.x*3.14159);
            float fade = smoothstep(0.0,0.35,vUv.y) * (1.0 - smoothstep(0.75,1.0,vUv.y));
            float flicker = 0.9 + 0.1*sin(uTime*0.7 + vUv.x*6.0);
            gl_FragColor = vec4(uColor, 1.0) * edge * edge * fade * 0.075 * flicker;
          }`,
      }),
    [],
  )
  useFrame((s) => { mat.uniforms.uTime.value = s.clock.elapsedTime })
  return (
    <group>
      {[-4.5, -1, 2.5, 5.5].map((x, i) => (
        <mesh key={x} position={[x * 0.9, 3.6, BACK + 9]} rotation={[-0.32 - i * 0.03, 0.08 * i - 0.1, 0]} material={mat}>
          <cylinderGeometry args={[0.9, 2.6 + i * 0.3, 20, 24, 1, true]} />
        </mesh>
      ))}
    </group>
  )
}

function Dust({ count }: { count: number }) {
  const ref = useRef<THREE.Points>(null)
  const geo = useMemo(() => {
    const r = rng(7)
    const p = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      p[i * 3] = (r() - 0.5) * 16
      p[i * 3 + 1] = r() * 4.5
      p[i * 3 + 2] = BACK + 4 + r() * 15
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(p, 3))
    return g
  }, [count])
  useFrame((_, dt) => {
    const a = geo.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < count; i++) {
      let y = a.getY(i) + dt * 0.05
      if (y > 4.5) y = 0
      a.setY(i, y)
      a.setX(i, a.getX(i) + Math.sin(y + i) * dt * 0.02)
    }
    a.needsUpdate = true
  })
  return (
    <points ref={ref} geometry={geo}>
      <pointsMaterial size={0.025} color="#ffd2a0" transparent opacity={0.4} depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  )
}

function Cases() {
  const caseMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#4a5240', roughness: 0.62, metalness: 0.3 }), [])
  const latchMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#15171a', roughness: 0.4, metalness: 0.8 }), [])
  const palletMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#5a4630', roughness: 0.9 }), [])
  const { cases, latches, pallets } = useMemo(() => {
    const r = rng(42)
    const cases: number[][] = []
    const latches: number[][] = []
    const pallets: number[][] = []
    const stacks: [number, number, number][] = [[-5.5, -2, 0.2], [-4.2, -5, -0.3], [4.6, -3.5, 0.5], [6.2, -8, 0.1], [-7.5, -9, 0.4], [1.2, -10, -0.2], [7.8, 1.5, 0.9]]
    for (const [x, z, ry] of stacks) {
      pallets.push([x, 0.07, z, 2.2, 0.14, 1.6, ry])
      let y = 0.14
      const n = 1 + Math.floor(r() * 3)
      for (let k = 0; k < n; k++) {
        const w = 1.1 + r() * 0.8
        const h = 0.45 + r() * 0.35
        const d = 0.7 + r() * 0.5
        const ox = (r() - 0.5) * 0.4
        cases.push([x + ox, y + h / 2, z, w, h, d, ry])
        latches.push([x + ox, y + h * 0.7, z + (d / 2 + 0.01) * Math.cos(ry), w * 0.92, 0.05, 0.02, ry])
        y += h
      }
    }
    return { cases, latches, pallets }
  }, [])
  return (
    <group>
      <Boxes items={cases} material={caseMat} castShadow />
      <Boxes items={latches} material={latchMat} />
      <Boxes items={pallets} material={palletMat} />
    </group>
  )
}

function Workbench() {
  const { scene } = useGLTF('/models/guns/rifle.glb')
  const rifle = useMemo(() => {
    const g = scene.clone(true)
    const box = new THREE.Box3().setFromObject(g)
    const size = box.getSize(new THREE.Vector3())
    const s = 0.9 / Math.max(size.x, size.y, size.z)
    g.scale.setScalar(s)
    return g
  }, [scene])
  const top = useMemo(() => new THREE.MeshStandardMaterial({ color: '#202327', roughness: 0.45, metalness: 0.6 }), [])
  const screen = useMemo(() => {
    const c = document.createElement('canvas')
    c.width = 512; c.height = 320
    const g = c.getContext('2d')!
    g.fillStyle = '#071018'; g.fillRect(0, 0, 512, 320)
    g.strokeStyle = 'rgba(111,163,199,0.35)'
    for (let i = 0; i < 512; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 320); g.stroke() }
    for (let i = 0; i < 320; i += 32) { g.beginPath(); g.moveTo(0, i); g.lineTo(512, i); g.stroke() }
    g.strokeStyle = '#f0a03c'; g.lineWidth = 3
    for (const r of [18, 42, 70]) { g.beginPath(); g.arc(300, 150, r, 0, Math.PI * 2); g.stroke() }
    g.fillStyle = '#f0a03c'; g.font = 'bold 22px sans-serif'; g.fillText('DUSTLINE DEPOT', 24, 40)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    return new THREE.MeshStandardMaterial({ map: t, emissive: '#ffffff', emissiveMap: t, emissiveIntensity: 1.2 })
  }, [])
  return (
    <group position={[1.55, 0, 2.6]} rotation-y={-0.5}>
      <mesh position={[0, 0.88, 0]} material={top} castShadow receiveShadow><boxGeometry args={[2.8, 0.08, 1.1]} /></mesh>
      {[[-1.3, -0.45], [1.3, -0.45], [-1.3, 0.45], [1.3, 0.45]].map(([x, z]) => (
        <mesh key={`${x}${z}`} position={[x, 0.44, z]} material={top}><boxGeometry args={[0.08, 0.88, 0.08]} /></mesh>
      ))}
      <primitive object={rifle} position={[-0.5, 0.97, 0.05]} rotation={[Math.PI / 2, 0, 0.2]} />
      <mesh position={[0.75, 1.05, -0.05]} rotation={[-1.1, 0, 0.12]} material={screen} castShadow>
        <boxGeometry args={[0.72, 0.46, 0.03]} />
      </mesh>
      <mesh position={[0.15, 0.98, 0.25]}><boxGeometry args={[0.5, 0.12, 0.3]} /><meshStandardMaterial color="#2c3027" roughness={0.7} /></mesh>
    </group>
  )
}

function Operator() {
  const ref = useRef<OperatorApi>(null)
  useEffect(() => { const t = setTimeout(() => ref.current?.setClip('idle'), 50); return () => clearTimeout(t) }, [])
  return (
    <group position={[-0.35, 0, 3.3]} rotation-y={1.15}>
      <OperatorRig ref={ref} modelPath="/characters/glb/operator.glb" />
    </group>
  )
}

function Lamps({ n, shadows }: { n: number; shadows: boolean }) {
  const shade = useMemo(() => new THREE.MeshStandardMaterial({ color: '#1b1d20', roughness: 0.5, metalness: 0.7 }), [])
  const bulb = useMemo(() => new THREE.MeshStandardMaterial({ color: '#000', emissive: '#ffb25c', emissiveIntensity: 6 }), [])
  const spots: [number, number, number][] = [[-2, 6.2, 2], [3.5, 6.2, -2], [-6, 6.2, -7], [5, 6.2, -10]]
  return (
    <group>
      {spots.slice(0, n).map(([x, y, z], i) => (
        <group key={i} position={[x, y, z]}>
          <mesh position={[0, 2.8, 0]}><cylinderGeometry args={[0.01, 0.01, 5.6]} /><meshStandardMaterial color="#111" /></mesh>
          <mesh material={shade}><coneGeometry args={[0.45, 0.35, 16, 1, true]} /></mesh>
          <mesh position={[0, -0.12, 0]} material={bulb}><sphereGeometry args={[0.1, 12, 8]} /></mesh>
          <pointLight position={[0, -0.3, 0]} color="#ffad5a" intensity={22} distance={14} decay={1.6} castShadow={shadows && i === 0} />
        </group>
      ))}
    </group>
  )
}

/** Image-based lighting with no download: metal reads as metal instead of black. */
function Environment() {
  const { gl, scene } = useThree()
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl)
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environment = env
    scene.environmentIntensity = 0.32
    return () => { env.dispose(); pmrem.dispose() }
  }, [gl, scene])
  return null
}

/** High windows along the right wall: dusk light and something to read the wall by. */
function Windows() {
  const glass = useMemo(() => new THREE.MeshStandardMaterial({ color: '#000', emissive: '#d9894a', emissiveIntensity: 1.6 }), [])
  const frame = useMemo(() => new THREE.MeshStandardMaterial({ color: '#1c1e22', roughness: 0.6, metalness: 0.6 }), [])
  const panes: number[][] = []
  const mullions: number[][] = []
  for (let z = BACK + 3; z <= 4; z += 3.5) {
    panes.push([W / 2 - 0.05, 8.6, z, 0.02, 1.8, 2.6])
    mullions.push([W / 2 - 0.08, 8.6, z, 0.06, 1.8, 0.08], [W / 2 - 0.08, 8.6, z, 0.06, 0.08, 2.6])
  }
  return (
    <group>
      <Boxes items={panes} material={glass} />
      <Boxes items={mullions} material={frame} />
    </group>
  )
}

function CameraRig({ onFps }: { onFps?: (fps: number) => void }) {
  const { camera } = useThree()
  const mouse = useRef({ x: 0, y: 0 })
  const frames = useRef({ n: 0, t: 0 })
  useEffect(() => {
    const m = (e: PointerEvent) => { mouse.current.x = e.clientX / window.innerWidth - 0.5; mouse.current.y = e.clientY / window.innerHeight - 0.5 }
    window.addEventListener('pointermove', m)
    return () => window.removeEventListener('pointermove', m)
  }, [])
  useFrame((s, dt) => {
    const t = s.clock.elapsedTime
    const tx = 0.4 + mouse.current.x * 0.6 + Math.sin(t * 0.13) * 0.15
    const ty = 1.75 - mouse.current.y * 0.25 + Math.sin(t * 0.21) * 0.04
    camera.position.x += (tx - camera.position.x) * Math.min(1, dt * 1.5)
    camera.position.y += (ty - camera.position.y) * Math.min(1, dt * 1.5)
    camera.lookAt(0.6, 1.45, -2)
    frames.current.n++
    frames.current.t += dt
    if (frames.current.t > 1) {
      const fps = frames.current.n / frames.current.t
      ;(window as unknown as { __czFps?: number }).__czFps = Math.round(fps)
      onFps?.(fps)
      frames.current = { n: 0, t: 0 }
    }
  })
  return null
}

export default function HangarScene({ quality, onFps }: { quality: Quality; onFps?: (fps: number) => void }) {
  const q = QUALITY[quality]
  return (
    <Canvas
      dpr={q.dpr}
      shadows={q.shadows}
      camera={{ fov: 42, position: [0.4, 1.75, 7.6], near: 0.1, far: 120 }}
      gl={{ antialias: quality !== 'low', toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.05, powerPreference: 'high-performance' }}
      onCreated={({ scene }) => { scene.background = new THREE.Color('#0b0c0f'); scene.fog = new THREE.Fog('#0d0e12', 9, 40) }}
    >
      <ambientLight color="#3a4452" intensity={0.9} />
      <hemisphereLight args={['#8fa9c0', '#3a2716', 0.9]} />
      <directionalLight position={[3, 7, BACK - 14]} color="#ff9a52" intensity={3.2} castShadow={q.shadows} shadow-mapSize={[1024, 1024]} />
      <directionalLight position={[-4, 11, 4]} color="#9fb8cf" intensity={0.9} />
      <spotLight position={[0, 6, BACK + 1]} target-position={[0, 0, 2]} angle={0.7} penumbra={0.8} color="#ffa35a" intensity={60} distance={30} decay={1.4} />
      <pointLight position={[-0.6, 2.4, 5.2]} color="#c9d6e2" intensity={4} distance={6} decay={1.5} />
      <Environment />
      <Suspense fallback={null}>
        <Shell />
        <Windows />
        <Outside />
        <Cases />
        <Workbench />
        <Operator />
      </Suspense>
      <Shafts />
      <Lamps n={q.lamps} shadows={q.shadows} />
      <Dust count={q.dust} />
      <CameraRig onFps={onFps} />
    </Canvas>
  )
}
