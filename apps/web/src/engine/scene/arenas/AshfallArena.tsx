'use client';

import { useMemo, useRef, useLayoutEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { Sky } from '@react-three/drei';
import * as THREE from 'three';
import { mulberry32 } from './prng';
import { VILLAGE, WELL_POS, CART_POS, CART_YAW, type HouseSpec } from './ashfallLayout';

/**
 * ASHFALL, Zone 1's burned village. The campaign's first real PLACE: an open
 * dirt square ringed by torched houses, lone chimneys, dead trees and rising
 * smoke, under a low smoke-choked sun. The story opens here ("the fire started
 * here"), so the environment IS the narrative.
 *
 * Same flat-shaded low-poly language as StylizedArena so fighters, guns and
 * VFX read identically across stages.
 *
 * WHERE things stand comes from ashfallLayout.ts — the same data the sim turns
 * into static colliders — so this file only decides how things LOOK. The open
 * square (r<=12) stays free of structures for the classic duel stages; mission
 * encounters fight anywhere, with walls as real cover.
 */

// ── Palette ──────────────────────────────────────────────────────────────────
const ASH_PLAIN = '#4a463f';
const SQUARE_DIRT = '#5b544a';
const SCORCH = '#2e2a25';
const PATH = '#665e52';
const CHAR = '#211b16';
const CHAR_BEAM = '#2b231c';
const BRICK = '#6a4a3a';
const PLASTER = '#94826c';
const STONE = '#5f574d';
const EMBER = '#ff6a2a';
const SMOKE = '#57504a';
const TREE_DARK = '#241f1a';
const MOUNTAIN = '#463c33';
const DRIFT = '#6e655a';


// ── Burned house: shell walls, one collapsed side, charred roof beams, and a
// hearth of embers still glowing in the wreck. Structure (walls, chimney)
// comes from ashfallLayout — the sim collides with exactly these boxes. ──
function BurnedHouse({ spec }: { spec: HouseSpec }) {
  return (
    <group position={[spec.x, 0, spec.z]} rotation={[0, spec.yaw, 0]}>
      {/* floor slab, scorched */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 0]} receiveShadow>
        <planeGeometry args={[spec.w, spec.d]} />
        <meshStandardMaterial color={SCORCH} roughness={1} />
      </mesh>

      {/* structural walls (shared with the sim's colliders) */}
      {spec.walls.map((w, i) => (
        <group key={i}>
          <mesh position={[w.lx, w.h / 2, w.lz]} castShadow receiveShadow>
            <boxGeometry args={[w.hx * 2, w.h, w.hz * 2]} />
            <meshStandardMaterial color={w.mat === 'plaster' ? PLASTER : BRICK} roughness={w.mat === 'plaster' ? 0.95 : 1} flatShading />
          </mesh>
          {/* soot staining the top of the back wall */}
          {w.soot && (
            <mesh position={[w.lx, w.h - 0.22, w.lz]}>
              <boxGeometry args={[w.hx * 2 + 0.02, 0.44, w.hz * 2 + 0.02]} />
              <meshStandardMaterial color={CHAR} roughness={1} flatShading />
            </mesh>
          )}
        </group>
      ))}

      {/* charred roof beams: survivors lean from the back wall; one has fallen in */}
      {spec.beams.map((b, i) =>
        b.fallen ? (
          <mesh key={i} position={[b.x, 0.55, 0]} rotation={[1.15, b.yawJitter, 0.1]} castShadow>
            <boxGeometry args={[0.1, 0.14, spec.d * 0.85]} />
            <meshStandardMaterial color={CHAR_BEAM} roughness={1} flatShading />
          </mesh>
        ) : (
          <mesh key={i} position={[b.x, spec.hBack * 0.62, -spec.d * 0.08]} rotation={[b.tilt, 0, 0]} castShadow>
            <boxGeometry args={[0.1, 0.14, spec.d * 0.95]} />
            <meshStandardMaterial color={CHAR_BEAM} roughness={1} flatShading />
          </mesh>
        ),
      )}

      {/* stone chimney riding the back corner, the burned-village silhouette */}
      {spec.chimney && (
        <group position={[spec.chimney.lx, 0, spec.chimney.lz]}>
          <mesh position={[0, spec.chimney.h / 2, 0]} castShadow>
            <boxGeometry args={[0.8, spec.chimney.h, 0.8]} />
            <meshStandardMaterial color={STONE} roughness={1} flatShading />
          </mesh>
          <mesh position={[0, spec.chimney.h + 0.06, 0]} castShadow>
            <boxGeometry args={[0.95, 0.14, 0.95]} />
            <meshStandardMaterial color={CHAR} roughness={1} flatShading />
          </mesh>
        </group>
      )}

      {/* hearth of embers still alive in the wreckage */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[spec.ember.lx, 0.03, spec.ember.lz]}>
        <planeGeometry args={[1.3, 0.9]} />
        <meshStandardMaterial color={EMBER} emissive={EMBER} emissiveIntensity={1.3} transparent opacity={0.85} />
      </mesh>
      {spec.emberLight && (
        <pointLight color={EMBER} intensity={2.2} distance={11} decay={2} position={[spec.ember.lx, 0.6, spec.ember.lz]} />
      )}
    </group>
  );
}

// ── Dead tree: bare tapered trunk + a couple of snapped branches ──
function DeadTree({ x, z, scale, seed }: { x: number; z: number; scale: number; seed: number }) {
  const rand = useMemo(() => mulberry32(seed), [seed]);
  const yaw = useMemo(() => rand() * Math.PI * 2, [rand]);
  const lean = useMemo(() => (rand() - 0.5) * 0.24, [rand]);
  const h = 3.6 * scale;
  return (
    <group position={[x, 0, z]} rotation={[lean, yaw, 0]}>
      <mesh position={[0, h / 2, 0]} castShadow>
        <cylinderGeometry args={[0.07 * scale, 0.24 * scale, h, 6]} />
        <meshStandardMaterial color={TREE_DARK} roughness={1} flatShading />
      </mesh>
      <mesh position={[0.35 * scale, h * 0.66, 0]} rotation={[0, 0, -0.9]} castShadow>
        <cylinderGeometry args={[0.03 * scale, 0.08 * scale, 1.5 * scale, 5]} />
        <meshStandardMaterial color={TREE_DARK} roughness={1} flatShading />
      </mesh>
      <mesh position={[-0.3 * scale, h * 0.8, 0.1]} rotation={[0.4, 0, 0.95]} castShadow>
        <cylinderGeometry args={[0.02 * scale, 0.06 * scale, 1.1 * scale, 5]} />
        <meshStandardMaterial color={TREE_DARK} roughness={1} flatShading />
      </mesh>
    </group>
  );
}

// ── Distant burned forest: one instanced draw of dark spires, fog does the rest ──
function DistantForest() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const COUNT = 64;
  const matrices = useMemo(() => {
    const rand = mulberry32(41);
    const dummy = new THREE.Object3D();
    const out: THREE.Matrix4[] = [];
    for (let i = 0; i < COUNT; i++) {
      const a = rand() * Math.PI * 2;
      const r = 42 + rand() * 34;
      const s = 0.7 + rand() * 1.5;
      const sy = s * (0.8 + rand() * 0.7);
      dummy.position.set(Math.cos(a) * r, 4 * sy, Math.sin(a) * r);
      dummy.scale.set(s, sy, s);
      dummy.rotation.y = rand() * Math.PI;
      dummy.updateMatrix();
      out.push(dummy.matrix.clone());
    }
    return out;
  }, []);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    matrices.forEach((mat, i) => m.setMatrixAt(i, mat));
    m.instanceMatrix.needsUpdate = true;
  }, [matrices]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, COUNT]} frustumCulled={false}>
      <coneGeometry args={[1.0, 8, 5]} />
      <meshStandardMaterial color={TREE_DARK} roughness={1} flatShading />
    </instancedMesh>
  );
}

// ── Rubble field: one instanced draw of tumbled stones hugging the ruins ──
function RubbleField() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const COUNT = 80;
  const matrices = useMemo(() => {
    const rand = mulberry32(97);
    const dummy = new THREE.Object3D();
    const out: THREE.Matrix4[] = [];
    for (let i = 0; i < COUNT; i++) {
      const a = rand() * Math.PI * 2;
      const r = 12.8 + rand() * 11;
      const s = 0.35 + rand() * 0.85;
      dummy.position.set(Math.cos(a) * r, s * 0.22, Math.sin(a) * r);
      dummy.scale.setScalar(s);
      dummy.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
      dummy.updateMatrix();
      out.push(dummy.matrix.clone());
    }
    return out;
  }, []);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    matrices.forEach((mat, i) => m.setMatrixAt(i, mat));
    m.instanceMatrix.needsUpdate = true;
  }, [matrices]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, COUNT]} castShadow frustumCulled={false}>
      <dodecahedronGeometry args={[0.32, 0]} />
      <meshStandardMaterial color={STONE} roughness={1} flatShading />
    </instancedMesh>
  );
}

// ── Smoke column: a loop of soft puffs rising, swelling and thinning out ──
function SmokeColumn({ x, z, seed }: { x: number; z: number; seed: number }) {
  const refs = useRef<(THREE.Mesh | null)[]>([]);
  const puffs = useMemo(() => {
    const rand = mulberry32(seed);
    return Array.from({ length: 5 }, (_, i) => ({
      off: i / 5,
      sway: 0.5 + rand() * 0.9,
      phase: rand() * Math.PI * 2,
    }));
  }, [seed]);

  useFrame((state) => {
    const rise = state.clock.elapsedTime * 0.055;
    for (let i = 0; i < puffs.length; i++) {
      const m = refs.current[i];
      if (!m) continue;
      const p = puffs[i];
      const cycle = (rise + p.off) % 1;
      m.position.set(
        Math.sin(state.clock.elapsedTime * 0.3 + p.phase) * p.sway * cycle,
        0.8 + cycle * 13,
        Math.cos(state.clock.elapsedTime * 0.22 + p.phase) * p.sway * cycle,
      );
      m.scale.setScalar(0.8 + cycle * 2.8);
      (m.material as THREE.MeshStandardMaterial).opacity = 0.05 + 0.2 * (1 - cycle);
    }
  });

  return (
    <group position={[x, 0, z]}>
      {puffs.map((_, i) => (
        <mesh key={i} ref={(el) => { refs.current[i] = el; }}>
          <sphereGeometry args={[1, 8, 6]} />
          <meshStandardMaterial color={SMOKE} transparent opacity={0.2} depthWrite={false} flatShading />
        </mesh>
      ))}
    </group>
  );
}

// ── Ember drift: sparse sparks lifting off the village and dying in the wind ──
function EmberDrift() {
  const COUNT = 80;
  const pointsRef = useRef<THREE.Points>(null);
  const state = useMemo(() => {
    const rand = mulberry32(23);
    const parts = Array.from({ length: COUNT }, () => ({
      x: (rand() - 0.5) * 46,
      y: rand() * 9,
      z: (rand() - 0.5) * 38,
      vy: 0.35 + rand() * 0.9,
      life: 2 + rand() * 4,
      maxLife: 0,
      phase: rand() * Math.PI * 2,
    }));
    parts.forEach((p) => (p.maxLife = p.life));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
    const mat = new THREE.PointsMaterial({
      size: 0.055,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    return { parts, geo, mat, color: new THREE.Color(EMBER) };
  }, []);

  useFrame((frame, dt) => {
    const { parts, geo, color } = state;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const col = geo.attributes.color as THREE.BufferAttribute;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.x = (Math.random() - 0.5) * 46;
        p.y = 0.2;
        p.z = (Math.random() - 0.5) * 38;
        p.life = p.maxLife;
      }
      p.y += p.vy * dt;
      p.x += Math.sin(frame.clock.elapsedTime * 0.8 + p.phase) * 0.5 * dt;
      const a = Math.min(1, p.life / p.maxLife, (p.maxLife - p.life) / 0.4);
      pos.setXYZ(i, p.x, p.y, p.z);
      col.setXYZ(i, color.r * a, color.g * a, color.b * a);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  });

  return <points ref={pointsRef} geometry={state.geo} material={state.mat} />;
}

// ── The arena ────────────────────────────────────────────────────────────────
// Houses face the square, with two street mouths on the duel axis (east/west)
// so the camera looks down a road, not into a wall. Layout: ashfallLayout.ts.
export function AshfallArena() {
  const houses = VILLAGE.houses;
  const nearTrees = VILLAGE.trees;

  return (
    <group>
      {/* Low sun strangled by smoke: high turbidity does the heavy lifting */}
      <Sky
        distance={450000}
        sunPosition={[20, 12, -70]}
        inclination={0.51}
        azimuth={0.18}
        mieCoefficient={0.008}
        mieDirectionalG={0.85}
        rayleigh={2.0}
        turbidity={12}
      />
      {/* Fog is set at scene level in BattleWorld */}

      {/* ---- Ash-choked daylight; sun sits OFF the duel axis so fighters and
           ruins get cross-light instead of reading as backlit silhouettes ---- */}
      <hemisphereLight color={'#b5a08e'} groundColor={'#39352f'} intensity={1.0} />
      <ambientLight color={'#b0a294'} intensity={0.42} />
      <directionalLight
        color={'#ffd3ad'}
        intensity={2.2}
        position={[8, 15, -30]}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={0.5}
        shadow-camera-far={90}
        shadow-camera-left={-30}
        shadow-camera-right={30}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
        shadow-bias={-0.001}
      />
      <directionalLight color={'#8a93b0'} intensity={0.55} position={[-14, 10, 12]} />

      {/* ---- Ground ---- */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        <circleGeometry args={[160, 48]} />
        <meshStandardMaterial color={ASH_PLAIN} roughness={1} metalness={0} />
      </mesh>
      {/* the village square the duel is fought on */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]} receiveShadow>
        <circleGeometry args={[13, 56]} />
        <meshStandardMaterial color={SQUARE_DIRT} roughness={1} metalness={0} flatShading />
      </mesh>
      {/* dirt roads out through both street mouths, along the duel axis */}
      {[0, Math.PI].map((a, i) => (
        <mesh key={i} rotation={[-Math.PI / 2, 0, -a]} position={[Math.cos(a) * 21, 0.004, Math.sin(a) * 21]} receiveShadow>
          <planeGeometry args={[18, 4.2]} />
          <meshStandardMaterial color={PATH} roughness={1} />
        </mesh>
      ))}
      {/* scorch marks where the fire pooled */}
      {[[4.5, 3.5, 2.1], [-6, -4, 1.6], [1.5, -7, 2.5], [-3, 6.5, 1.3]].map(([x, z, r], i) => (
        <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.006, z]}>
          <circleGeometry args={[r, 20]} />
          <meshStandardMaterial color={SCORCH} roughness={1} transparent opacity={0.85} />
        </mesh>
      ))}
      {/* ---- The village ---- */}
      {houses.map((h, i) => (
        <BurnedHouse key={i} spec={h} />
      ))}
      {nearTrees.map((t, i) => (
        <DeadTree key={i} {...t} />
      ))}

      {/* well at the north street corner */}
      <group position={[WELL_POS[0], 0, WELL_POS[1]]}>
        <mesh position={[0, 0.4, 0]} castShadow>
          <cylinderGeometry args={[0.9, 1.0, 0.8, 10]} />
          <meshStandardMaterial color={STONE} roughness={1} flatShading />
        </mesh>
        {[-0.7, 0.7].map((px, i) => (
          <mesh key={i} position={[px, 1.1, 0]} castShadow>
            <boxGeometry args={[0.12, 1.5, 0.12]} />
            <meshStandardMaterial color={CHAR_BEAM} roughness={1} flatShading />
          </mesh>
        ))}
        <mesh position={[0, 1.85, 0]} rotation={[0, 0, 0.08]} castShadow>
          <boxGeometry args={[1.9, 0.1, 0.5]} />
          <meshStandardMaterial color={CHAR} roughness={1} flatShading />
        </mesh>
      </group>

      {/* tipped cart abandoned on the west road */}
      <group position={[CART_POS[0], 0, CART_POS[1]]} rotation={[0, CART_YAW, 0]}>
        <mesh position={[0, 0.55, 0]} rotation={[0, 0, 0.5]} castShadow>
          <boxGeometry args={[2.2, 0.9, 1.3]} />
          <meshStandardMaterial color={CHAR_BEAM} roughness={1} flatShading />
        </mesh>
        <mesh position={[1.0, 0.6, 0.75]} rotation={[Math.PI / 2, 0, 0.3]} castShadow>
          <cylinderGeometry args={[0.55, 0.55, 0.12, 10]} />
          <meshStandardMaterial color={CHAR} roughness={1} flatShading />
        </mesh>
        <mesh position={[-0.9, 0.15, 0.8]} rotation={[Math.PI / 2, 0, 1.2]} castShadow>
          <cylinderGeometry args={[0.55, 0.55, 0.12, 10]} />
          <meshStandardMaterial color={CHAR} roughness={1} flatShading />
        </mesh>
      </group>

      {/* broken fence runs between houses */}
      {[{ a: 1.15, r: 14.2 }, { a: 2.6, r: 14.8 }, { a: 4.4, r: 14.0 }].map(({ a, r }, fi) => {
        const cx = Math.cos(a) * r;
        const cz = Math.sin(a) * r;
        const yaw = Math.atan2(-cx, -cz) + Math.PI / 2;
        return (
          <group key={fi} position={[cx, 0, cz]} rotation={[0, yaw, 0]}>
            {[-1.6, -0.55, 0.55, 1.6].map((px, i) => (
              <mesh key={i} position={[px, 0.35, 0]} rotation={[0, 0, (i % 2 ? -1 : 1) * 0.08]} castShadow>
                <boxGeometry args={[0.1, 0.7, 0.1]} />
                <meshStandardMaterial color={CHAR_BEAM} roughness={1} flatShading />
              </mesh>
            ))}
            <mesh position={[0, 0.52, 0]} rotation={[0, 0, 0.05]} castShadow>
              <boxGeometry args={[3.6, 0.09, 0.07]} />
              <meshStandardMaterial color={CHAR_BEAM} roughness={1} flatShading />
            </mesh>
          </group>
        );
      })}

      {/* ash drifts piled against whatever is left standing */}
      {[[13.2, -6.5], [-13.8, 6.2], [7.5, 13.8], [-8.2, -13.5], [16.5, 9.5], [-17, -8]].map(([x, z], i) => (
        <mesh key={i} position={[x, 0.1, z]} scale={[1.6 + (i % 3) * 0.5, 0.28, 1.1 + (i % 2) * 0.5]} receiveShadow>
          <sphereGeometry args={[1, 8, 6]} />
          <meshStandardMaterial color={DRIFT} roughness={1} flatShading />
        </mesh>
      ))}

      {/* ---- Distance ---- */}
      <DistantForest />
      <RubbleField />
      {[
        [115, 0, -70, 30],
        [-95, 0, -110, 42],
        [140, 0, 55, 36],
        [-125, 0, 80, 26],
        [40, 0, 140, 33],
      ].map(([x, , z, h], i) => (
        <mesh key={i} position={[x, h / 2 - 2, z]}>
          <coneGeometry args={[h * 1.6, h, 6]} />
          <meshStandardMaterial color={MOUNTAIN} roughness={1} flatShading />
        </mesh>
      ))}

      {/* ---- Atmosphere ---- */}
      <SmokeColumn x={17} z={-9} seed={11} />
      <SmokeColumn x={-19} z={7} seed={12} />
      <SmokeColumn x={6} z={19} seed={13} />
      <EmberDrift />
    </group>
  );
}
