'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
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
}
const GLB_URL: Record<string, string> = {
  sidearm: '/models/guns/sidearm.glb',
  smg: '/models/guns/smg.glb',
  assault_rifle: '/models/guns/rifle.glb',
  marksman: '/models/guns/marksman.glb',
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
  inner.position.sub(center)
  const longest = Math.max(size.x, size.y, size.z) || 1
  inner.scale.setScalar(1.15 / longest) // fill the small frame rather than float in it
  const g = new THREE.Group()
  g.add(inner)
  return g
}

function GlbGun({ url }: { url: string }) {
  const { scene } = useGLTF(url)
  const model = useMemo(() => normalise(scene), [scene])
  return <primitive object={model} />
}

function ProcGun({ id }: { id: ProceduralGunId }) {
  const model = useMemo(() => normalise(buildProceduralGun(id, PROCEDURAL[id])), [id])
  return <primitive object={model} />
}

function Spin({ children }: { children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      if (ref.current) ref.current.rotation.y += 0.012
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <group ref={ref} rotation={[0.22, 0.6, 0]}>{children}</group>
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
          <hemisphereLight args={['#b8c6d6', '#15161c', 0.7]} />
          <directionalLight position={[2, 3, 2]} intensity={2.6} color="#fff3e0" />
          <directionalLight position={[-2, 0.5, -1.5]} intensity={1.2} color="#7fb0ff" />
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
