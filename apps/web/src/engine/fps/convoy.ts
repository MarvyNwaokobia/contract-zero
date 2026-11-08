/**
 * @module fps/convoy
 * @description Builds a convoy-raid Mission from a contract's parameters.
 *
 * The economy decides WHAT the convoy is (cargo, how well the owning faction
 * defends it, where); this file turns that into playable mission data for the
 * existing FPS engine. It is pure and seeded: the same contract always produces
 * the same mission, so the server can recompute exactly what the player faced.
 *
 * Flow on Layout B (entry → hall → convoy yard):
 *   1. INTERCEPT THE CONVOY  reach the hall door, wakes the forward escort
 *   2. CLEAR THE ESCORT      kill the hall escort
 *   3. PUSH TO THE YARD      reach the yard door, wakes the convoy guard
 *   4. LOAD THE CARGO        hold the cargo point while reinforcements come
 *   5. EXTRACT WITH CARGO    walk the cargo back out to the entry
 */

import type { CoverBox, EnemySpec } from './index';
import type { GunId } from '../combat/GunStats';
import { LAYOUT_B, type Mission } from './campaign';
import { mulberry32 } from './endless';

export type Resource = 'ammo' | 'med' | 'fuel';
export type ConvoyZone = 'ASHFALL' | 'PROVING GROUND' | 'THE RIFT';

export interface ConvoyContract {
  /** Stable contract id; also the default seed source. */
  id: string;
  /** Faction that posted the contract (who pays). */
  issuer: string;
  /** Faction whose convoy is being raided. */
  target: string;
  cargo: { resource: Resource; units: number };
  /** The target's defense posture, 1 (light) … 5 (fortified). Set by its commander. */
  defense: number;
  /** Seed for escort placement. */
  seed: number;
  /** Time of day / theme. Defaults to ASHFALL. */
  zone?: ConvoyZone;
}

export const RESOURCE_LABEL: Record<Resource, string> = {
  ammo: 'AMMUNITION',
  med: 'MEDICAL SUPPLIES',
  fuel: 'FUEL',
};

/** Playable-space bounds of Layout B's two rooms (inside the walls, off the dividers). */
const ROOM_BOUNDS: Record<1 | 2, { x: [number, number]; z: [number, number] }> = {
  1: { x: [-8.6, 8.6], z: [-4.6, 4.6] },
  2: { x: [-8.6, 8.6], z: [-16.6, -7.4] },
};

/** Two parked trucks plus cargo crates in the yard (replace Layout B's room-2 cover). */
const YARD_COVER: CoverBox[] = [
  { x: -5, z: -11.5, w: 2.4, d: 5.2, h: 2.2 },  // truck, west
  { x: 5.5, z: -13, w: 2.4, d: 5.2, h: 2.2 },   // truck, east (clear of the x=3..7 door)
  { x: 0.8, z: -14.5, w: 1.2, d: 1.2, h: 1.1 }, // cargo crates
  { x: -1.4, z: -9, w: 1.4, d: 1.0, h: 1.1 },
];

/** Where the player stands to load the cargo. */
export const CARGO_POINT: [number, number] = [0, -11.5];

export const clampDefense = (d: number): number => Math.min(5, Math.max(1, Math.round(d)));

/** Escorts per room, escort HP, and hold pressure for a defense level. */
export function convoyDifficulty(defense: number) {
  const d = clampDefense(defense);
  return {
    hallEscorts: 2 + d,                      // 3 … 7
    yardEscorts: 3 + d,                      // 4 … 8
    escortHp: Math.round(100 * (1 + 0.12 * (d - 1))), // 100 … 148
    reinforceEvery: +(4.5 - 0.4 * d).toFixed(2),     // 4.1s … 2.5s
    reinforceCount: d >= 4 ? 3 : 2,
  };
}

/** Seconds to load: bigger cargo takes longer to load under fire. */
export function loadSeconds(units: number): number {
  return Math.min(20, Math.max(8, Math.round(8 + units / 25)));
}

function overlapsCover(x: number, z: number, cover: CoverBox[], margin: number): boolean {
  return cover.some((c) => Math.abs(x - c.x) < c.w / 2 + margin && Math.abs(z - c.z) < c.d / 2 + margin);
}

/** Seeded escort placement inside a room, clear of cover and of each other. */
function placeEscorts(room: 1 | 2, count: number, hp: number, cover: CoverBox[], rng: () => number): EnemySpec[] {
  const b = ROOM_BOUNDS[room];
  const out: EnemySpec[] = [];
  for (let tries = 0; out.length < count && tries < 400; tries++) {
    const x = b.x[0] + rng() * (b.x[1] - b.x[0]);
    const z = b.z[0] + rng() * (b.z[1] - b.z[0]);
    if (overlapsCover(x, z, cover, 1.0)) continue;
    if (out.some((e) => Math.hypot(e.pos[0] - x, e.pos[1] - z) < 2.2)) continue;
    out.push({ pos: [+x.toFixed(2), +z.toFixed(2)], room, hp });
  }
  return out;
}

export function buildConvoyMission(c: ConvoyContract, gun: GunId = 'assault_rifle' as GunId): Mission {
  const diff = convoyDifficulty(c.defense);
  const rng = mulberry32(c.seed >>> 0);
  const cover = [...LAYOUT_B.cover.filter((k) => k.z > -6), ...YARD_COVER];
  const label = RESOURCE_LABEL[c.cargo.resource];
  const zone = c.zone ?? 'ASHFALL';
  const o = LAYOUT_B.obj;

  return {
    id: `contract-${c.id}`,
    zone,
    op: `CONTRACT · ${c.issuer.toUpperCase()}`,
    name: `${label} CONVOY`,
    brief: `raid ${c.target}'s convoy · load ${c.cargo.units} ${label.toLowerCase()} · extract`,
    story: `${c.issuer} is paying for ${c.target}'s ${label.toLowerCase()}. ${c.cargo.units} units are parked in the yard under a level-${clampDefense(c.defense)} guard. Load it and walk it out.`,
    gun,
    start: LAYOUT_B.start,
    walls: [...LAYOUT_B.walls],
    cover,
    enemies: [
      ...placeEscorts(1, diff.hallEscorts, diff.escortHp, cover, rng),
      ...placeEscorts(2, diff.yardEscorts, diff.escortHp, cover, rng),
    ],
    objectives: [
      { text: 'INTERCEPT THE CONVOY', kind: 'reach', pos: o.breach, activateRoom: 1 },
      { text: 'CLEAR THE ESCORT', kind: 'clear', room: 1, pos: [o.breach[0], o.breach[1] - 4] },
      { text: 'PUSH TO THE YARD', kind: 'reach', pos: o.push, activateRoom: 2 },
      {
        text: `LOAD THE ${label}`, kind: 'defend', pos: CARGO_POINT, holdSecs: loadSeconds(c.cargo.units),
        reinforceRoom: 2, reinforceEvery: diff.reinforceEvery, reinforceCount: diff.reinforceCount,
      },
      { text: 'EXTRACT WITH THE CARGO', kind: 'reach', pos: LAYOUT_B.start },
    ],
    attachments: zone === 'THE RIFT' ? ['nvg'] : undefined,
  };
}
