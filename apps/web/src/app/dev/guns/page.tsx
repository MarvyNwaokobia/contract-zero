'use client';

import { Suspense, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment } from '@react-three/drei';
import { buildProceduralGun, type ProceduralGunId } from '@/engine/scene/proceduralGuns';
import { GUN_CATALOG, gunDps } from '@/engine/combat/GunStats';

/** Showcase for the seasonal weapons — one lit turntable per gun, so the models can
 *  be judged as objects before they go on sale. Dev only. */

const GUNS: { id: ProceduralGunId; len: number; price: number }[] = [
  { id: 'ashfall_carbine', len: 0.72, price: 3000 },
  { id: 'warden_repeater', len: 1.06, price: 4500 },
  { id: 'rift_lance', len: 1.16, price: 6500 },
  { id: 'seraph_lmg', len: 1.02, price: 8000 },
  { id: 'ember_halo', len: 0.9, price: 10000 },
];

function GunView({ id, len }: { id: ProceduralGunId; len: number }) {
  const model = useMemo(() => buildProceduralGun(id, len), [id, len]);
  return (
    <group rotation={[0.18, -0.62, 0]} scale={1.5 / len}>
      <primitive object={model} />
    </group>
  );
}

function Stage({ id, len }: { id: ProceduralGunId; len: number }) {
  return (
    <Canvas camera={{ position: [0, 0.25, 1.5], fov: 40 }} gl={{ antialias: true }} dpr={[1, 2]}>
      <color attach="background" args={['#0b0c10']} />
      <hemisphereLight args={['#9fb4c8', '#1a1a22', 0.5]} />
      <directionalLight position={[3, 4, 2]} intensity={2.4} color="#fff4e2" />
      <directionalLight position={[-3, 1, -2]} intensity={1.1} color="#6fa8ff" />
      <spotLight position={[0, 3, 3]} angle={0.6} penumbra={1} intensity={2} />
      <Suspense fallback={null}>
        <GunView id={id} len={len} />
        <Environment preset="city" />
      </Suspense>
      <OrbitControls enablePan={false} autoRotate autoRotateSpeed={1.4} />
    </Canvas>
  );
}

export default function GunShowcasePage() {
  return (
    <div style={{ minHeight: '100vh', background: '#04030c', padding: 24, color: '#e9edf2', fontFamily: 'system-ui' }}>
      <p style={{ fontSize: 11, letterSpacing: 4, color: '#eab308', fontWeight: 700 }}>SEASONAL ARMOURY</p>
      <h1 style={{ fontSize: 30, fontWeight: 900, margin: '4px 0 20px' }}>Five new weapons</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        {GUNS.map((g) => {
          const s = GUN_CATALOG[g.id];
          return (
            <div key={g.id} style={{ border: '1px solid #2a2a3a', borderRadius: 16, overflow: 'hidden', background: 'rgba(8,8,14,0.9)' }}>
              <div style={{ height: 240 }}>
                <Stage id={g.id} len={g.len} />
              </div>
              <div style={{ padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 900, fontSize: 18 }}>{s.name}</span>
                  <span style={{ color: '#eab308', fontWeight: 800 }}>{g.price.toLocaleString()} CR</span>
                </div>
                <p style={{ color: '#64748b', fontSize: 12, margin: '4px 0 8px' }}>
                  TIER {s.tier} · {gunDps(s).toFixed(0)} DPS
                </p>
                <p style={{ color: '#94a3b8', fontSize: 12, lineHeight: 1.5 }}>
                  {s.damage} dmg · {s.fireRate} rpm · {(s.accuracy * 100).toFixed(0)}% acc · {s.magazine} rounds · {s.reloadTime}s reload
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
