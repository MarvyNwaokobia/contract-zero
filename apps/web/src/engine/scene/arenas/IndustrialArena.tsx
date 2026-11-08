'use client';

import { useMemo } from 'react';
import * as THREE from 'three';

/**
 * INDUSTRIAL HANGAR — abandoned factory / power-plant arena.
 *
 * Massive enclosed hangar (~100 m across, ~30 m ceiling). Weathered concrete,
 * rusted steel beams, giant windows letting warm dusty sunlight pour in.
 * No crowd, no neon — silent tension before combat.
 */

const CONCRETE = '#6b6055';
const CONCRETE_DARK = '#4a4238';
const CONCRETE_FLOOR = '#5a5248';
const RUST = '#8b5e3c';
const RUST_DARK = '#6a4028';
const STEEL = '#4a4a50';
const STEEL_DARK = '#35353b';
const DUST_BEIGE = '#a09080';
const DIRT = '#5c4e3e';

// Seeded PRNG for deterministic debris placement.
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function IndustrialArena() {
  const debris = useMemo(() => {
    const rng = mulberry32(42);
    const pieces: { pos: [number, number, number]; rot: [number, number, number]; scale: [number, number, number]; color: string }[] = [];

    // Scattered rocks / concrete fragments across the floor
    for (let i = 0; i < 60; i++) {
      const x = (rng() - 0.5) * 44;
      const z = (rng() - 0.5) * 34;
      const s = 0.1 + rng() * 0.4;
      pieces.push({
        pos: [x, s * 0.4, z],
        rot: [rng() * Math.PI, rng() * Math.PI, rng() * Math.PI],
        scale: [s * (0.6 + rng() * 0.8), s * (0.5 + rng() * 0.6), s * (0.6 + rng() * 0.8)],
        color: rng() > 0.4 ? CONCRETE_DARK : DIRT,
      });
    }

    // Larger rubble chunks near walls
    for (let i = 0; i < 20; i++) {
      const side = rng() > 0.5 ? 1 : -1;
      const x = side * (16 + rng() * 8);
      const z = (rng() - 0.5) * 30;
      const s = 0.3 + rng() * 0.7;
      pieces.push({
        pos: [x, s * 0.35, z],
        rot: [rng() * Math.PI, rng() * Math.PI, rng() * Math.PI],
        scale: [s, s * 0.6, s * (0.8 + rng() * 0.4)],
        color: rng() > 0.5 ? CONCRETE : RUST_DARK,
      });
    }

    return pieces;
  }, []);

  // Steel beams across the ceiling
  const ceilingBeams = useMemo(() => {
    const beams: { pos: [number, number, number]; rot: [number, number, number]; len: number; crossBeam: boolean }[] = [];
    for (let i = 0; i < 9; i++) {
      const z = -20 + i * 5;
      beams.push({
        pos: [0, 26, z],
        rot: [0, 0, Math.PI / 2],
        len: 48,
        crossBeam: true,
      });
    }
    // Longitudinal beams
    for (let i = 0; i < 5; i++) {
      const x = -20 + i * 10;
      beams.push({
        pos: [x, 27.5, 0],
        rot: [0, Math.PI / 2, Math.PI / 2],
        len: 42,
        crossBeam: false,
      });
    }
    return beams;
  }, []);

  // Hanging steel plates / damaged banners on walls
  const hangingPlates = useMemo(() => {
    const plates: { pos: [number, number, number]; rot: [number, number, number]; size: [number, number]; color: string }[] = [];
    const rng = mulberry32(77);
    // Left wall
    for (let i = 0; i < 4; i++) {
      const z = -12 + i * 7 + (rng() - 0.5) * 2;
      plates.push({
        pos: [-24.8, 10 + rng() * 6, z],
        rot: [0, Math.PI / 2, (rng() - 0.5) * 0.15],
        size: [2.5 + rng() * 1.5, 5 + rng() * 4],
        color: rng() > 0.5 ? RUST : STEEL_DARK,
      });
    }
    // Right wall
    for (let i = 0; i < 4; i++) {
      const z = -10 + i * 7 + (rng() - 0.5) * 2;
      plates.push({
        pos: [24.8, 8 + rng() * 8, z],
        rot: [0, -Math.PI / 2, (rng() - 0.5) * 0.12],
        size: [2 + rng() * 2, 4 + rng() * 5],
        color: rng() > 0.5 ? RUST_DARK : STEEL,
      });
    }
    return plates;
  }, []);

  // Pipes and cables on floor
  const pipes = useMemo(() => {
    const rng = mulberry32(99);
    const items: { pos: [number, number, number]; rot: number; len: number; radius: number; color: string }[] = [];
    for (let i = 0; i < 12; i++) {
      const x = (rng() - 0.5) * 40;
      const z = (rng() - 0.5) * 30;
      items.push({
        pos: [x, 0.08 + rng() * 0.05, z],
        rot: rng() * Math.PI,
        len: 1.5 + rng() * 4,
        radius: 0.04 + rng() * 0.08,
        color: rng() > 0.6 ? RUST : STEEL_DARK,
      });
    }
    return items;
  }, []);

  // Window positions on walls (high up, letting light in)
  const windows = useMemo(() => {
    const wins: { pos: [number, number, number]; rot: [number, number, number]; size: [number, number] }[] = [];
    // Left wall windows
    for (let i = 0; i < 5; i++) {
      wins.push({
        pos: [-25.05, 20, -14 + i * 7],
        rot: [0, Math.PI / 2, 0],
        size: [4, 6],
      });
    }
    // Right wall windows
    for (let i = 0; i < 5; i++) {
      wins.push({
        pos: [25.05, 20, -14 + i * 7],
        rot: [0, -Math.PI / 2, 0],
        size: [4, 6],
      });
    }
    return wins;
  }, []);

  return (
    <group>
      {/* No sky — enclosed hangar. Fog + background set at scene level. */}

      {/* ---- Lighting: warm natural sunlight through high windows ---- */}
      <hemisphereLight color={'#c8b8a0'} groundColor={'#3a3028'} intensity={0.6} />
      <ambientLight color={'#b0a090'} intensity={0.35} />

      {/* Main sun through windows — warm, angled, casting long shadows */}
      <directionalLight
        color={'#ffe8c0'}
        intensity={3.0}
        position={[20, 28, -8]}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={0.5}
        shadow-camera-far={80}
        shadow-camera-left={-30}
        shadow-camera-right={30}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
        shadow-bias={-0.001}
      />
      {/* Secondary fill from opposite windows */}
      <directionalLight color={'#e0d0b8'} intensity={1.0} position={[-18, 22, 6]} />

      {/* Volumetric light shafts — point lights simulating sunbeams hitting the floor */}
      <pointLight color={'#ffe0b0'} intensity={3.0} distance={30} position={[15, 12, -5]} />
      <pointLight color={'#ffd8a0'} intensity={2.5} distance={25} position={[-12, 10, 8]} />
      <pointLight color={'#ffe8c8'} intensity={1.8} distance={20} position={[0, 8, -12]} />

      {/* ---- Floor: cracked concrete with dirt ---- */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[52, 42]} />
        <meshStandardMaterial color={CONCRETE_FLOOR} roughness={0.95} metalness={0.05} />
      </mesh>

      {/* Dirt/dust patches on the floor */}
      {[
        [0, 0, 18, 14],
        [-8, 5, 12, 10],
        [10, -6, 14, 12],
        [-15, -8, 8, 8],
        [5, 12, 10, 8],
      ].map(([x, z, w, h], i) => (
        <mesh key={`dirt${i}`} rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.005, z]} receiveShadow>
          <planeGeometry args={[w, h]} />
          <meshStandardMaterial color={DIRT} roughness={1} metalness={0} transparent opacity={0.4} />
        </mesh>
      ))}

      {/* Floor crack lines */}
      {Array.from({ length: 15 }).map((_, i) => {
        const rng = mulberry32(200 + i);
        const x = (rng() - 0.5) * 40;
        const z = (rng() - 0.5) * 32;
        const rot = rng() * Math.PI;
        const len = 2 + rng() * 8;
        return (
          <mesh key={`crack${i}`} rotation={[-Math.PI / 2, rot, 0]} position={[x, 0.008, z]}>
            <planeGeometry args={[len, 0.03 + rng() * 0.05]} />
            <meshStandardMaterial color={'#3a3430'} roughness={1} metalness={0} transparent opacity={0.7} />
          </mesh>
        );
      })}

      {/* ---- Walls: massive concrete enclosure ---- */}
      {/* Left wall */}
      <mesh position={[-25, 14, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.5, 30, 42]} />
        <meshStandardMaterial color={CONCRETE} roughness={0.92} metalness={0.05} />
      </mesh>
      {/* Right wall */}
      <mesh position={[25, 14, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.5, 30, 42]} />
        <meshStandardMaterial color={CONCRETE} roughness={0.92} metalness={0.05} />
      </mesh>
      {/* Back wall */}
      <mesh position={[0, 14, -21]} castShadow receiveShadow>
        <boxGeometry args={[52, 30, 1.5]} />
        <meshStandardMaterial color={CONCRETE_DARK} roughness={0.9} metalness={0.05} />
      </mesh>

      {/* ---- Front wall with giant semi-circular arch ---- */}
      {/* Left section of front wall */}
      <mesh position={[-17, 14, 21]} castShadow receiveShadow>
        <boxGeometry args={[18, 30, 1.5]} />
        <meshStandardMaterial color={CONCRETE_DARK} roughness={0.9} metalness={0.05} />
      </mesh>
      {/* Right section of front wall */}
      <mesh position={[17, 14, 21]} castShadow receiveShadow>
        <boxGeometry args={[18, 30, 1.5]} />
        <meshStandardMaterial color={CONCRETE_DARK} roughness={0.9} metalness={0.05} />
      </mesh>
      {/* Arch header above the opening */}
      <mesh position={[0, 26, 21]} castShadow receiveShadow>
        <boxGeometry args={[18, 6, 1.5]} />
        <meshStandardMaterial color={CONCRETE_DARK} roughness={0.9} metalness={0.05} />
      </mesh>

      {/* Semi-circular arch — segmented ring of concrete blocks */}
      {Array.from({ length: 16 }).map((_, i) => {
        const angle = (i / 15) * Math.PI;
        const archRadius = 9;
        const x = Math.cos(angle) * archRadius;
        const y = Math.sin(angle) * archRadius + 14;
        return (
          <mesh key={`arch${i}`} position={[x, y, 21]} rotation={[0, 0, angle - Math.PI / 2]} castShadow>
            <boxGeometry args={[1.2, 3.8, 2.0]} />
            <meshStandardMaterial color={CONCRETE} roughness={0.88} metalness={0.08} />
          </mesh>
        );
      })}

      {/* ---- Ceiling ---- */}
      <mesh position={[0, 29, 0]} receiveShadow>
        <boxGeometry args={[52, 0.8, 42]} />
        <meshStandardMaterial color={CONCRETE_DARK} roughness={0.95} metalness={0.05} side={THREE.DoubleSide} />
      </mesh>

      {/* ---- Steel ceiling beams ---- */}
      {ceilingBeams.map((beam, i) => (
        <group key={`beam${i}`} position={beam.pos} rotation={beam.rot}>
          {/* I-beam: web + top flange + bottom flange */}
          <mesh castShadow>
            <boxGeometry args={[0.12, beam.len, 0.5]} />
            <meshStandardMaterial color={STEEL} roughness={0.65} metalness={0.5} />
          </mesh>
          <mesh position={[0, 0, 0.28]} castShadow>
            <boxGeometry args={[0.3, beam.len, 0.06]} />
            <meshStandardMaterial color={beam.crossBeam ? RUST : STEEL_DARK} roughness={0.7} metalness={0.45} />
          </mesh>
          <mesh position={[0, 0, -0.28]} castShadow>
            <boxGeometry args={[0.3, beam.len, 0.06]} />
            <meshStandardMaterial color={beam.crossBeam ? RUST : STEEL_DARK} roughness={0.7} metalness={0.45} />
          </mesh>
        </group>
      ))}

      {/* ---- Windows (light openings in walls) ---- */}
      {windows.map((win, i) => (
        <group key={`win${i}`} position={win.pos} rotation={win.rot}>
          {/* Window frame */}
          <mesh>
            <planeGeometry args={win.size} />
            <meshStandardMaterial
              color={'#d8c8a8'}
              emissive={'#ffe8c0'}
              emissiveIntensity={0.8}
              transparent
              opacity={0.6}
              side={THREE.DoubleSide}
            />
          </mesh>
          {/* Mullions (vertical bars) */}
          <mesh position={[0, 0, 0.05]}>
            <boxGeometry args={[0.08, win.size[1], 0.1]} />
            <meshStandardMaterial color={STEEL_DARK} roughness={0.7} metalness={0.5} />
          </mesh>
          {/* Horizontal bar */}
          <mesh position={[0, 0, 0.05]}>
            <boxGeometry args={[win.size[0], 0.08, 0.1]} />
            <meshStandardMaterial color={STEEL_DARK} roughness={0.7} metalness={0.5} />
          </mesh>
        </group>
      ))}

      {/* ---- Hanging steel plates / damaged metal banners ---- */}
      {hangingPlates.map((plate, i) => (
        <mesh key={`plate${i}`} position={plate.pos} rotation={plate.rot}>
          <planeGeometry args={plate.size} />
          <meshStandardMaterial
            color={plate.color}
            roughness={0.8}
            metalness={0.45}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}

      {/* ---- Structural concrete pillars ---- */}
      {[-18, -6, 6, 18].map((x) =>
        [-15, 15].map((z, zi) => (
          <group key={`pillar${x}_${zi}`}>
            <mesh position={[x, 14, z]} castShadow receiveShadow>
              <boxGeometry args={[1.8, 28, 1.8]} />
              <meshStandardMaterial color={CONCRETE} roughness={0.9} metalness={0.08} />
            </mesh>
            {/* Pillar base */}
            <mesh position={[x, 0.25, z]} castShadow>
              <boxGeometry args={[2.4, 0.5, 2.4]} />
              <meshStandardMaterial color={CONCRETE_DARK} roughness={0.95} metalness={0.05} />
            </mesh>
          </group>
        ))
      )}

      {/* ---- Floor debris (rocks, rubble, fragments) ---- */}
      {debris.map((d, i) => (
        <mesh key={`deb${i}`} position={d.pos} rotation={d.rot} scale={d.scale} castShadow>
          <dodecahedronGeometry args={[1, 0]} />
          <meshStandardMaterial color={d.color} roughness={0.95} metalness={0.05} />
        </mesh>
      ))}

      {/* ---- Floor pipes and cables ---- */}
      {pipes.map((p, i) => (
        <mesh key={`pipe${i}`} position={p.pos} rotation={[-Math.PI / 2, p.rot, 0]}>
          <cylinderGeometry args={[p.radius, p.radius, p.len, 6]} />
          <meshStandardMaterial color={p.color} roughness={0.75} metalness={0.4} />
        </mesh>
      ))}

      {/* ---- Discarded machinery pieces ---- */}
      {[
        { pos: [-16, 0.6, -8] as [number, number, number], s: 1.2 },
        { pos: [18, 0.5, 5] as [number, number, number], s: 0.9 },
        { pos: [-10, 0.7, 14] as [number, number, number], s: 1.4 },
        { pos: [12, 0.4, -13] as [number, number, number], s: 0.8 },
      ].map((m, i) => (
        <group key={`mach${i}`} position={m.pos}>
          {/* Cylindrical machinery base */}
          <mesh castShadow>
            <cylinderGeometry args={[m.s * 0.7, m.s * 0.8, m.s, 12]} />
            <meshStandardMaterial color={STEEL_DARK} roughness={0.7} metalness={0.5} />
          </mesh>
          {/* Top disc */}
          <mesh position={[0, m.s * 0.55, 0]} castShadow>
            <cylinderGeometry args={[m.s * 0.9, m.s * 0.7, m.s * 0.15, 12]} />
            <meshStandardMaterial color={RUST} roughness={0.8} metalness={0.4} />
          </mesh>
        </group>
      ))}

      {/* ---- Exposed foundation strips ---- */}
      {[-8, 0, 8].map((z, i) => (
        <mesh key={`found${i}`} rotation={[-Math.PI / 2, 0, 0]} position={[(i - 1) * 12, 0.003, z]}>
          <planeGeometry args={[8, 0.5]} />
          <meshStandardMaterial color={'#4a4035'} roughness={1} metalness={0} transparent opacity={0.5} />
        </mesh>
      ))}

      {/* ---- Wall damage / erosion patches ---- */}
      {[
        [-24.2, 5, -8],
        [-24.2, 8, 10],
        [24.2, 3, -5],
        [24.2, 10, 12],
        [0, 6, -20.2],
        [8, 4, -20.2],
      ].map(([x, y, z], i) => {
        const onSide = Math.abs(x) > 20;
        return (
          <mesh
            key={`dmg${i}`}
            position={[x, y, z]}
            rotation={onSide ? [0, Math.PI / 2, 0] : [0, 0, 0]}
          >
            <planeGeometry args={[3 + (i % 3), 2 + (i % 2) * 1.5]} />
            <meshStandardMaterial color={DIRT} roughness={1} metalness={0} transparent opacity={0.5} side={THREE.DoubleSide} />
          </mesh>
        );
      })}

      {/* Dark outside visible through the arch opening — the void beyond */}
      <mesh position={[0, 10, 22]} receiveShadow>
        <planeGeometry args={[16, 22]} />
        <meshStandardMaterial color={'#2a2520'} roughness={1} metalness={0} />
      </mesh>

      {/* Faint dust haze layer across the floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 1.5, 0]}>
        <planeGeometry args={[52, 42]} />
        <meshStandardMaterial color={DUST_BEIGE} transparent opacity={0.04} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>

      {/* Ground extending beyond the hangar — dark earth visible through the arch */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.1, 0]} receiveShadow>
        <circleGeometry args={[80, 48]} />
        <meshStandardMaterial color={'#3a3028'} roughness={1} metalness={0} />
      </mesh>
    </group>
  );
}
