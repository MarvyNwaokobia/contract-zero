'use client';

import { useMemo } from 'react';
import { COVER, type CoverBox } from '../../sim/Cover';
import type { ArenaVariant } from '../GameScene';
import { mulberry32 } from './prng';

/**
 * Visual cover, driven by the SAME COVER data the sim uses for collision +
 * line-of-sight, so what you see is exactly what blocks you. Themed per
 * arena variant so obstacles feel native to their environment:
 *
 *  - stylized: clean emissive-trimmed blocks (the neon colosseum)
 *  - ashfall:  village debris; each box is dressed by its shape as a chimney,
 *              sandbag row, broken brick wall, scorched wall, crates or barrels.
 *              Dressing always fills the box footprint, and pieces under the
 *              sim's 1.05m shot height never block shots anyway, so jagged
 *              tops stay honest to gameplay.
 */

interface CoverTheme {
  body: string;
  bodyLow: string;
  trim: string;
  cap: string;
  bodyRoughness: number;
  bodyMetalness: number;
  trimIntensity: number;
}

const STYLIZED_THEME: CoverTheme = {
  body: '#1c2230', bodyLow: '#1a2030', trim: '#22d3ee', cap: '#11151f',
  bodyRoughness: 0.45, bodyMetalness: 0.6, trimIntensity: 1.6,
};

// Ashfall debris palette, matching AshfallArena
const A_CHAR = '#241d17';
const A_WOOD = '#3d2f24';
const A_BRICK = '#6a4a3a';
const A_BRICK_DARK = '#513328';
const A_PLASTER = '#877560';
const A_STONE = '#5f574d';
const A_SANDBAG = '#655c4b';
const A_SANDBAG_ALT = '#57503f';
const A_RUST = '#6e4a33';
const A_EMBER = '#ff6a2a';

function StylizedCoverPiece({ c }: { c: CoverBox }) {
  const theme = STYLIZED_THEME;
  const w = c.hx * 2;
  const d = c.hz * 2;
  const isLow = c.height < 1.05;
  const isTall = c.height > 1.5;
  const capScale = isTall ? 0.75 : 0.82;
  return (
    <group position={[c.x, 0, c.z]}>
      <mesh position={[0, c.height / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, c.height, d]} />
        <meshStandardMaterial
          color={isLow ? theme.bodyLow : theme.body}
          roughness={isLow ? theme.bodyRoughness + 0.1 : theme.bodyRoughness}
          metalness={isLow ? theme.bodyMetalness * 0.7 : theme.bodyMetalness}
        />
      </mesh>
      <mesh position={[0, c.height - 0.08, 0]}>
        <boxGeometry args={[w + 0.06, 0.12, d + 0.06]} />
        <meshStandardMaterial color={theme.trim} emissive={theme.trim} emissiveIntensity={theme.trimIntensity} toneMapped={false} />
      </mesh>
      <mesh position={[0, c.height + 0.04, 0]} castShadow>
        <boxGeometry args={[w * capScale, 0.16, d * capScale]} />
        <meshStandardMaterial color={theme.cap} roughness={0.5} metalness={0.7} />
      </mesh>
    </group>
  );
}

// ── Ashfall debris dressings ─────────────────────────────────────────────────

function Chimney({ c }: { c: CoverBox }) {
  const w = c.hx * 2;
  const d = c.hz * 2;
  const h = c.height;
  return (
    <group position={[c.x, 0, c.z]}>
      <mesh position={[0, h * 0.25, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, h * 0.5, d]} />
        <meshStandardMaterial color={A_STONE} roughness={1} flatShading />
      </mesh>
      <mesh position={[0, h * 0.68, 0]} castShadow>
        <boxGeometry args={[w * 0.92, h * 0.36, d * 0.92]} />
        <meshStandardMaterial color={A_STONE} roughness={1} flatShading />
      </mesh>
      <mesh position={[0, h * 0.93, 0]} castShadow>
        <boxGeometry args={[w * 0.84, h * 0.14, d * 0.84]} />
        <meshStandardMaterial color={A_CHAR} roughness={1} flatShading />
      </mesh>
      {/* the hearth still glows at the base */}
      <mesh position={[0, 0.12, 0]}>
        <boxGeometry args={[w * 0.55, 0.16, d * 0.55]} />
        <meshStandardMaterial color={A_EMBER} emissive={A_EMBER} emissiveIntensity={1.1} />
      </mesh>
    </group>
  );
}

function Sandbags({ c }: { c: CoverBox }) {
  const alongX = c.hx >= c.hz;
  const L = (alongX ? c.hx : c.hz) * 2;
  const C = (alongX ? c.hz : c.hx) * 2;
  const h = c.height;
  const n = Math.max(2, Math.round(L / 0.7));
  const bagL = L / n;
  const layer = (count: number, y: number, offset: number, key: string) =>
    Array.from({ length: count }, (_, i) => {
      const along = -L / 2 + bagL / 2 + i * bagL + offset;
      return (
        <mesh
          key={`${key}${i}`}
          position={alongX ? [along, y, 0] : [0, y, along]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={alongX ? [bagL * 0.94, h * 0.48, C] : [C, h * 0.48, bagL * 0.94]} />
          <meshStandardMaterial color={i % 2 ? A_SANDBAG_ALT : A_SANDBAG} roughness={1} flatShading />
        </mesh>
      );
    });
  return (
    <group position={[c.x, 0, c.z]}>
      {layer(n, h * 0.25, 0, 'b')}
      {layer(n - 1, h * 0.73, bagL / 2, 't')}
    </group>
  );
}

function BrickWall({ c, seed }: { c: CoverBox; seed: number }) {
  const alongX = c.hx >= c.hz;
  const L = (alongX ? c.hx : c.hz) * 2;
  const C = (alongX ? c.hz : c.hx) * 2;
  const h = c.height;
  const segs = useMemo(() => {
    const rand = mulberry32(seed);
    return Array.from({ length: 3 }, () => 0.68 + rand() * 0.32);
  }, [seed]);
  return (
    <group position={[c.x, 0, c.z]}>
      <mesh position={[0, h * 0.3, 0]} castShadow receiveShadow>
        <boxGeometry args={alongX ? [L, h * 0.6, C] : [C, h * 0.6, L]} />
        <meshStandardMaterial color={A_BRICK} roughness={1} flatShading />
      </mesh>
      {segs.map((sh, i) => {
        const segL = L / 3;
        const along = -L / 2 + segL / 2 + i * segL;
        const y = h * 0.6 + (h * (sh - 0.6)) / 2;
        return (
          <mesh key={i} position={alongX ? [along, y, 0] : [0, y, along]} castShadow>
            <boxGeometry args={alongX ? [segL * 0.96, h * (sh - 0.6), C * 0.96] : [C * 0.96, h * (sh - 0.6), segL * 0.96]} />
            <meshStandardMaterial color={i % 2 ? A_BRICK_DARK : A_PLASTER} roughness={1} flatShading />
          </mesh>
        );
      })}
    </group>
  );
}

function ScorchedWall({ c, seed }: { c: CoverBox; seed: number }) {
  const alongX = c.hx >= c.hz;
  const L = (alongX ? c.hx : c.hz) * 2;
  const C = (alongX ? c.hz : c.hx) * 2;
  const h = c.height;
  const lean = useMemo(() => {
    const rand = mulberry32(seed);
    return { at: (rand() - 0.5) * L * 0.5, tilt: 0.28 + rand() * 0.14 };
  }, [seed, L]);
  return (
    <group position={[c.x, 0, c.z]}>
      <mesh position={[0, h * 0.36, 0]} castShadow receiveShadow>
        <boxGeometry args={alongX ? [L, h * 0.72, C] : [C, h * 0.72, L]} />
        <meshStandardMaterial color={A_PLASTER} roughness={1} flatShading />
      </mesh>
      {/* charred jagged parapet up to the full LOS height */}
      <mesh position={[alongX ? -L * 0.22 : 0, h * 0.84, alongX ? 0 : -L * 0.22]} castShadow>
        <boxGeometry args={alongX ? [L * 0.5, h * 0.28, C] : [C, h * 0.28, L * 0.5]} />
        <meshStandardMaterial color={A_CHAR} roughness={1} flatShading />
      </mesh>
      <mesh position={[alongX ? L * 0.3 : 0, h * 0.79, alongX ? 0 : L * 0.3]} castShadow>
        <boxGeometry args={alongX ? [L * 0.34, h * 0.18, C] : [C, h * 0.18, L * 0.34]} />
        <meshStandardMaterial color={A_BRICK_DARK} roughness={1} flatShading />
      </mesh>
      {/* burnt beam leaning on the wall */}
      <mesh
        position={alongX ? [lean.at, h * 0.5, 0] : [0, h * 0.5, lean.at]}
        rotation={alongX ? [0, 0, lean.tilt] : [lean.tilt, 0, 0]}
        castShadow
      >
        <boxGeometry args={[0.11, h * 1.02, 0.11]} />
        <meshStandardMaterial color={A_CHAR} roughness={1} flatShading />
      </mesh>
    </group>
  );
}

function CrateStack({ c, seed }: { c: CoverBox; seed: number }) {
  const w = c.hx * 2;
  const d = c.hz * 2;
  const h = c.height;
  const yaw = useMemo(() => (mulberry32(seed)() - 0.5) * 0.7, [seed]);
  return (
    <group position={[c.x, 0, c.z]}>
      <mesh position={[0, h * 0.31, 0]} castShadow receiveShadow>
        <boxGeometry args={[w * 0.98, h * 0.62, d * 0.98]} />
        <meshStandardMaterial color={A_WOOD} roughness={1} flatShading />
      </mesh>
      <mesh position={[0, h * 0.62 + 0.015, 0]}>
        <boxGeometry args={[w, 0.03, d]} />
        <meshStandardMaterial color={A_CHAR} roughness={1} flatShading />
      </mesh>
      <mesh position={[w * 0.08, h * 0.81, -d * 0.06]} rotation={[0, yaw, 0]} castShadow>
        <boxGeometry args={[w * 0.58, h * 0.38, d * 0.58]} />
        <meshStandardMaterial color={A_WOOD} roughness={1} flatShading />
      </mesh>
    </group>
  );
}

function Barrels({ c, seed }: { c: CoverBox; seed: number }) {
  const h = c.height;
  const r = Math.min(c.hx, c.hz) * 0.52;
  const spots = useMemo(() => {
    const rand = mulberry32(seed);
    return [
      { x: -c.hx + r, z: -c.hz + r, hh: h, tip: 0 },
      { x: c.hx - r, z: -c.hz + r, hh: h * 0.82, tip: 0 },
      { x: 0, z: c.hz - r, hh: h * 0.9, tip: (rand() - 0.5) * 0.16 },
    ];
  }, [c, r, h, seed]);
  return (
    <group position={[c.x, 0, c.z]}>
      {/* rubble mound filling the gaps so the cluster reads as one blocker */}
      <mesh position={[0, h * 0.14, 0]} scale={[c.hx, h * 0.3, c.hz]} castShadow receiveShadow>
        <sphereGeometry args={[1, 8, 6]} />
        <meshStandardMaterial color={A_CHAR} roughness={1} flatShading />
      </mesh>
      {spots.map((s, i) => (
        <group key={i} position={[s.x, 0, s.z]} rotation={[s.tip, 0, s.tip]}>
          <mesh position={[0, s.hh / 2, 0]} castShadow receiveShadow>
            <cylinderGeometry args={[r, r, s.hh, 10]} />
            <meshStandardMaterial color={A_RUST} roughness={0.9} metalness={0.25} flatShading />
          </mesh>
          <mesh position={[0, s.hh - 0.02, 0]}>
            <cylinderGeometry args={[r * 0.92, r * 0.92, 0.05, 10]} />
            <meshStandardMaterial color={A_CHAR} roughness={1} flatShading />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function AshfallCoverPiece({ c, i }: { c: CoverBox; i: number }) {
  const h = c.height;
  const tallPillar = h > 1.5 && c.hx < 0.6 && c.hz < 0.6;
  const isWall = c.hx > c.hz * 1.8 || c.hz > c.hx * 1.8;
  const isLow = h < 1.05;
  const seed = 500 + i * 31 + ((c.x * 13 + c.z * 7) | 0);

  if (tallPillar) return <Chimney c={c} />;
  if (isWall && isLow) return i % 2 === 0 ? <Sandbags c={c} /> : <BrickWall c={c} seed={seed} />;
  if (isWall) return <ScorchedWall c={c} seed={seed} />;
  return i % 2 === 0 ? <CrateStack c={c} seed={seed} /> : <Barrels c={c} seed={seed} />;
}

export function CoverProps({ variant = 'stylized' }: { variant?: ArenaVariant }) {
  return (
    <group>
      {COVER.map((c, i) =>
        variant === 'ashfall' ? (
          <AshfallCoverPiece key={i} c={c} i={i} />
        ) : (
          <StylizedCoverPiece key={i} c={c} />
        ),
      )}
    </group>
  );
}
