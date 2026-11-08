'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Sky } from '@react-three/drei';
import * as THREE from 'three';

/**
 * STYLIZED art direction — bold, clean, low-poly, OUTDOOR.
 *
 * Open-air arena under a real procedural sky. Large, spacious fighting ground
 * (r≈20) so fighters traverse real distance and encounter cover as they move —
 * like a shooter map, not a cage.
 */

const FLOOR = '#3a4a6a';
const FLOOR_EDGE = '#2a3450';
const ACCENT = '#22d3ee';
const ACCENT_2 = '#f472b6';
const SEAT_RISER = '#2a3450';

const SEAT_TIERS = [
  { inner: 21, outer: 24, y: 1.0 },
  { inner: 24, outer: 27, y: 2.4 },
  { inner: 27, outer: 31, y: 3.8 },
];

export function StylizedArena() {
  const ringRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (ringRef.current) {
      const m = ringRef.current.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = 0.6 + Math.sin(state.clock.elapsedTime * 1.6) * 0.25;
    }
  });

  const seatColors = useMemo(() => ['#3e4a6a', '#354060', '#404c72'], []);

  return (
    <group>
      {/* Outdoor sky + atmospheric haze */}
      <Sky
        distance={450000}
        sunPosition={[80, 40, 30]}
        inclination={0.52}
        azimuth={0.25}
        mieCoefficient={0.005}
        mieDirectionalG={0.8}
        rayleigh={1.5}
        turbidity={8}
      />
      {/* Fog is set at scene level in BattleWorld */}

      {/* ---- Outdoor lighting ---- */}
      <hemisphereLight color={'#87ceeb'} groundColor={'#5a6844'} intensity={1.0} />
      <ambientLight color={'#c8daf0'} intensity={0.4} />
      <directionalLight
        color={'#fff4d6'}
        intensity={2.8}
        position={[12, 18, 8]}
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
      <directionalLight color={'#a0c0ff'} intensity={0.8} position={[-8, 10, -7]} />
      <pointLight color={ACCENT} intensity={2.5} distance={40} position={[-14, 5, -10]} />
      <pointLight color={ACCENT_2} intensity={2.2} distance={40} position={[14, 5, 10]} />

      {/* ---- Fighting floor ---- */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <circleGeometry args={[20, 72]} />
        <meshStandardMaterial color={FLOOR} roughness={0.55} metalness={0.05} flatShading />
      </mesh>

      {/* Central emblem rings */}
      {[4, 9, 14].map((r, i) => (
        <mesh key={i} ref={i === 1 ? ringRef : undefined} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.014, 0]}>
          <ringGeometry args={[r - 0.15, r, 72]} />
          <meshStandardMaterial color={ACCENT} emissive={ACCENT} emissiveIntensity={0.6} transparent opacity={0.85} />
        </mesh>
      ))}

      {/* Accent rim ring at the floor edge */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]}>
        <ringGeometry args={[19.8, 20.15, 72]} />
        <meshStandardMaterial color={ACCENT} emissive={ACCENT} emissiveIntensity={1.4} />
      </mesh>

      {/* Low border wall */}
      <mesh position={[0, 0.45, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[20, 20, 0.9, 72, 1, true]} />
        <meshStandardMaterial color={FLOOR_EDGE} roughness={0.6} metalness={0.1} side={THREE.DoubleSide} flatShading />
      </mesh>

      {/* ---- Tiered seating ---- */}
      {SEAT_TIERS.map((t, i) => (
        <group key={i}>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, t.y, 0]} receiveShadow>
            <ringGeometry args={[t.inner, t.outer, 72]} />
            <meshStandardMaterial color={seatColors[i]} roughness={0.7} metalness={0.05} side={THREE.DoubleSide} flatShading />
          </mesh>
          <mesh position={[0, t.y - 0.5, 0]}>
            <cylinderGeometry args={[t.inner, t.inner, 1, 72, 1, true]} />
            <meshStandardMaterial color={SEAT_RISER} roughness={0.7} metalness={0.05} side={THREE.DoubleSide} flatShading />
          </mesh>
        </group>
      ))}

      {/* ---- Pylons ringing the arena ---- */}
      {Array.from({ length: 12 }).map((_, i) => {
        const a = (i / 12) * Math.PI * 2 + Math.PI / 12;
        const x = Math.cos(a) * 21;
        const z = Math.sin(a) * 21;
        const col = i % 2 === 0 ? ACCENT : ACCENT_2;
        return (
          <group key={i} position={[x, 0, z]}>
            <mesh position={[0, 2.8, 0]} castShadow>
              <boxGeometry args={[0.8, 5.6, 0.8]} />
              <meshStandardMaterial color={'#3a4664'} roughness={0.6} metalness={0.1} flatShading />
            </mesh>
            <mesh position={[0, 5.8, 0]}>
              <boxGeometry args={[1.1, 0.55, 1.1]} />
              <meshStandardMaterial color={col} emissive={col} emissiveIntensity={1.2} />
            </mesh>
            <pointLight color={col} intensity={0.8} distance={12} position={[0, 5.8, 0]} />
          </group>
        );
      })}

      {/* Ground extending beyond the arena */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.1, 0]} receiveShadow>
        <circleGeometry args={[150, 64]} />
        <meshStandardMaterial color={'#3a5040'} roughness={0.95} metalness={0} />
      </mesh>
    </group>
  );
}
