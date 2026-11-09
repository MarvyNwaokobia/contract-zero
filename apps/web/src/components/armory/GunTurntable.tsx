'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import type { GunId } from '@/engine/combat/GunStats'
import { buildProceduralGun, type ProceduralGunId } from '@/engine/scene/proceduralGuns'
import { GunIcon } from './GunIcons'

/**
 * A slowly turning 3D preview of a weapon, for the shop listing.
 *
 * A gun is the most expensive thing in the game and a flat side-on icon sells none of
 * it — the shape only reads once it moves. This shows the ACTUAL model the player will
 * hold, rotating, so what's in the shop is what's in their hands.
 *
 * Two things keep a list of these affordable, which matters because a browser will
 * only give you so many WebGL contexts and this sits in a scrolling page:
 *
 *  • The canvas is only mounted while the row is ON SCREEN (IntersectionObserver).
 *    Scrolling past disposes it, so the count stays near what's visible rather than
 *    growing with the catalogue.
 *  • Until then — and while the model loads — it falls back to the flat 2D icon, so
 *    a row always shows something and never pops empty.
 */

const PROCEDURAL: Record<string, number> = {
  ashfall_carbine: 0.72, warden_repeater: 1.06, rift_lance: 1.16, seraph_lmg: 1.02, ember_halo: 0.9,
  sidearm: 0.26, smg: 0.52, marksman: 1.12,
}
const GLB_URL: Record<string, string> = {
  assault_rifle: '/models/guns/rifle.glb',
  legendary: '/models/guns/blaster.glb',
}

/** Normalise any source object into "longest axis along X, centred, unit-ish size". */
function normalise(src: THREE.Object3D): THREE.Group {
  const inner = src.clone(true)
  const box = new THREE.Box3().setFromObject(inner)
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  box.getSize(size)
  box.getCenter(center)
  const longest = Math.max(size.x, size.y, size.z) || 1
  const k = 0.95 / longest // fill the frame with room to sway, never clip
  inner.scale.setScalar(k)
  // The offset is in the parent's units, so it scales with the model: an unscaled
  // offset pushed large models (authored in centimetres) right out of frame.
  inner.position.copy(center).multiplyScalar(-k)
  const g = new THREE.Group()
  g.add(inner)
  return g
}

export function GlbGun({ url }: { url: string }) {
  const { scene } = useGLTF(url)
  const model = useMemo(() => normalise(scene), [scene])
  return <primitive object={model} />
}

export function ProcGun({ id }: { id: ProceduralGunId }) {
  const model = useMemo(() => normalise(buildProceduralGun(id, PROCEDURAL[id])), [id])
  return <primitive object={model} />
}

/** A soft studio to reflect: metal with nothing to reflect renders black. Built
 *  locally (no HDR download), once per canvas. */
export function Studio() {
  const { gl, scene } = useThree()
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl)
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environment = env
    return () => { scene.environment = null; env.dispose(); pmrem.dispose() }
  }, [gl, scene])
  return null
}

/** The model the player holds, normalised to unit size (GLB or procedural). */
export function GunModel({ gunId }: { gunId: GunId }) {
  if (gunId in PROCEDURAL) return <ProcGun id={gunId as ProceduralGunId} />
  const url = GLB_URL[gunId]
  return url ? <GlbGun url={url} /> : null
}

function Spin({ children }: { children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      // Sway around a three-quarter side view instead of spinning: a gun read
      // end-on is a stick, and the profile is what sells it.
      if (ref.current) ref.current.rotation.y = -0.45 + Math.sin(performance.now() / 1600) * 0.55
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <group ref={ref} rotation={[0.12, -0.45, 0]}>{children}</group>
}

export default function GunTurntable({ gunId, className }: { gunId: GunId; className?: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  // Only run a WebGL context for rows the player can actually see.
  useEffect(() => {
    const el = host.current
    if (!el || typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '120px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const isProc = gunId in PROCEDURAL
  const url = GLB_URL[gunId]

  return (
    <div ref={host} className={className} style={{ position: 'relative' }}>
      {visible ? (
        <Canvas
          camera={{ position: [0, 0.22, 1.45], fov: 34 }}
          dpr={1}
          gl={{ antialias: true, powerPreference: 'low-power' }}
          style={{ width: '100%', height: '100%' }}
        >
          <Studio />
          <hemisphereLight args={['#c8d2de', '#1a1c22', 0.9]} />
          <directionalLight position={[2, 3, 2]} intensity={2.4} color="#fff3e0" />
          <directionalLight position={[-2, 0.5, -1.5]} intensity={1.4} color="#ffc372" />
          <directionalLight position={[0, -1, 2]} intensity={0.6} color="#9fc3e0" />
          <Suspense fallback={null}>
            <Spin>
              {isProc ? <ProcGun id={gunId as ProceduralGunId} /> : url ? <GlbGun url={url} /> : null}
            </Spin>
          </Suspense>
        </Canvas>
      ) : (
        // Placeholder while off-screen, so the row never collapses or pops empty.
        <GunIcon gunId={gunId} className="w-full h-full text-slate-500" />
      )}
    </div>
  )
}
