'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { usePbr } from '@/engine/scene/usePbr';
import { makeTriplanarMaterial } from '@/engine/scene/triplanar';
import { ImpactFX, type ImpactSurface } from '@/engine/vfx/ImpactFX';
import { useImpactTextures } from '@/engine/vfx/useImpactTextures';

/**
 * Surface + impact sandbox (dev only, same rule as /dev/verb: nothing here is
 * wired into a live route).
 *
 * THREE things to look at:
 *
 *  1. The wall pair. Both are the SAME unit cube scaled to size, textured with the
 *     same brick maps. The left one is UV-mapped the way the arena used to be, so
 *     the brick stretches to whatever shape the box is. The right one is triplanar,
 *     so the brick is the same size in metres on every box, whatever its scale.
 *     Look along the row: the left bricks change size per block, the right ones
 *     don't.
 *
 *  2. The OCTAVES toggle, on the triplanar wall. Off, it is one tiling texture and
 *     the narrow pillar in the middle — the closest thing here to what the player
 *     stands next to in the compound — is a magnified blur. On, a fine octave puts
 *     grain back at the pixel scale and a coarse one breaks up the repeat. Orbit in
 *     close to the pillar and toggle it; that is the comparison this exists for.
 *
 *  3. Impacts. Rounds land on the wall and the ground on a loop: flash, sparks,
 *     embers, the dust ring that runs out along the face, chips, hanging smoke and
 *     a bullet hole that stays. This is where to tune the look — the numbers all
 *     live in ImpactFX's SURFACES table.
 */

// Deliberately mismatched: one long low wall, one narrow pillar, one small crate.
// Under UV mapping each gets the whole texture across its face, so the brick comes
// out a different size on all three.
const BLOCKS: { x: number; w: number; h: number; d: number }[] = [
  { x: -1.3, w: 3.0, h: 2.2, d: 0.4 },
  { x: 0.7, w: 0.6, h: 3.0, d: 0.4 },
  { x: 1.8, w: 0.9, h: 0.9, d: 0.4 },
];

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

function Walls({ x, triplanar, octaves }: { x: number; triplanar: boolean; octaves?: boolean }) {
  const brick = usePbr('broken_brick_wall', [1, 1]);
  const material = useMemo(() => (
    triplanar
      ? makeTriplanarMaterial(brick, { roughness: 1, metalness: 0 }, {
        metresPerTile: 1.7,
        // The numbers the compound's brick actually ships with.
        ...(octaves ? { detail: 9.3, detailAmount: 0.62, macro: 0.13, macroAmount: 0.3 } : {}),
      })
      : new THREE.MeshStandardMaterial({ ...brick, roughness: 1, metalness: 0 })
  ), [brick, triplanar, octaves]);
  useEffect(() => () => material.dispose(), [material]);

  return (
    <group position={[x, 0, 0]}>
      {BLOCKS.map((b, i) => (
        <mesh key={i} geometry={UNIT_BOX} position={[b.x, b.h / 2, 0]} scale={[b.w, b.h, b.d]} castShadow receiveShadow>
          <primitive object={material} attach="material" />
        </mesh>
      ))}
    </group>
  );
}

function Ground() {
  const maps = usePbr('burned_ground_01', [1, 1]);
  const material = useMemo(
    () => makeTriplanarMaterial(maps, { roughness: 1, metalness: 0 }, { metresPerTile: 1.9 }),
    [maps],
  );
  useEffect(() => () => material.dispose(), [material]);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[40, 40]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}

/** Puts rounds into the scenery on a loop so the burst can be watched, not caught. */
function Impacts({ surface, running }: { surface: ImpactSurface; running: boolean }) {
  const maps = useImpactTextures();
  const fx = useMemo(() => new ImpactFX(maps), [maps]);
  useEffect(() => () => fx.dispose(), [fx]);

  const next = useRef(0);
  useFrame((state, dt) => {
    // Ambient ash, the same call the scene makes every frame. Runs whether or not
    // fire is paused — it is atmosphere, not an impact.
    fx.ambient(dt, [state.camera.position.x, state.camera.position.y, state.camera.position.z]);
    fx.update(dt);
    if (!running) return;
    next.current -= dt;
    if (next.current > 0) return;
    next.current = 0.18;

    // Alternate between the right-hand wall's face (normal +Z) and the deck in
    // front of it (normal +Y), so both orientations of decal get exercised.
    if (Math.random() < 0.6) {
      fx.burst([
        1.6 + Math.random() * 2.8,
        0.5 + Math.random() * 1.5,
        0.21,
      ], [0, 0, 1], surface);
    } else {
      fx.burst([
        -2 + Math.random() * 6,
        0,
        1.4 + Math.random() * 2,
      ], [0, 1, 0], surface === 'concrete' ? 'dirt' : surface);
    }
  });

  return <primitive object={fx.group} />;
}

export default function ImpactSandboxPage() {
  const [surface, setSurface] = useState<ImpactSurface>('concrete');
  const [running, setRunning] = useState(true);
  const [octaves, setOctaves] = useState(true);

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0b0e12' }}>
      <Canvas shadows camera={{ position: [0, 2.1, 7.6], fov: 58 }}>
        <color attach="background" args={['#141a20']} />
        <fog attach="fog" args={['#141a20', 12, 42]} />
        <hemisphereLight args={['#9fb4c8', '#2a2620', 0.7]} />
        <directionalLight position={[5, 9, 6]} intensity={2.2} castShadow shadow-mapSize={[1024, 1024]} />
        <ambientLight intensity={0.25} />
        <Suspense fallback={null}>
          <Ground />
          {/* left: the old UV mapping. right: triplanar. Same boxes, same maps. */}
          <Walls x={-3.4} triplanar={false} />
          <Walls x={3.4} triplanar octaves={octaves} />
          <Impacts surface={surface} running={running} />
        </Suspense>
        <OrbitControls target={[0, 1.2, 0]} />
      </Canvas>

      <div style={{
        position: 'absolute', left: 16, top: 16, display: 'flex', gap: 8, alignItems: 'center',
        font: '600 12px ui-monospace, monospace', color: '#cfe0ee', letterSpacing: 1,
      }}>
        {(['concrete', 'dirt', 'wood', 'metal', 'flesh'] as ImpactSurface[]).map((s) => (
          <button
            key={s}
            onClick={() => setSurface(s)}
            style={{
              padding: '6px 10px', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: 1,
              background: surface === s ? '#37d0e0' : '#1b232c',
              color: surface === s ? '#04141a' : '#8ea3b6',
              border: '1px solid #2a3440', borderRadius: 4,
            }}
          >
            {s}
          </button>
        ))}
        <button
          onClick={() => setRunning((r) => !r)}
          style={{ padding: '6px 10px', cursor: 'pointer', background: '#1b232c', color: '#8ea3b6', border: '1px solid #2a3440', borderRadius: 4 }}
        >
          {running ? 'PAUSE FIRE' : 'RESUME FIRE'}
        </button>
        <button
          onClick={() => setOctaves((o) => !o)}
          style={{
            padding: '6px 10px', cursor: 'pointer', borderRadius: 4, border: '1px solid #2a3440',
            background: octaves ? '#37d0e0' : '#1b232c', color: octaves ? '#04141a' : '#8ea3b6',
          }}
        >
          OCTAVES {octaves ? 'ON' : 'OFF'}
        </button>
      </div>

      <div style={{
        position: 'absolute', left: 16, bottom: 16, maxWidth: 520,
        font: '500 12px ui-monospace, monospace', color: '#6f8296', lineHeight: 1.6,
      }}>
        LEFT = UV mapping: the same brick texture stretched to fit each box, so the
        courses change size and shape per block. RIGHT = triplanar: brick sized in
        metres, identical on all three. OCTAVES adds the fine detail + coarse macro
        passes to the right wall — orbit in close to the middle pillar to judge it.
        Impacts land on the right-hand wall and the deck. Drag to orbit.
      </div>
    </div>
  );
}
