'use client'

// Item inspection, shared by the Armory, the loadout and the field. The model is the
// one the game draws (drag to turn it, scroll or pinch to zoom); the figures come from
// `inspectInfo`, which reads only the game's own data.
//
// In a fight the world does NOT stop: opening the inspector means standing still with
// your weapon down while the guards keep coming, and the panel says so.

import { Suspense, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { GunModel, Studio } from '@/components/armory/GunTurntable'
import { AmmoCrate, CargoCase, MedCase } from '@/engine/scene/FieldProps'
import type { Interactable } from '@/engine/fps/field'
import { inspectInfo, type InspectItem } from './itemInfo'

const TONE: Record<string, string> = { owned: '#5fe0a8', temporary: '#ffb454', neutral: '#9fb4c8', locked: '#8a8f98' }

function Prop({ model }: { model: ReturnType<typeof inspectInfo>['model'] }) {
  const fake = useMemo<Interactable>(() => ({
    id: 'inspect', kind: model.prop === 'seized' ? 'seized_case' : model.prop === 'ammo' ? 'ammo_crate' : 'cargo_case',
    pos: [0, 0], y: 0, holdSecs: 0, label: model.label ?? '', state: 'idle', ammoClass: model.cls,
  }), [model])
  if (model.gun) return <group scale={2.2}><GunModel gunId={model.gun} /></group>
  return (
    <group position={[0, -0.3, 0]} scale={1.6}>
      {model.prop === 'ammo' && <AmmoCrate item={fake} />}
      {model.prop === 'med' && <MedCase />}
      {(model.prop === 'cargo' || model.prop === 'seized') && <CargoCase item={fake} label={model.label === 'MEDICAL SUPPLIES' ? 'MEDICAL SUPPLIES' : model.label === 'FUEL' ? 'FUEL' : 'AMMUNITION'} />}
    </group>
  )
}

export function ItemInspector({ item, onClose, inFight = false }: { item: InspectItem; onClose: () => void; inFight?: boolean }) {
  const info = useMemo(() => inspectInfo(item), [item])
  // Portalled to <body>: a transformed or filtered ancestor (panels, the HUD) would
  // otherwise become the containing block of this fixed overlay and clip it.
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => setHost(document.body), [])
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.code === 'Escape' || e.code === 'KeyI') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [onClose])
  if (!host) return null
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`Inspect ${info.title}`} data-testid="inspector">
      <div className="grid max-h-full w-full max-w-4xl overflow-auto border border-line bg-ink text-fog md:grid-cols-[1.2fr_1fr]">
        <div className="relative h-72 md:h-[26rem]" style={{ background: 'radial-gradient(ellipse at 50% 55%, #23272e 0%, #0b0d10 72%)' }}>
          <Canvas camera={{ position: [0, 0.35, 2.6], fov: 32 }} dpr={[1, 1.5]} gl={{ antialias: true, powerPreference: 'low-power' }}>
            <Studio />
            <hemisphereLight args={['#c8d2de', '#1a1c22', 0.9]} />
            <directionalLight position={[2, 3, 2]} intensity={2.4} color="#fff3e0" />
            <directionalLight position={[-2, 0.5, -1.5]} intensity={1.2} color="#ffc372" />
            <Suspense fallback={null}><Prop model={info.model} /></Suspense>
            <OrbitControls enablePan={false} minDistance={1.2} maxDistance={5} makeDefault />
          </Canvas>
          <div className="pointer-events-none absolute bottom-2 left-3 text-[11px] uppercase tracking-widest text-dim">Drag to turn · scroll to zoom</div>
        </div>
        <div className="flex flex-col gap-3 p-5">
          <div>
            <div className="cz-label !text-[10px]">{info.kind}</div>
            <h2 className="font-display text-2xl font-bold uppercase tracking-wide">{info.title}</h2>
            <div className="mt-1 text-sm font-semibold" style={{ color: TONE[info.status.tone] }} data-testid="inspect-status">{info.status.label}</div>
          </div>
          {inFight && <div className="border-l-2 border-amber px-3 py-1 text-xs text-amber-hi">The fight doesn’t stop while you look. You’re standing still with your weapon down.</div>}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid="inspect-stats">
            {info.stats.map((s) => (
              <div key={s.label} className="contents">
                <dt className="text-muted">{s.label}</dt>
                <dd className="text-slate-100">{s.value}</dd>
              </div>
            ))}
          </dl>
          {info.notes.map((n) => <p key={n} className="text-xs text-muted">{n}</p>)}
          <button className="cz-btn cz-btn-ghost mt-auto self-start px-5 py-2 text-sm" onClick={onClose} autoFocus>Close (Esc)</button>
        </div>
      </div>
    </div>,
    host,
  )
}
