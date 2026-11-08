'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { useGunPrototypes, ALL_GUN_IDS, GUN_LENGTH } from '@/engine/scene/gunModels';
import { buildViewmodelHands, VIEWMODEL_HIP, VIEWMODEL_ADS, WEAPON_VIEW } from '@/engine/scene/viewmodelHands';
import type { GunId } from '@/engine/combat/GunStats';

/**
 * Grip bench (dev only, same rule as /dev/impacts: not wired into a live route).
 *
 * The grip anchors in viewmodelHands are tuned BY EYE — the ten weapons come from
 * three different pipelines and none of them agree on where a receiver sits inside
 * its bounding box, so there is no formula that lands a hand on all ten. This is the
 * bench that makes "by eye" repeatable: every weapon at once, at the framing the
 * player actually sees, so a grip that has slipped is obvious next to nine that
 * haven't.
 *
 * HIP / ADS matches the two positions the viewmodel lerps between, because a grip
 * that reads at the hip can still be buried behind the receiver down the sights.
 */

function Weapon({ id, ads, showHands, rig }: { id: GunId; ads: boolean; showHands: boolean; rig: boolean }) {
  const protos = useGunPrototypes();
  const model = useMemo(() => {
    const g = protos[id].clone(true);
    g.rotateY(Math.PI);                 // same camera-facing turn the viewmodel applies
    g.scale.setScalar(WEAPON_VIEW[id].scale);
    if (showHands) g.add(buildViewmodelHands(id, g, GUN_LENGTH[id]));
    return g;
  }, [protos, id, showHands]);

  // RIG mode parks the weapon at the origin and lets the camera come to it, because
  // the anchors are expressed in the GUN's own frame — they are the same numbers
  // whatever the framing, so they are far easier to judge from a clear three-quarter
  // view than from the player's, where the grip is half off the bottom of the screen.
  if (rig) {
    // Which end is the muzzle is NOT obvious on a dark three-quarter render — half
    // these models have a slim buffer tube at the back that reads exactly like a
    // barrel. Every anchor is signed along that axis, so guessing it wrong inverts
    // the whole table. The marker sits on the prototype's own `muzzle` anchor.
    const muzzle = model.getObjectByName('muzzle');
    const m = muzzle ? muzzle.position : null;
    return (
      <group position={[0, 0, -0.9]}>
        <primitive object={model} />
        {m && (
          <mesh position={[-m.x, m.y, -m.z]}>
            <sphereGeometry args={[0.022, 12, 10]} />
            <meshBasicMaterial color="#ffd400" />
          </mesh>
        )}
      </group>
    );
  }

  // Framing, per-weapon offset and FOV all copied from the scene, so what reads here
  // reads in an op. Getting any one of them wrong makes this bench actively harmful.
  const at = ads ? VIEWMODEL_ADS : VIEWMODEL_HIP;
  const view = WEAPON_VIEW[id];
  return <primitive object={model} position={[at.x, at.y + view.y, at.z + view.z]} />;
}

function Bench({ id, ads, showHands, rig }: { id: GunId; ads: boolean; showHands: boolean; rig: boolean }) {
  return (
    <Canvas
      // Keyed on the view, because r3f reads `camera` only when it MOUNTS — and
      // OrbitControls owns the camera from then on. Without this, switching to rig
      // view changed the numbers and left the camera exactly where it was, which
      // silently showed the player framing while claiming to be the rig.
      key={rig ? 'rig' : 'player'}
      camera={{ position: rig ? [1.05, 0.22, -0.5] : [0, 0, 0], fov: rig ? 40 : ads ? 45 : 55, near: 0.01 }}
      gl={{ antialias: true }} dpr={[1, 2]}
    >
      <color attach="background" args={['#12161c']} />
      {/* Roughly the compound's light, so a grip judged here matches the op. */}
      <hemisphereLight args={['#9fb4c8', '#2a2620', 0.75]} />
      <directionalLight position={[2, 3, 1]} intensity={2.2} color="#fff2dd" />
      <directionalLight position={[-2, 1, 2]} intensity={0.7} color="#6fa8ff" />
      <Suspense fallback={null}>
        <Weapon id={id} ads={ads} showHands={showHands} rig={rig} />
      </Suspense>
      {/* Look straight down -Z, the way the player's camera does, so the weapon
          sits low and right in frame exactly as it does in an op. Targeting the gun
          itself tilted the view down onto it and flattered every grip. Orbit from
          here to check the far side — the side the player never sees is where hands
          usually fall apart. */}
      <OrbitControls target={rig ? [0, -0.04, -0.9] : [0, 0, -1]} />
    </Canvas>
  );
}

export default function GripBenchPage() {
  const [ads, setAds] = useState(false);
  const [hands, setHands] = useState(true);
  const [rig, setRig] = useState(false);
  const [only, setOnly] = useState<GunId | null>(null);
  const shown = only ? [only] : ALL_GUN_IDS;

  // `f` toggles hands off and on — the fastest way to see what they are covering up.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'f') setHands((h) => !h);
      if (e.key === 'a') setAds((a) => !a);
      if (e.key === 'r') setRig((r) => !r);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const btn = (on: boolean): React.CSSProperties => ({
    padding: '6px 10px', cursor: 'pointer', borderRadius: 4, border: '1px solid #2a3440',
    background: on ? '#37d0e0' : '#1b232c', color: on ? '#04141a' : '#8ea3b6',
    font: '600 11px ui-monospace, monospace', letterSpacing: 1, textTransform: 'uppercase',
  });

  return (
    <div style={{ minHeight: '100vh', background: '#0b0e12', padding: 16, color: '#cfe0ee', fontFamily: 'ui-monospace, monospace' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <strong style={{ letterSpacing: 3, fontSize: 12 }}>GRIP BENCH</strong>
        <button style={btn(ads)} onClick={() => setAds((a) => !a)}>{ads ? 'ADS' : 'HIP'} (a)</button>
        <button style={btn(hands)} onClick={() => setHands((h) => !h)}>hands {hands ? 'on' : 'off'} (f)</button>
        <button style={btn(rig)} onClick={() => setRig((r) => !r)}>{rig ? 'rig view' : 'player view'} (r)</button>
        <button style={btn(only === null)} onClick={() => setOnly(null)}>all</button>
        {ALL_GUN_IDS.map((id) => (
          <button key={id} style={btn(only === id)} onClick={() => setOnly(id)}>{id}</button>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: only ? '1fr' : 'repeat(auto-fit, minmax(340px, 1fr))', gap: 12 }}>
        {shown.map((id) => (
          <div key={id} style={{ border: '1px solid #22303c', borderRadius: 10, overflow: 'hidden', background: '#080b0f' }}>
            <div style={{ height: only ? 620 : 250 }}>
              <Bench id={id} ads={ads} showHands={hands} rig={rig} />
            </div>
            <div style={{ padding: '7px 10px', fontSize: 11, letterSpacing: 2, color: '#6f8296' }}>{id}</div>
          </div>
        ))}
      </div>
      <p style={{ fontSize: 11, color: '#6f8296', lineHeight: 1.7, marginTop: 14, maxWidth: 720 }}>
        Anchors live in <code>engine/scene/viewmodelHands.ts</code> (the GRIP table), in each
        weapon&apos;s own normalised frame: barrel +Z, centred on the origin. Firing hand behind
        and below centre, support hand forward. Drag to orbit from the eye.
      </p>
    </div>
  );
}
