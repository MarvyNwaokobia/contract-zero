import type { CoverBox } from '../../sim/Cover';
import { mulberry32 } from './prng';

/**
 * The Ashfall village layout — the single source of truth for WHERE everything
 * stands. AshfallArena renders from this data and villageColliders() derives
 * the sim's static collision/LOS boxes from the SAME data, so a wall you see
 * is exactly a wall that blocks you (movement, bullets, and the roam camera).
 *
 * Everything structural is seeded and deterministic. Purely cosmetic dressing
 * (soot, ember beds, roof beams) also lives here so the renderer never rolls
 * its own dice and drifts from the collision data.
 */

/** Player free-roam bound during the find-the-enemy phase. */
export const ROAM_RADIUS = 24;

export const WELL_POS: [number, number] = [13.5, 5.5];
export const CART_POS: [number, number] = [-14.5, -3.8];
export const CART_YAW = 0.6;

// Local→world offset rotation (THREE rotateY convention, matches sim/Cover).
function rot(lx: number, lz: number, yaw: number): [number, number] {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [c * lx + s * lz, -s * lx + c * lz];
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export interface HouseWall {
  lx: number; lz: number;   // centre offset in the house frame
  hx: number; hz: number;   // half extents in the house frame
  h: number;                // wall height
  mat: 'plaster' | 'brick';
  soot?: boolean;           // charred band across the top (back wall)
}

export interface HouseSpec {
  x: number; z: number; yaw: number;
  w: number; d: number;
  emberLight: boolean;
  walls: HouseWall[];
  hBack: number;
  chimney: { lx: number; lz: number; h: number } | null;
  beams: { x: number; fallen: boolean; tilt: number; yawJitter: number }[];
  ember: { lx: number; lz: number };
}

export interface TreeSpec { x: number; z: number; scale: number; seed: number }

const WALL_T = 0.3;

function buildHouse(x: number, z: number, yaw: number, w: number, d: number, seed: number, emberLight: boolean): HouseSpec {
  const rand = mulberry32(seed);
  const hBack = 2.3 + rand() * 0.9;
  const hLeft = hBack * (0.75 + rand() * 0.25);
  const hR1 = 0.9 + rand() * 0.5;
  const hR2 = 0.45 + rand() * 0.35;
  const frontRemnant = rand() > 0.35;
  const hFront = 0.5 + rand() * 0.4;
  const chimney = rand() > 0.55;
  const chimneyH = 3.3 + rand() * 0.9;

  const walls: HouseWall[] = [
    // back wall (away from the square)
    { lx: 0, lz: -d / 2, hx: w / 2, hz: WALL_T / 2, h: hBack, mat: 'plaster', soot: true },
    // left wall, mostly standing
    { lx: -w / 2, lz: 0, hx: WALL_T / 2, hz: d / 2, h: hLeft, mat: 'plaster' },
    // right wall collapsed to jagged stumps (low ones don't block shots — by design)
    { lx: w / 2, lz: -d * 0.2, hx: WALL_T / 2, hz: d * 0.25, h: hR1, mat: 'brick' },
    { lx: w / 2, lz: d * 0.3, hx: WALL_T / 2, hz: d * 0.14, h: hR2, mat: 'brick' },
  ];
  if (frontRemnant) {
    walls.push({ lx: -w * 0.22, lz: d / 2, hx: w * 0.25, hz: (WALL_T * 0.9) / 2, h: hFront, mat: 'brick' });
  }

  return {
    x, z, yaw, w, d, emberLight,
    walls,
    hBack,
    chimney: chimney ? { lx: -w / 2 + 0.45, lz: -d / 2 + 0.45, h: chimneyH } : null,
    beams: Array.from({ length: 4 }, (_, i) => ({
      x: -w * 0.32 + (i / 3) * w * 0.64 + (rand() - 0.5) * 0.3,
      fallen: i === 3 && rand() > 0.4,
      tilt: 0.5 + rand() * 0.25,
      yawJitter: (rand() - 0.5) * 0.5,
    })),
    ember: { lx: (rand() - 0.5) * w * 0.4, lz: (rand() - 0.5) * d * 0.3 },
  };
}

function buildVillage() {
  // Houses face the square with two street mouths on the duel axis (east/west).
  const rand = mulberry32(7);
  const gaps = [0, Math.PI];
  const houses: HouseSpec[] = [];
  let emberLights = 0;
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2 + (rand() - 0.5) * 0.22;
    if (gaps.some((g) => Math.abs(wrapAngle(a - g)) < 0.42)) continue;
    const r = 16 + rand() * 6;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const w = 5 + rand() * 3;
    const d = 4 + rand() * 2.5;
    const yaw = Math.atan2(-x, -z) + (rand() - 0.5) * 0.3;
    const emberLight = emberLights < 2 && rand() > 0.5;
    if (emberLight) emberLights++;
    houses.push(buildHouse(x, z, yaw, w, d, 100 + k * 17, emberLight));
  }

  const treeRand = mulberry32(59);
  const trees: TreeSpec[] = Array.from({ length: 4 }, (_, i) => {
    const a = 0.7 + i * 1.65 + treeRand() * 0.5;
    const r = 13 + treeRand() * 2.2;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r, scale: 0.85 + treeRand() * 0.6, seed: 300 + i * 13 };
  });

  return { houses, trees };
}

export const VILLAGE = buildVillage();

/**
 * The sim's static environment colliders, derived from the same layout the
 * renderer draws. Walls block movement + LOS at their real height (collapsed
 * stumps under the 1.05m shot line block movement only — you shoot over them).
 */
export function villageColliders(): CoverBox[] {
  const boxes: CoverBox[] = [];
  for (const h of VILLAGE.houses) {
    for (const w of h.walls) {
      const [ox, oz] = rot(w.lx, w.lz, h.yaw);
      boxes.push({ x: h.x + ox, z: h.z + oz, hx: w.hx, hz: w.hz, height: w.h, yaw: h.yaw });
    }
    if (h.chimney) {
      const [ox, oz] = rot(h.chimney.lx, h.chimney.lz, h.yaw);
      boxes.push({ x: h.x + ox, z: h.z + oz, hx: 0.4, hz: 0.4, height: h.chimney.h, yaw: h.yaw });
    }
  }
  for (const t of VILLAGE.trees) {
    boxes.push({ x: t.x, z: t.z, hx: 0.22 * t.scale, hz: 0.22 * t.scale, height: 3.6 * t.scale });
  }
  // Well: chest-high stone ring — blocks movement, you shoot over it.
  boxes.push({ x: WELL_POS[0], z: WELL_POS[1], hx: 0.95, hz: 0.95, height: 0.8 });
  // Tipped cart on the west road.
  boxes.push({ x: CART_POS[0], z: CART_POS[1], hx: 1.15, hz: 0.7, height: 1.0, yaw: CART_YAW });
  return boxes;
}
