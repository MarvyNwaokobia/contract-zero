/**
 * @module fps/levels
 * @description Playable environments for live operations.
 *
 * Each level is real geometry: every wall, vehicle, container and rack below is a
 * collider (`walls` block movement and sight; `cover` is waist-to-chest high), so
 * what you see is what stops you and what stops a bullet. Enemies path-find around
 * it (fps/nav). `art` is visual-only (roofs, light poles, catwalks overhead) and never
 * collides. Two levels so far, built to be different places, not relit copies:
 *
 *  - DUSTLINE DEPOT: a large outdoor logistics yard at dusk. Gate and motor pool, a
 *    container wall with two crossings, then a warehouse with racks and two doors.
 *  - BLACKSITE: a fortified research facility at night. A floodlit courtyard, then
 *    interiors: a central corridor, labs, a control room and the vault at the back.
 *
 * Mission-agnostic: a level offers zones to place guards in (`rooms`) and named
 * points for objectives; the mission director decides what happens there.
 */

import type { CoverBox } from './FpsSim'

export type LevelId = 'dustline_depot' | 'blacksite'

/** What a box looks like (colliders) or is (art). The scene picks a mesh per kind. */
export type Kind =
  | 'fence' | 'barrier' | 'container' | 'truck' | 'tank' | 'booth' | 'tower_leg' | 'crate' | 'case'
  | 'warehouse' | 'rack' | 'concrete' | 'facade' | 'interior' | 'desk' | 'server' | 'door_frame'

export interface Box extends CoverBox { kind: Kind; color?: string }

/** Visual-only set pieces. */
export interface Art {
  kind: 'roof' | 'tower' | 'light_pole' | 'floodlight' | 'catwalk' | 'beacon' | 'radar' | 'road' | 'stripe' | 'camera' | 'lamp'
  x: number; z: number; w?: number; d?: number; h?: number; rot?: number; color?: string
}

export interface LightSpec { pos: [number, number, number]; color: string; intensity: number; distance: number }

export interface Rect { x: [number, number]; z: [number, number] }

export interface LevelDef {
  id: LevelId
  name: string
  region: string
  start: [number, number]
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }
  walls: Box[]
  cover: Box[]
  art: Art[]
  lights: LightSpec[]
  /** Where each room's guards may be placed. */
  rooms: Record<1 | 2, Rect[]>
  points: {
    entry: [number, number]; push: [number, number]; cargo: [number, number]; extract: [number, number]
    /** Sabotage charge sites: one in the outer zone, one inside. */
    charges: [[number, number], [number, number]]
    /** Where seized cargo is held, and where it is handed back. */
    cache: [number, number]; handover: [number, number]
  }
  floor: { kind: 'dirt' | 'concrete' }
  /** Distance the sun's shadow camera must cover. */
  shadowHalf: number
}

const H = 3.4

// ── DUSTLINE DEPOT ───────────────────────────────────────────────────────────
// Start at the south gate (z≈14). The motor pool is z 12…-14, the container wall
// is z = -16 (crossings at x -6…6 and x 22…26), the warehouse yard z -18…-54.

const fence = (x: number, z: number, w: number, d: number): Box => ({ x, z, w, d, h: 3, kind: 'fence' })
const container = (x: number, z: number, along: 'x' | 'z', color: string, stacked = false): Box =>
  ({ x, z, w: along === 'x' ? 6 : 2.4, d: along === 'x' ? 2.4 : 6, h: stacked ? 5.2 : 2.6, kind: 'container', color })

const DEPOT: LevelDef = {
  id: 'dustline_depot',
  name: 'Dustline Logistics Depot',
  region: 'Dustline',
  start: [0, 14],
  bounds: { minX: -30, maxX: 30, minZ: -55, maxZ: 17 },
  walls: [
    // perimeter, with the gate at x -4…4
    fence(-17, 16.5, 26, 0.3), fence(17, 16.5, 26, 0.3),
    fence(-30, -19, 0.3, 71), fence(30, -19, 0.3, 71), fence(0, -54.5, 60, 0.3),
    // the container wall between motor pool and yard, crossings at x -6…6 and 22…26
    container(-27, -16, 'x', '#7a2f22', true), container(-21, -16, 'x', '#2f4a63'), container(-15, -16, 'x', '#5b5e3a', true), container(-9, -16, 'x', '#7a2f22'),
    container(9, -16, 'x', '#2f4a63', true), container(15, -16, 'x', '#6b4a2a'), container(19.7, -16, 'x', '#7a2f22'),
    container(28.2, -16, 'z', '#5b5e3a'),
    // warehouse: x -26…-6, z -24…-48; south door x -18…-14, east door z -32…-36
    { x: -22, z: -24, w: 8, d: 0.4, h: 7, kind: 'warehouse' }, { x: -10, z: -24, w: 8, d: 0.4, h: 7, kind: 'warehouse' },
    { x: -16, z: -48, w: 20, d: 0.4, h: 7, kind: 'warehouse' },
    { x: -26, z: -36, w: 0.4, d: 24, h: 7, kind: 'warehouse' },
    { x: -6, z: -28, w: 0.4, d: 8, h: 7, kind: 'warehouse' }, { x: -6, z: -42, w: 0.4, d: 12, h: 7, kind: 'warehouse' },
    // motor pool: guard booth, fuel tanks, watchtower legs
    { x: 7, z: 10, w: 3, d: 3, h: 2.8, kind: 'booth' },
    { x: 21, z: 4, w: 4, d: 4, h: 4.2, kind: 'tank' }, { x: 21, z: -3, w: 4, d: 4, h: 4.2, kind: 'tank' },
    { x: -20.4, z: 7.4, w: 0.35, d: 0.35, h: 7, kind: 'tower_leg' }, { x: -17.6, z: 7.4, w: 0.35, d: 0.35, h: 7, kind: 'tower_leg' },
    { x: -20.4, z: 4.6, w: 0.35, d: 0.35, h: 7, kind: 'tower_leg' }, { x: -17.6, z: 4.6, w: 0.35, d: 0.35, h: 7, kind: 'tower_leg' },
    // parked trucks (tall: you can't see over a truck)
    { x: -11, z: -2, w: 2.6, d: 7.2, h: 2.9, kind: 'truck' }, { x: 10, z: -5, w: 2.6, d: 7.2, h: 2.9, kind: 'truck' },
    { x: 14, z: -46, w: 2.6, d: 7.2, h: 2.9, kind: 'truck' },
    // yard container stacks
    container(10, -25, 'z', '#2f4a63'), container(17, -31, 'x', '#7a2f22', true), container(10, -39, 'z', '#5b5e3a'), container(21, -42, 'z', '#6b4a2a', true),
    // warehouse racks
    { x: -22, z: -38, w: 1.2, d: 8, h: 3.2, kind: 'rack' }, { x: -10.5, z: -41, w: 1.2, d: 7, h: 3.2, kind: 'rack' },
  ],
  cover: [
    { x: -2.5, z: 7, w: 3.2, d: 0.7, h: 1.1, kind: 'barrier' }, { x: 3.5, z: 4, w: 3.2, d: 0.7, h: 1.1, kind: 'barrier' },
    { x: -6, z: 0, w: 3.2, d: 0.7, h: 1.1, kind: 'barrier' }, { x: 2, z: -6, w: 3.2, d: 0.7, h: 1.1, kind: 'barrier' },
    { x: -2, z: -11, w: 1.4, d: 1.4, h: 1.2, kind: 'case' }, { x: 5, z: -10, w: 2.2, d: 1.2, h: 1.0, kind: 'crate' },
    { x: 14, z: 2, w: 1.4, d: 1.4, h: 1.3, kind: 'case' }, { x: -16, z: -8, w: 2.2, d: 1.2, h: 1.0, kind: 'crate' },
    { x: 2, z: -22, w: 3.2, d: 0.7, h: 1.1, kind: 'barrier' }, { x: -3, z: -30, w: 2.2, d: 1.2, h: 1.0, kind: 'crate' },
    { x: 4, z: -34, w: 1.4, d: 1.4, h: 1.2, kind: 'case' }, { x: -1, z: -44, w: 3.2, d: 0.7, h: 1.1, kind: 'barrier' },
    { x: 18, z: -22, w: 2.2, d: 1.2, h: 1.0, kind: 'crate' }, { x: 25, z: -36, w: 1.4, d: 1.4, h: 1.2, kind: 'case' },
    // inside the warehouse, around the cargo
    { x: -19, z: -31, w: 2.2, d: 1.2, h: 1.0, kind: 'crate' }, { x: -12, z: -33, w: 1.4, d: 1.4, h: 1.2, kind: 'case' },
    { x: -16, z: -43, w: 2.2, d: 1.2, h: 1.0, kind: 'crate' },
  ],
  art: [
    { kind: 'road', x: 0, z: -18, w: 8, d: 70 },
    { kind: 'roof', x: -16, z: -36, w: 20.6, d: 24.6, h: 7 },
    { kind: 'tower', x: -19, z: 6, h: 7 },
    { kind: 'light_pole', x: -6, z: 12 }, { kind: 'light_pole', x: 6, z: -12 }, { kind: 'light_pole', x: 0, z: -26 }, { kind: 'light_pole', x: 16, z: -50 },
    { kind: 'stripe', x: -16, z: -27.5, w: 4, d: 0.15 },
    { kind: 'beacon', x: -16, z: -24.2, h: 6, color: '#ff9a2e' },
  ],
  lights: [
    { pos: [-6, 7.5, 12], color: '#ffb066', intensity: 30, distance: 22 },
    { pos: [6, 7.5, -12], color: '#ffb066', intensity: 30, distance: 22 },
    { pos: [0, 7.5, -26], color: '#ffb066', intensity: 30, distance: 22 },
    { pos: [-16, 6, -34], color: '#ffd7a0', intensity: 26, distance: 18 },
    { pos: [16, 7.5, -50], color: '#ffb066', intensity: 24, distance: 20 },
  ],
  rooms: {
    1: [{ x: [-24, -4], z: [-13, 9] }, { x: [-2, 18], z: [-13, 2] }],
    2: [{ x: [-24.5, -7.5], z: [-46.5, -26] }, { x: [6, 27], z: [-52, -20] }],
  },
  points: {
    entry: [0, 9], push: [0, -17.5], cargo: [-16, -28.5], extract: [0, 14],
    charges: [[18, 4], [-20.2, -38]],   // the fuel depot · the munitions line in the warehouse
    cache: [16, -36], handover: [26, -24], // the container yard · Vex's truck at the east fence
  },
  floor: { kind: 'dirt' },
  shadowHalf: 44,
}

// ── BLACKSITE ────────────────────────────────────────────────────────────────
// Start at the courtyard gate (z≈19). The facility facade is z = 2 (main door
// x -2…2, side door x -14…-11). Inside: corridor x -2…2 to the vault (z -30…-42).

const conc = (x: number, z: number, w: number, d: number, h = 4.2): Box => ({ x, z, w, d, h, kind: 'concrete' })
const inner = (x: number, z: number, w: number, d: number): Box => ({ x, z, w, d, h: H, kind: 'interior' })

const BLACKSITE: LevelDef = {
  id: 'blacksite',
  name: 'Blacksite Research Facility',
  region: 'Blacksite',
  start: [0, 19],
  bounds: { minX: -22, maxX: 22, minZ: -44, maxZ: 22 },
  walls: [
    // perimeter wall, gate at x -3…3
    conc(-12, 21.5, 18, 0.6), conc(12, 21.5, 18, 0.6), conc(-21.5, -11, 0.6, 65), conc(21.5, -11, 0.6, 65), conc(0, -43.5, 44, 0.6),
    // facade z = 2: main door x -2…2, side door x -14…-11
    { x: -16, z: 2, w: 4, d: 0.6, h: 6, kind: 'facade' }, { x: -6.5, z: 2, w: 9, d: 0.6, h: 6, kind: 'facade' }, { x: 10, z: 2, w: 16, d: 0.6, h: 6, kind: 'facade' },
    // close the side alleys between the facade and the perimeter
    conc(-19.75, 2, 3.5, 0.6), conc(19.75, 2, 3.5, 0.6),
    // building shell
    inner(-18, -20, 0.4, 44), inner(18, -20, 0.4, 44), inner(0, -42, 36, 0.4),
    // corridor walls x = ±2 from z 2 to -30, with doors
    inner(-2, -3.15, 0.4, 9.7), inner(-2, -15, 0.4, 10), inner(-2, -26, 0.4, 8),   // west doors z -8…-10, -20…-22
    inner(2, -5.15, 0.4, 13.7), inner(2, -18, 0.4, 8), inner(2, -28, 0.4, 4),      // east doors z -12…-14, -22…-26
    // west labs split at z = -15 (gap x -10…-8)
    inner(-14, -15, 8, 0.4), inner(-5, -15, 6, 0.4),
    // east: control room / server room split at z = -18 (gap x 9…11)
    inner(5.5, -18, 7, 0.4), inner(14.5, -18, 7, 0.4),
    // vault wall z = -30: doors at x -2…2 (corridor) and x 10…12
    inner(-10, -30, 16, 0.4), inner(6, -30, 8, 0.4), inner(15, -30, 6, 0.4),
    // labs and servers
    { x: -13, z: -6, w: 5, d: 1.2, h: 1.0, kind: 'desk' }, { x: -10, z: -24, w: 1.2, d: 6, h: 1.0, kind: 'desk' },
    { x: 8, z: -24, w: 1, d: 6, h: 2.3, kind: 'server' }, { x: 14, z: -24, w: 1, d: 6, h: 2.3, kind: 'server' },
    { x: 10, z: -6, w: 6, d: 1.2, h: 1.0, kind: 'desk' },
    // courtyard: guard booth, parked APC, tower legs
    { x: 9, z: 16, w: 3, d: 3, h: 2.8, kind: 'booth' },
    { x: 13, z: 8, w: 2.8, d: 6.6, h: 2.9, kind: 'truck' },
    { x: -17.4, z: 17.4, w: 0.35, d: 0.35, h: 7, kind: 'tower_leg' }, { x: -14.6, z: 17.4, w: 0.35, d: 0.35, h: 7, kind: 'tower_leg' },
    { x: -17.4, z: 14.6, w: 0.35, d: 0.35, h: 7, kind: 'tower_leg' }, { x: -14.6, z: 14.6, w: 0.35, d: 0.35, h: 7, kind: 'tower_leg' },
  ],
  cover: [
    { x: -6, z: 12, w: 1.4, d: 1.4, h: 1.2, kind: 'case' }, { x: 3.5, z: 9, w: 2.2, d: 1.2, h: 1.0, kind: 'crate' },
    { x: -10, z: 6, w: 3.2, d: 0.7, h: 1.1, kind: 'barrier' }, { x: 1, z: 13, w: 3.2, d: 0.7, h: 1.1, kind: 'barrier' },
    { x: -2, z: 5.5, w: 1.4, d: 1.4, h: 1.2, kind: 'case' }, { x: 7, z: 5, w: 2.2, d: 1.2, h: 1.0, kind: 'crate' },
    // vault: cases around the cargo
    { x: -4, z: -35, w: 1.4, d: 1.4, h: 1.2, kind: 'case' }, { x: 4, z: -37, w: 2.2, d: 1.2, h: 1.0, kind: 'crate' },
    { x: -10, z: -39, w: 2.2, d: 1.2, h: 1.0, kind: 'crate' }, { x: 12, z: -36, w: 1.4, d: 1.4, h: 1.2, kind: 'case' },
  ],
  art: [
    { kind: 'roof', x: 0, z: -20, w: 36.6, d: 44.6, h: H + 0.05 },
    { kind: 'tower', x: -16, z: 16, h: 7 },
    { kind: 'floodlight', x: -16, z: 16, h: 7.4, rot: -0.6 },
    { kind: 'catwalk', x: 0, z: 2.5, w: 34, d: 1.4, h: 4.6 },
    { kind: 'radar', x: 14, z: -60, h: 22 },
    { kind: 'beacon', x: -21.5, z: 21.5, h: 4.6, color: '#ff3b30' }, { kind: 'beacon', x: 21.5, z: 21.5, h: 4.6, color: '#ff3b30' },
    { kind: 'camera', x: -2.6, z: 2.4, h: 3.2 }, { kind: 'camera', x: 2.6, z: -29.6, h: 3 },
    { kind: 'lamp', x: 0, z: -6, h: 3.3 }, { kind: 'lamp', x: 0, z: -20, h: 3.3 }, { kind: 'lamp', x: -10, z: -6, h: 3.3 }, { kind: 'lamp', x: 10, z: -10, h: 3.3 },
    { kind: 'lamp', x: 0, z: -36, h: 3.3 }, { kind: 'lamp', x: -10, z: -24, h: 3.3 }, { kind: 'lamp', x: 11, z: -24, h: 3.3 },
    { kind: 'stripe', x: 0, z: -34, w: 6, d: 0.15 },
  ],
  lights: [
    { pos: [-15, 7, 14], color: '#cfe0ff', intensity: 60, distance: 30 },   // floodlight
    { pos: [0, 3.1, -6], color: '#c6d8ff', intensity: 9, distance: 10 },
    { pos: [0, 3.1, -20], color: '#c6d8ff', intensity: 9, distance: 10 },
    { pos: [-10, 3.1, -6], color: '#ffd29a', intensity: 7, distance: 9 },
    { pos: [11, 3.1, -24], color: '#ff4a3a', intensity: 6, distance: 9 },   // server room, red
    { pos: [0, 3.1, -36], color: '#ffb36a', intensity: 10, distance: 12 },  // the vault
  ],
  rooms: {
    1: [{ x: [-19, 19], z: [4, 17] }],
    2: [{ x: [-17, -3], z: [-29, 1] }, { x: [3, 17], z: [-29, 1] }, { x: [-16, 16], z: [-41, -31.5] }],
  },
  points: {
    entry: [0, 16], push: [0, 3.5], cargo: [0, -35.5], extract: [0, 19],
    charges: [[12.5, 12], [11, -24]],   // the APC motor bay · the server room
    cache: [10, -10], handover: [0, 19], // the control room · out the gate
  },
  floor: { kind: 'concrete' },
  shadowHalf: 36,
}

export const LEVELS: Record<LevelId, LevelDef> = { dustline_depot: DEPOT, blacksite: BLACKSITE }

/** Which level a contract's zone (time of day) plays on. */
export function levelForZone(zone: string): LevelId {
  return zone === 'BLACKSITE' ? 'blacksite' : 'dustline_depot'
}
