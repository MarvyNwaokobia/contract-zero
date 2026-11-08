/**
 * @module fps/campaign
 * @description The mission campaign (the plan slice 4→8). The engine runs ONE
 * mission's data at a time; this file is that data, as a list, grouped by zone.
 *
 * A Mission is pure data — compound geometry, enemy roster, objective sequence,
 * briefing, starting weapon. The scene loads `CAMPAIGN[i]`, completing a mission
 * advances to the next, and each zone ends on a boss. Zones also carry a visual
 * theme (lighting / fog / tint) so Ashfall, the Proving Ground and the Rift read
 * as different places.
 */

import type { CoverBox, EnemySpec, Attachment } from './index';
import type { GunId } from '../combat/GunStats';

export interface Objective {
  text: string;
  // reach  — get within range of a point
  // clear  — kill everyone in a room
  // defend — hold a point for `holdSecs` while reinforcements keep coming
  // rescue — reach the hostage (then a following `reach` walks them to extract)
  kind: 'reach' | 'clear' | 'defend' | 'rescue';
  pos: [number, number];
  room?: number;
  activateRoom?: number;
  holdSecs?: number;       // defend: seconds to hold the point
  reinforceRoom?: number;  // defend: the room reinforcements are drawn from (defaults to `room`)
}

export interface Mission {
  id: string;
  zone: string;   // ASHFALL / PROVING GROUND / THE RIFT
  op: string;     // briefing header, e.g. "OPERATION ASHFALL"
  name: string;   // mission title, e.g. "BREACH & CLEAR"
  brief: string;  // one-line briefing subtitle
  gun: GunId;         // primary weapon for the op
  story?: string;     // a narrative lead-in shown on the pre-mission debrief screen
  secondary?: GunId;  // sidearm slot (defaults to the pistol) — swap with the swap key
  attachments?: Attachment[]; // fitted at op start (e.g. NVG in the Rift)
  start: [number, number];
  walls: CoverBox[];
  cover: CoverBox[];
  enemies: EnemySpec[];
  objectives: Objective[];
  hostage?: [number, number]; // a rescue op's VIP start point
  blackout?: boolean;  // the Rift with NVG jammed — you fight by muzzle-flash
  boss?: boolean;
  survival?: boolean; // endless-wave arena instead of a doorkicker (no objectives)
  gauntlet?: boolean; // the PRESTIGE survival tier: steeper curve, ranked (B2)
  /** ENDLESS: the generated room chain (fps/endless.ts) instead of authored rooms.
   *  Same doorkicker gameplay, but rooms are streamed in ahead of the player and
   *  never run out, so a run is one continuous session with no mission list. Drives
   *  both Campaign Endless and the Seasonal Campaign. */
  endless?: boolean;
}

/** Survival escalation: how many attackers and how tough, by 1-based wave. */
export function survivalWaveCount(wave: number): number { return Math.min(3 + wave, 10); }
export function survivalWaveHp(wave: number): number { return 1 + (wave - 1) * 0.09; }

/** GAUNTLET escalation (B2 prestige tier): more attackers sooner and tougher than
 *  practice Survival — the ranked curve whose runs feed the seasonal ladder. */
export function gauntletWaveCount(wave: number): number { return Math.min(5 + wave, 12); }
export function gauntletWaveHp(wave: number): number { return 1 + (wave - 1) * 0.15; }

/** Per-zone look. Lighting is in physical units (single digits for point lights). */
export interface ZoneTheme {
  bg: string;
  fog: [string, number, number];
  hemi: [string, string, number];
  sun: { color: string; intensity: number };
  fill: { color: string; intensity: number };
  ambient: number;
  practical: string;
  practicalIntensity: number;
  floorTint: string;
  wallTint: string;
  /** Gradient sky dome: zenith → horizon colour. This is the actual sky the
   *  player sees above the compound walls (day blue / evening gold / night). */
  sky: { top: string; bottom: string };
}

export const ZONE_THEMES: Record<string, ZoneTheme> = {
  // ASHFALL — daytime. A real blue sky over the burned village; bright, warm sun.
  ASHFALL: {
    bg: '#aec6de', fog: ['#c2d2e2', 34, 96], hemi: ['#bcd6f0', '#6a5a42', 0.95],
    sun: { color: '#fff3e0', intensity: 2.5 }, fill: { color: '#8fb0d8', intensity: 0.5 },
    ambient: 0.6, practical: '#ffd0a0', practicalIntensity: 1.1, floorTint: '#b3a898', wallTint: '#ac9f90',
    sky: { top: '#3f7ec9', bottom: '#cbd9e4' },
  },
  // PROVING GROUND — golden-hour evening. Low warm sun, cool sky opposite it.
  'PROVING GROUND': {
    bg: '#c68a54', fog: ['#b67c4c', 30, 86], hemi: ['#d8b489', '#3a3026', 0.78],
    sun: { color: '#ffb066', intensity: 1.8 }, fill: { color: '#6f86b6', intensity: 0.46 },
    ambient: 0.44, practical: '#ffc59a', practicalIntensity: 1.7, floorTint: '#a29683', wallTint: '#9a8d7e',
    sky: { top: '#5566a4', bottom: '#e2a05e' },
  },
  // THE RIFT — night, but a readable night: deep blue moonlight, not pitch black.
  // NVG lifts it further; only the blackout op leans all the way into the dark.
  'THE RIFT': {
    bg: '#0d1626', fog: ['#101c34', 18, 58], hemi: ['#617fb2', '#10131e', 0.46],
    sun: { color: '#93aade', intensity: 1.0 }, fill: { color: '#6a55d0', intensity: 0.5 },
    ambient: 0.24, practical: '#9a6bff', practicalIntensity: 2.2, floorTint: '#5c5c68', wallTint: '#545660',
    sky: { top: '#0a1122', bottom: '#1e2f4e' },
  },
  // SURVIVAL — a stark, red-lit kill-house for the endless mode.
  SURVIVAL: {
    bg: '#1a0f16', fog: ['#20121a', 20, 60], hemi: ['#8a6274', '#1e131a', 0.56],
    sun: { color: '#ffc3c0', intensity: 1.3 }, fill: { color: '#b45464', intensity: 0.44 },
    ambient: 0.34, practical: '#ff5a52', practicalIntensity: 2.2, floorTint: '#8a808a', wallTint: '#7e767e',
    sky: { top: '#1a0e14', bottom: '#3c1a22' },
  },
};

const WALL_H = 3.4;

/** The 5-beat doorkicker objective sequence for a two-room compound. */
function twoRoom(o: { breach: [number, number]; push: [number, number]; extract: [number, number]; clear2?: string }): Objective[] {
  return [
    { text: 'BREACH THE COMPOUND', kind: 'reach', pos: o.breach, activateRoom: 1 },
    { text: 'CLEAR THE FRONT ROOM', kind: 'clear', room: 1, pos: [o.breach[0], o.breach[1] - 4] },
    { text: 'PUSH TO THE OBJECTIVE', kind: 'reach', pos: o.push, activateRoom: 2 },
    { text: o.clear2 ?? 'CLEAR THE OBJECTIVE ROOM', kind: 'clear', room: 2, pos: [o.push[0], o.push[1] - 4] },
    { text: 'EXTRACT', kind: 'reach', pos: o.extract },
  ];
}

// ── LAYOUT A · the Ashfall compound (entry → front room → objective room) ──
const A_START: [number, number] = [0, 16];
const A_WALLS: CoverBox[] = [
  { x: -10, z: 0, w: 0.6, d: 37, h: WALL_H }, { x: 10, z: 0, w: 0.6, d: 37, h: WALL_H },
  { x: 0, z: 18.2, w: 20.6, d: 0.6, h: WALL_H },
  { x: -5.8, z: 8, w: 8.4, d: 0.6, h: WALL_H }, { x: 5.8, z: 8, w: 8.4, d: 0.6, h: WALL_H },
  { x: -3.75, z: 0, w: 12.5, d: 0.6, h: WALL_H }, { x: 7.75, z: 0, w: 4.5, d: 0.6, h: WALL_H },
  { x: -7.25, z: -8, w: 5.5, d: 0.6, h: WALL_H }, { x: 4.25, z: -8, w: 11.5, d: 0.6, h: WALL_H },
];
const A_COVER: CoverBox[] = [
  { x: 0, z: 12, w: 1.6, d: 1.6, h: 1.2 }, { x: -4, z: 5, w: 1.4, d: 1.4, h: 1.3 },
  { x: 3.5, z: 3.5, w: 2.0, d: 1.0, h: 1.35 }, { x: -2, z: 1.5, w: 1.2, d: 1.2, h: 1.2 },
  { x: -4, z: -3, w: 1.4, d: 1.4, h: 1.4 }, { x: 4, z: -6, w: 2.2, d: 1.0, h: 1.35 },
  { x: -6, z: -5.5, w: 1.0, d: 2.4, h: 1.5 }, { x: 2, z: -2, w: 1.4, d: 1.4, h: 1.2 },
];
const A_OBJ = { breach: [0, 8.5] as [number, number], push: [4, 0.5] as [number, number], extract: [-3, -14] as [number, number] };

// ── LAYOUT A2 · the Ashfall row-house (ash-2): same footprint, but the doors
//    zigzag the other way — left, then right, then centre — so it reads as a
//    different building even though the theme is identical. ──
const A2_START: [number, number] = [0, 16];
const A2_WALLS: CoverBox[] = [
  { x: -10, z: 0, w: 0.6, d: 37, h: WALL_H }, { x: 10, z: 0, w: 0.6, d: 37, h: WALL_H },
  { x: 0, z: 18.2, w: 20.6, d: 0.6, h: WALL_H },
  { x: -7.8, z: 9, w: 3.8, d: 0.6, h: WALL_H }, { x: 3.65, z: 9, w: 12.1, d: 0.6, h: WALL_H },  // door LEFT
  { x: -3.7, z: 1, w: 12, d: 0.6, h: WALL_H }, { x: 7.75, z: 1, w: 3.9, d: 0.6, h: WALL_H },     // door RIGHT
  { x: -5.8, z: -7, w: 8.4, d: 0.6, h: WALL_H }, { x: 5.8, z: -7, w: 8.4, d: 0.6, h: WALL_H },   // door CENTRE
];
const A2_COVER: CoverBox[] = [
  { x: 0, z: 6, w: 1.6, d: 1.6, h: 1.2 }, { x: -4, z: 3, w: 1.4, d: 1.4, h: 1.3 }, { x: 4, z: 4, w: 2.0, d: 1.0, h: 1.35 },
  { x: -3, z: -2, w: 1.4, d: 1.4, h: 1.4 }, { x: 4, z: -5, w: 2.2, d: 1.0, h: 1.35 }, { x: -6, z: -4, w: 1.0, d: 2.4, h: 1.5 }, { x: 1, z: -3, w: 1.4, d: 1.4, h: 1.2 },
];
const A2_OBJ = { breach: [-4, 8] as [number, number], push: [4, 0.3] as [number, number], extract: [0, -13] as [number, number] };

// ── LAYOUT A3 · the Ashfall stronghold (ash-3, Cinder): doors mirror A2 (right,
//    left, right) and funnel to a back room where Cinder holds. ──
const A3_START: [number, number] = [0, 16];
const A3_WALLS: CoverBox[] = [
  { x: -10, z: 0, w: 0.6, d: 37, h: WALL_H }, { x: 10, z: 0, w: 0.6, d: 37, h: WALL_H },
  { x: 0, z: 18.2, w: 20.6, d: 0.6, h: WALL_H },
  { x: -3.7, z: 9, w: 12, d: 0.6, h: WALL_H }, { x: 7.75, z: 9, w: 3.9, d: 0.6, h: WALL_H },     // door RIGHT
  { x: -7.75, z: 1, w: 3.9, d: 0.6, h: WALL_H }, { x: 3.7, z: 1, w: 12, d: 0.6, h: WALL_H },     // door LEFT
  { x: -3.7, z: -7, w: 12, d: 0.6, h: WALL_H }, { x: 7.75, z: -7, w: 3.9, d: 0.6, h: WALL_H },   // door RIGHT
];
const A3_COVER: CoverBox[] = [
  { x: 0, z: 6, w: 1.6, d: 1.6, h: 1.2 }, { x: 3, z: 3, w: 1.4, d: 1.4, h: 1.3 }, { x: -3, z: 4, w: 2.0, d: 1.0, h: 1.35 },
  { x: 4, z: -4, w: 1.0, d: 2.4, h: 1.5 }, { x: -4, z: -5, w: 1.6, d: 1.0, h: 1.35 }, { x: 1, z: -2, w: 1.4, d: 1.4, h: 1.2 },
];
const A3_OBJ = { breach: [4, 8] as [number, number], push: [-4, 0.3] as [number, number], extract: [4, -13] as [number, number] };

// ── LAYOUT B · a wider hall then a deep objective room; doorways offset the
//    other way, so it plays as a different building, not the same rooms. ──
const B_START: [number, number] = [0, 14];
const B_WALLS: CoverBox[] = [
  { x: -10, z: -1, w: 0.6, d: 35, h: WALL_H }, { x: 10, z: -1, w: 0.6, d: 35, h: WALL_H },
  { x: 0, z: 16.2, w: 20.6, d: 0.6, h: WALL_H },
  { x: -8, z: 6, w: 4, d: 0.6, h: WALL_H }, { x: 4, z: 6, w: 12, d: 0.6, h: WALL_H },     // divider @z6, door at x=-4
  { x: -3.5, z: -6, w: 13, d: 0.6, h: WALL_H }, { x: 8.5, z: -6, w: 3, d: 0.6, h: WALL_H }, // divider @z-6, door at x=5
];
const B_COVER: CoverBox[] = [
  { x: 2, z: 11, w: 1.6, d: 1.6, h: 1.2 }, { x: -3, z: 2, w: 1.4, d: 2.4, h: 1.4 },
  { x: 4, z: -1, w: 2.2, d: 1.0, h: 1.35 }, { x: -5, z: -2, w: 1.2, d: 1.2, h: 1.2 }, { x: 2, z: 3, w: 1.4, d: 1.4, h: 1.3 },
  { x: -3, z: -11, w: 1.6, d: 1.6, h: 1.4 }, { x: 4, z: -13, w: 1.0, d: 2.4, h: 1.5 }, { x: -6, z: -10, w: 1.4, d: 1.0, h: 1.3 },
];
const B_OBJ = { breach: [-4, 6.5] as [number, number], push: [5, -5.5] as [number, number], extract: [0, -15] as [number, number] };

// ── LAYOUT C · the Rift: tight, claustrophobic, a straight push through two
//    centred doorways into the room where Valor waits. ──
const C_START: [number, number] = [0, 12];
const C_WALLS: CoverBox[] = [
  { x: -9, z: -1, w: 0.6, d: 31, h: WALL_H }, { x: 9, z: -1, w: 0.6, d: 31, h: WALL_H },
  { x: 0, z: 14.2, w: 18.6, d: 0.6, h: WALL_H },
  { x: -5.5, z: 4, w: 7, d: 0.6, h: WALL_H }, { x: 5.5, z: 4, w: 7, d: 0.6, h: WALL_H },     // divider @z4, centre door
  { x: -5.5, z: -6, w: 7, d: 0.6, h: WALL_H }, { x: 5.5, z: -6, w: 7, d: 0.6, h: WALL_H },   // divider @z-6, centre door
];
const C_COVER: CoverBox[] = [
  { x: 0, z: 9, w: 1.6, d: 1.6, h: 1.2 },
  { x: -3, z: 0, w: 1.4, d: 1.4, h: 1.3 }, { x: 3, z: -1, w: 1.4, d: 1.0, h: 1.35 }, { x: 0, z: 2, w: 1.2, d: 1.2, h: 1.2 },
  { x: -3, z: -11, w: 1.6, d: 1.6, h: 1.4 }, { x: 3, z: -12, w: 1.4, d: 1.0, h: 1.3 }, { x: 0, z: -9, w: 1.2, d: 2.0, h: 1.5 },
];
const C_OBJ = { breach: [0, 4.5] as [number, number], push: [0, -5.5] as [number, number], extract: [0, -13] as [number, number] };

const AR = 'assault_rifle' as GunId;
const SMG = 'smg' as GunId;
const DMR = 'marksman' as GunId;
const PROTO = 'legendary' as GunId; // the "Valor Prototype" — the finale weapon

export const CAMPAIGN: Mission[] = [
  // ── Zone 1 · ASHFALL (day → dusk; bosses on op 5) ──
  {
    id: 'ash-1', zone: 'ASHFALL', op: 'OPERATION ASHFALL', name: 'BREACH & CLEAR', gun: AR, story: 'You walked out of the fire alive. Ember found your channel. The crew that lit Ashfall is dug into the first compound — go take it back.',
    brief: 'push the compound · clear both rooms · reach extract',
    start: A_START, walls: A_WALLS, cover: A_COVER,
    enemies: [
      { pos: [-4, 4], room: 1 }, { pos: [4, 5], room: 1 }, { pos: [-1, 3], room: 1 }, { pos: [3.5, 2.5], room: 1 },
      { pos: [-5, -4], room: 2 }, { pos: [5, -5], room: 2 }, { pos: [0, -6], room: 2 }, { pos: [-3, -7], room: 2 }, { pos: [4, -2.5], room: 2 },
    ],
    objectives: twoRoom(A_OBJ),
  },
  {
    id: 'ash-2', zone: 'ASHFALL', op: 'OPERATION ASHFALL', name: 'HOLD THE LINE', gun: SMG, story: "They know you lived now, and they know you're coming. This block is dug in deeper. Hold the line and push through.",
    brief: 'more of them, dug in · clear the compound',
    start: A2_START, walls: A2_WALLS, cover: A2_COVER,
    enemies: [
      { pos: [-5, 6], room: 1 }, { pos: [5, 5], room: 1 }, { pos: [-2, 4], room: 1 }, { pos: [3, 6], room: 1 }, { pos: [0, 3], room: 1 },
      { pos: [-7, -2], room: 2 }, { pos: [6, -4], room: 2 }, { pos: [0, -5], room: 2 }, { pos: [-3, -6], room: 2 }, { pos: [4, -2], room: 2 }, { pos: [-1, -5], room: 2 }, { pos: [2, -6], room: 2 },
    ],
    objectives: twoRoom(A2_OBJ),
  },
  {
    // ── SIGNATURE (defend) · hold a burning well while the crew counter-attacks ──
    id: 'ash-3', zone: 'ASHFALL', op: 'OPERATION ASHFALL', name: 'THE WELL', gun: AR, secondary: SMG,
    story: "Ashfall's only clean water runs under the old well-house. Take it and hold it — the crew will throw everything they have left to take it back.",
    brief: 'seize the well-house · hold it until the counter-attack breaks',
    start: A3_START, walls: A3_WALLS, cover: A3_COVER,
    enemies: [
      { pos: [-4, 6], room: 1 }, { pos: [4, 5], room: 1 }, { pos: [-2, 3], room: 1 },
      // room 2 = the reinforcement pool that keeps rushing the well during the hold
      { pos: [0, -5], room: 2 }, { pos: [-5, -3], room: 2 }, { pos: [5, -4], room: 2 }, { pos: [3, -6.5], room: 2 }, { pos: [-3, -6], room: 2 }, { pos: [-6, -5], room: 2 },
    ],
    objectives: [
      { text: 'BREACH THE WELL-HOUSE', kind: 'reach', pos: [4, 8], activateRoom: 1 },
      { text: 'CLEAR A FOOTHOLD', kind: 'clear', room: 1, pos: [4, 4], activateRoom: 2 },
      { text: 'HOLD THE WELL', kind: 'defend', pos: [0, -2], holdSecs: 16, reinforceRoom: 2 },
      { text: 'FALL BACK TO EXTRACT', kind: 'reach', pos: [4, -13] },
    ],
  },
  {
    id: 'ash-4', zone: 'ASHFALL', op: 'OPERATION ASHFALL', name: 'SMOKE & ASH', gun: DMR, secondary: SMG,
    story: 'Cinder torched the granary to cover his retreat to the last house. Cut through the smoke and run his rearguard down before he digs in.',
    brief: 'push through the smoke · run the rearguard down',
    start: A_START, walls: A_WALLS, cover: A_COVER,
    enemies: [
      { pos: [-4, 4], room: 1 }, { pos: [4, 5], room: 1 }, { pos: [-1, 3], room: 1 }, { pos: [3.5, 2.5], room: 1 }, { pos: [1, 4], room: 1 },
      { pos: [-5, -4], room: 2 }, { pos: [5, -5], room: 2 }, { pos: [0, -6], room: 2 }, { pos: [-3, -7], room: 2 }, { pos: [4, -2.5], room: 2 }, { pos: [-7, -4], room: 2 },
    ],
    objectives: twoRoom(A_OBJ),
  },
  {
    id: 'ash-5', zone: 'ASHFALL', op: 'OPERATION ASHFALL', name: 'CINDER', gun: AR, story: "Cinder is the one who lit the match. He's holed up in the last house on the row. Put him down and Ashfall is yours.", boss: true,
    brief: 'the man who lit the fire is in that room · put him down',
    start: A3_START, walls: A3_WALLS, cover: A3_COVER,
    enemies: [
      { pos: [-4, 6], room: 1 }, { pos: [4, 5], room: 1 }, { pos: [-2, 3], room: 1 }, { pos: [3, 6], room: 1 },
      { pos: [0, -5], room: 2, hp: 420, boss: true }, { pos: [-5, -3], room: 2 }, { pos: [5, -4], room: 2 }, { pos: [3, -6.5], room: 2 },
    ],
    objectives: twoRoom({ ...A3_OBJ, clear2: 'ELIMINATE CINDER' }),
  },

  // ── Zone 2 · PROVING GROUND (cold evening; boss on op 10) ──
  {
    id: 'pg-1', zone: 'PROVING GROUND', op: 'OPERATION PROVING GROUND', name: 'THE HALL', gun: DMR, story: 'Past the ashes lies the Proving Ground — the compound where Valor trained the crew that burned your home. Take the hall, then the vault.', secondary: SMG,
    brief: 'his crew trained here · take the hall, then the vault',
    start: B_START, walls: B_WALLS, cover: B_COVER,
    enemies: [
      { pos: [-5, 4], room: 1 }, { pos: [5, 3], room: 1 }, { pos: [-2, 0], room: 1 }, { pos: [3, -2], room: 1 }, { pos: [0, 2], room: 1 },
      { pos: [-5, -10], room: 2 }, { pos: [5, -11], room: 2 }, { pos: [0, -13], room: 2 }, { pos: [-3, -15], room: 2 },
    ],
    objectives: twoRoom(B_OBJ),
  },
  {
    id: 'pg-2', zone: 'PROVING GROUND', op: 'OPERATION PROVING GROUND', name: 'THE YARD', gun: AR, secondary: SMG,
    story: 'The training yard sits between the hall and the cells. Clear it fast — the Warden hears gunfire and he starts moving prisoners.',
    brief: 'clear the yard · they know you are coming',
    start: A2_START, walls: A2_WALLS, cover: A2_COVER,
    enemies: [
      { pos: [-5, 6], room: 1 }, { pos: [5, 5], room: 1 }, { pos: [-2, 4], room: 1 }, { pos: [3, 6], room: 1 }, { pos: [0, 3], room: 1 },
      { pos: [-7, -2], room: 2 }, { pos: [6, -4], room: 2 }, { pos: [0, -5], room: 2 }, { pos: [-3, -6], room: 2 }, { pos: [4, -2], room: 2 }, { pos: [2, -6], room: 2 },
    ],
    objectives: twoRoom(A2_OBJ),
  },
  {
    // ── SIGNATURE (rescue) · pull the informant out of the holding cells ──
    id: 'pg-3', zone: 'PROVING GROUND', op: 'OPERATION PROVING GROUND', name: 'THE INFORMANT', gun: SMG, secondary: DMR,
    story: "One of Valor's own wants out, and he knows the way into the Rift. He's held in the back cells. Get to him and walk him out alive.",
    brief: 'reach the informant · escort him to extract · keep him alive',
    start: B_START, walls: B_WALLS, cover: B_COVER,
    hostage: [0, -13],
    enemies: [
      { pos: [-5, 4], room: 1 }, { pos: [5, 3], room: 1 }, { pos: [-2, 0], room: 1 }, { pos: [3, -2], room: 1 },
      { pos: [-5, -10], room: 2 }, { pos: [5, -11], room: 2 }, { pos: [-3, -15], room: 2 }, { pos: [5, -14], room: 2 },
    ],
    objectives: [
      { text: 'BREACH THE BLOCK', kind: 'reach', pos: B_OBJ.breach, activateRoom: 1 },
      { text: 'CLEAR THE HALL', kind: 'clear', room: 1, pos: [B_OBJ.breach[0], B_OBJ.breach[1] - 4] },
      { text: 'PUSH TO THE CELLS', kind: 'reach', pos: B_OBJ.push, activateRoom: 2 },
      { text: 'REACH THE INFORMANT', kind: 'rescue', pos: [0, -13] },
      { text: 'ESCORT HIM TO EXTRACT', kind: 'reach', pos: B_OBJ.extract },
    ],
  },
  {
    id: 'pg-4', zone: 'PROVING GROUND', op: 'OPERATION PROVING GROUND', name: 'THE ARMORY', gun: DMR, secondary: AR,
    story: "The informant's word is good: the armory feeds the whole compound. Burn it and the Warden fights the last round with what he has on him.",
    brief: 'take the armory · cut off his resupply',
    start: A_START, walls: A_WALLS, cover: A_COVER,
    enemies: [
      { pos: [-4, 4], room: 1 }, { pos: [4, 5], room: 1 }, { pos: [-1, 3], room: 1 }, { pos: [3.5, 2.5], room: 1 }, { pos: [1, 4], room: 1 }, { pos: [-6, 3], room: 1 },
      { pos: [-5, -4], room: 2 }, { pos: [5, -5], room: 2 }, { pos: [0, -6], room: 2 }, { pos: [-3, -7], room: 2 }, { pos: [4, -2.5], room: 2 },
    ],
    objectives: twoRoom(A_OBJ),
  },
  {
    id: 'pg-5', zone: 'PROVING GROUND', op: 'OPERATION PROVING GROUND', name: 'THE WARDEN', gun: AR, story: 'The Warden runs the Proving Ground and he will not step aside. Break him and the road to the Rift opens.', boss: true,
    brief: 'the Warden runs this place · he will not step aside',
    start: B_START, walls: B_WALLS, cover: B_COVER,
    enemies: [
      { pos: [-5, 4], room: 1 }, { pos: [5, 3], room: 1 }, { pos: [-2, 1], room: 1 }, { pos: [2, -2], room: 1 }, { pos: [0, 3], room: 1 }, { pos: [-4, -3], room: 1 },
      { pos: [0, -13], room: 2, hp: 520, boss: true }, { pos: [-5, -10], room: 2 }, { pos: [5, -11], room: 2 }, { pos: [-3, -15], room: 2 }, { pos: [5, -14], room: 2 },
    ],
    objectives: twoRoom({ ...B_OBJ, clear2: 'ELIMINATE THE WARDEN' }),
  },

  // ── Zone 3 · THE RIFT (full night, NVG; boss on op 15) ──
  {
    id: 'rift-1', zone: 'THE RIFT', op: 'OPERATION RIFT', name: 'INTO THE DARK', gun: SMG, story: "Valor's channel goes quiet past here. This is the Rift — the dark place he disappears into. Push in and find him.", attachments: ['nvg'],
    brief: 'his channel goes quiet here · push through and find him',
    start: C_START, walls: C_WALLS, cover: C_COVER,
    enemies: [
      { pos: [-4, 2], room: 1 }, { pos: [4, 1], room: 1 }, { pos: [-1, 0], room: 1 }, { pos: [2, -3], room: 1 }, { pos: [-2, 3], room: 1 },
      { pos: [-5, -10], room: 2 }, { pos: [4, -11], room: 2 }, { pos: [0, -13], room: 2 }, { pos: [-2, -9], room: 2 },
    ],
    objectives: twoRoom(C_OBJ),
  },
  {
    id: 'rift-2', zone: 'THE RIFT', op: 'OPERATION RIFT', name: 'DEEPER', gun: SMG, secondary: AR, attachments: ['nvg'],
    story: 'The tunnels open into a drowned hall. Valor is letting you come to him — every step in is a step you will have to fight back out of.',
    brief: 'the hall runs deep · clear it in the dark',
    start: B_START, walls: B_WALLS, cover: B_COVER,
    enemies: [
      { pos: [-5, 4], room: 1 }, { pos: [5, 3], room: 1 }, { pos: [-2, 0], room: 1 }, { pos: [3, -2], room: 1 }, { pos: [0, 2], room: 1 },
      { pos: [-5, -10], room: 2 }, { pos: [5, -11], room: 2 }, { pos: [0, -13], room: 2 }, { pos: [-3, -15], room: 2 }, { pos: [5, -14], room: 2 },
    ],
    objectives: twoRoom(B_OBJ),
  },
  {
    // ── SIGNATURE (blackout) · the Rift kills your NVG; fight by muzzle-flash ──
    id: 'rift-3', zone: 'THE RIFT', op: 'OPERATION RIFT', name: 'LIGHTS OUT', gun: SMG, secondary: AR, blackout: true,
    story: 'Whatever the Rift is, it eats light. Your goggles die at the threshold. There is no seeing your way through this one — only the flash of your own gun.',
    brief: 'NVG is jammed · clear the dark by muzzle-flash alone',
    start: C_START, walls: C_WALLS, cover: C_COVER,
    enemies: [
      { pos: [-4, 2], room: 1 }, { pos: [4, 1], room: 1 }, { pos: [-1, 0], room: 1 }, { pos: [2, -3], room: 1 },
      { pos: [-5, -10], room: 2 }, { pos: [4, -11], room: 2 }, { pos: [0, -13], room: 2 }, { pos: [-2, -9], room: 2 },
    ],
    objectives: twoRoom(C_OBJ),
  },
  {
    id: 'rift-4', zone: 'THE RIFT', op: 'OPERATION RIFT', name: 'THE THRESHOLD', gun: AR, secondary: SMG, attachments: ['nvg'],
    story: 'His guard closes ranks at the last door. Break the threshold and there is nothing left between you and the voice on the radio.',
    brief: 'break his last guard · the door to Valor is beyond',
    start: A2_START, walls: A2_WALLS, cover: A2_COVER,
    enemies: [
      { pos: [-5, 6], room: 1 }, { pos: [5, 5], room: 1 }, { pos: [-2, 4], room: 1 }, { pos: [3, 6], room: 1 }, { pos: [0, 3], room: 1 },
      { pos: [-7, -2], room: 2 }, { pos: [6, -4], room: 2 }, { pos: [0, -5], room: 2 }, { pos: [-3, -6], room: 2 }, { pos: [4, -2], room: 2 }, { pos: [2, -6], room: 2 },
    ],
    objectives: twoRoom(A2_OBJ),
  },
  {
    id: 'rift-valor', zone: 'THE RIFT', op: 'OPERATION RIFT', name: 'VALOR', gun: PROTO, story: 'The voice that has been on your radio the whole way finally has a face and a body. This is the last room. End it.', secondary: AR, attachments: ['nvg'], boss: true,
    brief: 'the voice on your radio has a face · end it',
    start: C_START, walls: C_WALLS, cover: C_COVER,
    enemies: [
      { pos: [-4, 2], room: 1 }, { pos: [4, 1], room: 1 }, { pos: [-1, -1], room: 1 }, { pos: [2, -3], room: 1 },
      { pos: [0, -12], room: 2, hp: 900, boss: true }, { pos: [-5, -9], room: 2 }, { pos: [4, -11], room: 2 }, { pos: [-2, -14], room: 2 },
    ],
    objectives: twoRoom({ ...C_OBJ, clear2: 'KILL VALOR' }),
  },
];

// ── SURVIVAL · an open kill-house; the pool spawns in escalating waves ──
const SURV_WALLS: CoverBox[] = [
  { x: -12, z: 0, w: 0.6, d: 24.6, h: WALL_H }, { x: 12, z: 0, w: 0.6, d: 24.6, h: WALL_H },
  { x: 0, z: 12, w: 24.6, d: 0.6, h: WALL_H }, { x: 0, z: -12, w: 24.6, d: 0.6, h: WALL_H },
];
const SURV_COVER: CoverBox[] = [
  { x: -5, z: 5, w: 1.6, d: 1.6, h: 1.35 }, { x: 5, z: 5, w: 1.6, d: 1.6, h: 1.35 },
  { x: -5, z: -5, w: 1.6, d: 1.6, h: 1.35 }, { x: 5, z: -5, w: 1.6, d: 1.6, h: 1.35 },
  { x: 0, z: 7, w: 2.4, d: 1.0, h: 1.3 }, { x: 0, z: -7, w: 2.4, d: 1.0, h: 1.3 },
  { x: -7.5, z: 0, w: 1.0, d: 2.4, h: 1.4 }, { x: 7.5, z: 0, w: 1.0, d: 2.4, h: 1.4 },
];
// 10 spawn slots around the perimeter (the wave system revives a subset).
const SURV_ENEMIES: EnemySpec[] = Array.from({ length: 10 }, (_, i) => {
  const a = (i / 10) * Math.PI * 2;
  return { pos: [Math.round(Math.sin(a) * 9.4 * 10) / 10, Math.round(Math.cos(a) * 9.4 * 10) / 10] as [number, number], room: 1 };
});

export const SURVIVAL_MISSION: Mission = {
  id: 'survival', zone: 'SURVIVAL', op: 'SURVIVAL', name: 'THE KILL-HOUSE',
  brief: 'hold the room · the waves do not stop · every kill still pays',
  gun: AR, secondary: SMG, survival: true,
  start: [0, 0], walls: SURV_WALLS, cover: SURV_COVER, enemies: SURV_ENEMIES, objectives: [],
};

// 12 spawn slots for the Gauntlet's heavier waves (practice uses 10).
const GAUNTLET_ENEMIES: EnemySpec[] = Array.from({ length: 12 }, (_, i) => {
  const a = (i / 12) * Math.PI * 2;
  return { pos: [Math.round(Math.sin(a) * 9.4 * 10) / 10, Math.round(Math.cos(a) * 9.4 * 10) / 10] as [number, number], room: 1 };
});

// The PRESTIGE tier (B2). Same arena as the Kill-House but a steeper curve, and its
// runs are server-validated onto the seasonal ladder. Unlocked at campaign completion.
export const GAUNTLET_MISSION: Mission = {
  id: 'gauntlet', zone: 'SURVIVAL', op: 'GAUNTLET', name: 'THE GAUNTLET',
  brief: 'ranked · every wave harder · your best run climbs the season board',
  gun: AR, secondary: SMG, survival: true, gauntlet: true,
  start: [0, 0], walls: SURV_WALLS, cover: SURV_COVER, enemies: GAUNTLET_ENEMIES, objectives: [],
};

// ── ENDLESS · the generated room chain ───────────────────────────────────────
// Geometry, enemies and the player's start are all produced at runtime by
// fps/endless.ts, so this mission carries none of them: the scene seeds the chain
// from the run's seed and streams rooms in as the player pushes forward. Both the
// Campaign Endless unlock and the Seasonal Campaign run on this one mission.

// ASHFALL (daylight), deliberately — the Rift's night theme renders the generated
// compound almost pitch black, and a mode people compete in for money has to be
// readable. Endless has no authored set dressing or practicals to light it either.
export const ENDLESS_MISSION: Mission = {
  id: 'endless', zone: 'ASHFALL', op: 'ENDLESS', name: 'NO EXIT',
  brief: 'breach · clear · push forward · it does not end',
  gun: AR, secondary: SMG, endless: true,
  start: [0, -1.5], walls: [], cover: [], enemies: [], objectives: [],
};

/** The Seasonal Campaign: the same chain, but every run starts at wave 1 and the
 *  score goes to the season ladder. Named per season by the page. */
export const SEASONAL_MISSION: Mission = {
  ...ENDLESS_MISSION,
  id: 'seasonal', op: 'SEASONAL CAMPAIGN', name: 'THE CLIMB',
  brief: 'one shot · no resume · your best run takes the season',
};

// ── A1 · the day→evening→night arc ──────────────────────────────────────────
// The three zones set the broad time band by their colour identity (Ashfall warm
// day → Proving Ground cold evening → the Rift full night). Within a zone, each
// successive op steps the light DOWN — the sun dims, fog tightens, tints darken,
// and the practicals relatively rise as daylight fades. Pure data off a mission's
// position in its zone, so it scales as each zone grows toward five ops.
function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
/** Scale a hex colour's brightness by `f` (0..1). */
function darken(hex: string, f: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r * f, g * f, b * f);
}

/** The effective theme for an op: its zone base, dimmed by how deep it sits in the zone. */
export function themeForMission(m: Mission): ZoneTheme {
  const base = ZONE_THEMES[m.zone] ?? ZONE_THEMES.ASHFALL;
  const zoneOps = CAMPAIGN.filter((x) => x.zone === m.zone);
  const k = zoneOps.indexOf(m);
  const n = zoneOps.length;
  const t = n > 1 && k >= 0 ? k / (n - 1) : 0; // 0 at the zone's first op, 1 at its last
  if (t === 0) return base; // brightest op of the zone: leave the tuned anchor untouched
  // A GENTLE within-zone step (the big time-of-day shift lives in the zone anchors,
  // so this must never crush a zone to black by its last op).
  const dim = 1 - t * 0.16; // ≤ -16% key light by the zone's last op
  return {
    ...base,
    bg: darken(base.bg, 1 - t * 0.16),
    fog: [darken(base.fog[0], 1 - t * 0.16), base.fog[1] * (1 - t * 0.1), base.fog[2] * (1 - t * 0.1)],
    hemi: [base.hemi[0], base.hemi[1], base.hemi[2] * (1 - t * 0.12)],
    sun: { color: base.sun.color, intensity: base.sun.intensity * dim },
    fill: { color: base.fill.color, intensity: base.fill.intensity * (1 - t * 0.1) },
    ambient: base.ambient * (1 - t * 0.18),
    practical: base.practical,
    practicalIntensity: base.practicalIntensity * (1 + t * 0.18), // artificial light matters more as day fades
    floorTint: darken(base.floorTint, 1 - t * 0.12),
    wallTint: darken(base.wallTint, 1 - t * 0.12),
    sky: { top: darken(base.sky.top, 1 - t * 0.18), bottom: darken(base.sky.bottom, 1 - t * 0.14) },
  };
}

export const CAMPAIGN_KEY = 'valor_mission';   // the op you're currently on
export const PROGRESS_KEY = 'valor_progress';  // the furthest op you've unlocked (soft gating)
