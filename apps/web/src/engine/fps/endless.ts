/**
 * @module fps/endless
 * @description The endless room chain — the geometry behind Campaign Endless and
 * the Seasonal Campaign.
 *
 * A campaign Mission is a hand-authored compound with a fixed room count and an
 * objective list that ends in "extract". Endless is the same doorkicker gameplay
 * with no end: rooms are GENERATED one after another along -Z, the player pushes
 * forward forever, and the scene appends the next room's geometry while the player
 * is still fighting in the current one. Nothing ever remounts, so a run is one
 * continuous session (no mission list, no menu between waves).
 *
 * A WAVE is a batch of rooms. Batches grow: 2, 2, 3, 3, 4, 4 … so early waves are
 * quick hits and later ones are real pushes.
 *
 * Everything here is DETERMINISTIC from a seed. Two players given the same seed
 * walk the same compound in the same order, which is what makes a season fair:
 * nobody gets an easier draw than anyone else, and the server can replay a claimed
 * run's layout from the seed alone.
 */

import type { CoverBox, EnemySpec } from './FpsSim';

// ── Chain dimensions ───────────────────────────────────────────────────────────
// Room WIDTH is fixed so consecutive rooms' walls line up exactly and no seam can
// open at a junction. Variety comes from depth, cover archetype and enemy layout,
// which is plenty once you are inside one.

/** Interior width of every room, in metres (walls sit outside this). */
export const ROOM_W = 18;
/** Wall thickness. */
export const WALL_T = 0.6;
/** Wall height. */
export const WALL_H = 4;
/** Width of the doorway punched through each dividing wall. */
export const DOOR_W = 3.2;
/** Interior depth range of a generated room. The floor is set well above the
 *  doorway-to-defender standoff so breaching always gives you a beat to read the
 *  room before contact. */
export const ROOM_D_MIN = 14;
export const ROOM_D_MAX = 18;

/** Defenders are held to the FAR half of the room. The player always enters at the
 *  near edge, so this is what guarantees a real standoff on the breach instead of an
 *  enemy standing three metres inside the door. */
const ENEMY_ZONE = 0.5;

/** How far a door can sit from the room's centre line (keeps it out of corners). */
const DOOR_MAX_OFFSET = ROOM_W / 2 - DOOR_W;

// ── Deterministic RNG ──────────────────────────────────────────────────────────

/** mulberry32 — small, fast, well-distributed, and identical across machines.
 *  A run's whole layout is a pure function of its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit seed from a string (season id, wallet, whatever names the run). */
export function seedFromString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ── Wave shape ─────────────────────────────────────────────────────────────────

/** Rooms in wave `w` (1-based): 2, 2, 3, 3, 4, 4 … capped so a late wave stays a
 *  push rather than a slog. */
export function roomsForWave(w: number): number {
  const wave = Math.max(1, Math.floor(w));
  return Math.min(2 + Math.floor((wave - 1) / 2), 6);
}

/** The 0-based index of the FIRST room of wave `w` — the chain position a run
 *  resuming at wave `w` starts from. */
export function firstRoomOfWave(w: number): number {
  let n = 0;
  for (let i = 1; i < Math.max(1, Math.floor(w)); i++) n += roomsForWave(i);
  return n;
}

/** Which 1-based wave room `index` (0-based) belongs to. */
export function waveOfRoom(index: number): number {
  let wave = 1;
  let remaining = index;
  while (remaining >= roomsForWave(wave)) {
    remaining -= roomsForWave(wave);
    wave++;
  }
  return wave;
}

// ── Escalation ─────────────────────────────────────────────────────────────────

/** Defenders in the room at chain position `index` (0-based). Grows slowly and
 *  caps, so difficulty comes from tougher enemies rather than an unfightable mob.
 *
 *  The FIRST room fields 2. It used to open on 3, which is exactly the sim's
 *  MAX_ATTACKERS budget — so every defender in the room could engage at once and the
 *  run's opening seconds were its hardest. Wave 1 is the on-ramp; the curve still
 *  reaches the 8 cap, just a couple of rooms later. */
export function roomEnemyCount(index: number): number {
  return Math.min(2 + Math.ceil(index / 2), 8);
}

/** Enemy health multiplier at chain position `index`. Caps at 3x so a deep run is
 *  demanding but never a bullet sponge wall. */
export function roomEnemyHpMult(index: number): number {
  return Math.min(1 + index * 0.06, 3);
}

// ── Room generation ────────────────────────────────────────────────────────────

export interface GeneratedRoom {
  /** 0-based position in the chain. Also the FpsSim `room` tag, offset by 1 so
   *  room 0 of the chain is sim-room 1 (sim-room 0 means "untagged"). */
  index: number;
  /** 1-based wave this room belongs to. */
  wave: number;
  /** True when this is the last room of its wave — clearing it banks the wave. */
  wavesEnd: boolean;
  /** Solid geometry: side walls plus the far wall with its doorway. */
  walls: CoverBox[];
  /** Interior cover the player and the AI both use. */
  cover: CoverBox[];
  enemies: EnemySpec[];
  /** Z of the doorway the player enters through (the shared wall behind them). */
  zNear: number;
  /** Z of the far wall, i.e. the next room's near edge. */
  zFar: number;
  /** X of the doorway punched through the FAR wall — where the player exits. */
  exitX: number;
  /** A point just inside the far doorway; the "push forward" objective marker. */
  exitPos: [number, number];
}

/** One wall segment spanning x0..x1 at a fixed z. */
function wallSegment(x0: number, x1: number, z: number): CoverBox {
  return { x: (x0 + x1) / 2, z, w: Math.max(0.01, x1 - x0), d: WALL_T, h: WALL_H };
}

/** The five interior cover archetypes. Each fills a room with a different fight:
 *  pillars to slice, a crate line to break sightlines, an L that forces a flank,
 *  a central block you circle, and side alcoves that hide flankers. */
function coverForArchetype(kind: number, zMid: number, depth: number, rng: () => number): CoverBox[] {
  const H = 1.15;          // chest-high: you can shoot over it crouched-up, not through
  const q = depth / 4;
  switch (kind) {
    case 0: // PILLARS — four columns on a loose grid
      return [
        { x: -4.5, z: zMid - q, w: 1.2, d: 1.2, h: WALL_H },
        { x: 4.5, z: zMid - q, w: 1.2, d: 1.2, h: WALL_H },
        { x: -4.5, z: zMid + q, w: 1.2, d: 1.2, h: WALL_H },
        { x: 4.5, z: zMid + q, w: 1.2, d: 1.2, h: WALL_H },
      ];
    case 1: // CRATE LINE — a staggered row across the middle
      return [
        { x: -6, z: zMid, w: 2.4, d: 1.6, h: H },
        { x: -1.5, z: zMid + 1.2, w: 2.4, d: 1.6, h: H },
        { x: 3, z: zMid, w: 2.4, d: 1.6, h: H },
        { x: 6.8, z: zMid - 1.4, w: 1.8, d: 1.6, h: H },
      ];
    case 2: { // L-DIVIDER — a half-wall that makes one side a killzone
      const side = rng() < 0.5 ? -1 : 1;
      return [
        { x: side * 3, z: zMid, w: 7, d: 0.7, h: WALL_H },
        { x: side * 6.4, z: zMid - q, w: 0.7, d: depth / 2.2, h: WALL_H },
        { x: -side * 5, z: zMid + q, w: 2.2, d: 1.6, h: H },
      ];
    }
    case 3: // CENTRE BLOCK — one big obstacle you have to work around
      return [
        { x: 0, z: zMid, w: 5.5, d: 3.5, h: WALL_H },
        { x: -6.5, z: zMid + q, w: 2, d: 1.6, h: H },
        { x: 6.5, z: zMid - q, w: 2, d: 1.6, h: H },
      ];
    default: // ALCOVES — stubs off both side walls, good for hiding defenders
      return [
        { x: -6.6, z: zMid + q, w: 4.2, d: 0.7, h: WALL_H },
        { x: 6.6, z: zMid - q, w: 4.2, d: 0.7, h: WALL_H },
        { x: 0, z: zMid, w: 2.6, d: 1.6, h: H },
      ];
  }
}

/** Is (x, z) clear of every box in `boxes`, with `pad` of breathing room? */
function isClear(x: number, z: number, boxes: CoverBox[], pad = 0.9): boolean {
  for (const b of boxes) {
    if (Math.abs(x - b.x) < b.w / 2 + pad && Math.abs(z - b.z) < b.d / 2 + pad) return false;
  }
  return true;
}

/**
 * Generate the room at chain position `index`, entered at z = `zNear` and
 * extending toward -Z. Pure: same (index, zNear, seed) always gives the same room.
 */
export function generateRoom(index: number, zNear: number, seed: number): GeneratedRoom {
  // Each room gets its own RNG stream keyed off the run seed and its position, so
  // generating room 40 never depends on having generated rooms 0-39 first. That is
  // what lets a resumed run drop straight in at wave 12 with the right layout.
  const rng = mulberry32((seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0);

  const depth = ROOM_D_MIN + Math.floor(rng() * (ROOM_D_MAX - ROOM_D_MIN + 1));
  const zFar = zNear - depth;
  const zMid = (zNear + zFar) / 2;

  const exitX = Math.round((rng() * 2 - 1) * DOOR_MAX_OFFSET * 10) / 10;

  const halfW = ROOM_W / 2;
  const outer = halfW + WALL_T;

  // Side walls run EXACTLY the room's depth, so consecutive rooms meet flush at the
  // junction rather than overlapping. They used to extend a wall-thickness past each
  // end to "seal" the corners, which made every neighbouring pair share a 1.2m stretch
  // of identical coplanar surface — two walls fighting for the same pixels, which reads
  // in-game as the building shaking. The far wall is perpendicular and thick enough to
  // close the corner on its own.
  const walls: CoverBox[] = [
    { x: -(halfW + WALL_T / 2), z: zMid, w: WALL_T, d: depth, h: WALL_H },
    { x: halfW + WALL_T / 2, z: zMid, w: WALL_T, d: depth, h: WALL_H },
    // Far wall, split around the exit doorway. This doubles as the NEXT room's
    // near wall, which is why every room only ever authors its far side.
    wallSegment(-outer, exitX - DOOR_W / 2, zFar),
    wallSegment(exitX + DOOR_W / 2, outer, zFar),
  ];

  const cover = coverForArchetype(Math.floor(rng() * 5), zMid, depth, rng);

  // Defenders are confined to the FAR half of the room. The player always breaches at
  // the near edge, so this is what buys them a beat to read the space before contact
  // — without it a defender can be standing three metres inside the door and the room
  // opens as an ambush rather than a breach.
  const blockers = [...walls, ...cover];
  const count = roomEnemyCount(index);
  const hp = Math.max(1, Math.round(100 * roomEnemyHpMult(index)));
  const enemies: EnemySpec[] = [];
  const zLo = zFar + 1.5;                    // just off the far wall
  const zHi = zFar + depth * ENEMY_ZONE;     // no closer than half-way in
  for (let i = 0; i < count; i++) {
    let x = 0;
    let z = 0;
    // Rejection-sample a spot clear of geometry. The sim ejects anything still
    // buried, so a few tries is enough; this just keeps placements looking placed.
    for (let attempt = 0; attempt < 24; attempt++) {
      x = (rng() * 2 - 1) * (halfW - 1.8);
      z = zLo + rng() * (zHi - zLo);
      if (isClear(x, z, blockers)) break;
    }
    enemies.push({ pos: [x, z], hp, room: index + 1 });
  }

  const wave = waveOfRoom(index);
  const wavesEnd = waveOfRoom(index + 1) !== wave;

  return {
    index,
    wave,
    wavesEnd,
    walls,
    cover,
    enemies,
    zNear,
    zFar,
    exitX,
    exitPos: [exitX, zFar - 1.5],
  };
}

/** The cap sealing the very first room's entry side, so a run can't walk backwards
 *  out of the compound. Punched with no door: the chain only goes forward. */
export function entryCap(zNear: number): CoverBox[] {
  const outer = ROOM_W / 2 + WALL_T;
  // Sits FLUSH against the side walls, which end exactly at zNear. Offsetting it by a
  // full wall thickness (as it was) left a WALL_T/2 slit at both corners of the very
  // first room — a thin vertical strip of daylight either side of the entrance.
  return [{ x: 0, z: zNear + WALL_T / 2, w: outer * 2, d: WALL_T, h: WALL_H }];
}

/** Where the player stands when a run (or a resume) begins in the room at `zNear`. */
export function spawnPointFor(zNear: number): [number, number] {
  return [0, zNear - 1.5];
}

/** Z the chain starts at. Rooms extend toward -Z from here. */
export const CHAIN_START_Z = 0;

/**
 * Build the chain from room `from` (0-based, inclusive) for `count` rooms, starting
 * at `startZ`. Used to lay the opening rooms of a run and to extend it as the player
 * pushes forward.
 */
export function buildChain(from: number, count: number, startZ: number, seed: number): GeneratedRoom[] {
  const rooms: GeneratedRoom[] = [];
  let z = startZ;
  for (let i = 0; i < count; i++) {
    const room = generateRoom(from + i, z, seed);
    rooms.push(room);
    z = room.zFar;
  }
  return rooms;
}

/**
 * The Z a run resuming at `wave` starts from. Room depths vary, so the only honest
 * way to get there is to walk the chain forward from the origin. Cheap (a few
 * hundred iterations at most) and deterministic.
 */
export function zForWaveStart(wave: number, seed: number): number {
  const target = firstRoomOfWave(wave);
  let z = CHAIN_START_Z;
  for (let i = 0; i < target; i++) z = generateRoom(i, z, seed).zFar;
  return z;
}
