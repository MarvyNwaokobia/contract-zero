/**
 * Arena cover — the obstacle layout that turns the stat-duel into a positional
 * gunfight. Lives in the sim (not the renderer) so collision + line-of-sight are
 * authoritative and headless-testable, exactly like the rest of CombatSim.
 *
 * Two layers share the same math:
 *   COVER        — procedurally generated debris INSIDE the combat zone. The
 *                  renderer dresses these (CoverProps), so what you see is what
 *                  blocks you.
 *   STATIC_COVER — environment colliders (village walls, chimneys, trees) that
 *                  the arena renders itself. Registered by the mission stage;
 *                  empty for plain arena stages. Blocks movement, LOS and the
 *                  roam-phase player exactly like COVER.
 *
 * Every box does two jobs:
 *   1. Blocks movement (fighters can't walk through it) — circle-vs-box push-out.
 *   2. Blocks line of sight (a shot through a piece is absorbed) — segment-vs-box.
 * Boxes may be yaw-rotated (village walls are); the tests run in the box's local
 * frame so rotated and axis-aligned pieces share one code path.
 *
 * Debris layouts are procedurally generated with 180° rotational symmetry around
 * the ZONE CENTRE (so neither fighter is advantaged) and vary in piece count,
 * size, shape and height. Missions move the zone (fights happen where you FIND
 * the enemy), so generation takes an optional zone {centre, radius, clear points}.
 */
export interface CoverBox {
  x: number;
  z: number;
  hx: number; // half-extent on local X
  hz: number; // half-extent on local Z
  height: number; // top Y; a shot is blocked if it passes through the footprint
  yaw?: number; // rotation around Y (world radians); undefined/0 = axis-aligned
}

/** The combat zone a debris layout is generated for. */
export interface CoverZone {
  cx: number;
  cz: number;
  radius: number;
  /** Points that must stay clear of debris (fighter start positions). */
  clear: [number, number][];
}

const DEFAULT_ZONE: CoverZone = { cx: 0, cz: 0, radius: 11, clear: [[-5, 0], [5, 0]] };

// ── Seeded PRNG (splitmix32) so layouts are reproducible from a seed ──
function splitmix32(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x9e3779b9 | 0;
    let t = seed ^ seed >>> 16; t = Math.imul(t, 0x21f0aaad);
    t = t ^ t >>> 15; t = Math.imul(t, 0x735a2d97);
    return ((t = t ^ t >>> 15) >>> 0) / 4294967296;
  };
}

const SPAWN_CLEAR = 2.4;   // no cover within this radius of a clear point
const PIECE_MARGIN = 1.2;  // min gap between any two pieces
const ARENA_INSET = 1.0;   // keep pieces this far from the zone edge

interface PieceTemplate {
  hxRange: [number, number];
  hzRange: [number, number];
  heightRange: [number, number];
}

const TEMPLATES: PieceTemplate[] = [
  // Tall thin pillar
  { hxRange: [0.35, 0.55], hzRange: [0.35, 0.55], heightRange: [1.6, 2.2] },
  // Low wide wall (long on Z)
  { hxRange: [0.3, 0.5],   hzRange: [1.0, 1.8],   heightRange: [0.85, 1.1] },
  // Low wide wall (long on X)
  { hxRange: [1.0, 1.8],   hzRange: [0.3, 0.5],   heightRange: [0.85, 1.1] },
  // Medium barrier
  { hxRange: [0.5, 0.9],   hzRange: [0.5, 0.9],   heightRange: [1.2, 1.6] },
  // Tall narrow wall (long on Z)
  { hxRange: [0.25, 0.4],  hzRange: [1.2, 2.0],   heightRange: [1.4, 1.8] },
  // Tall narrow wall (long on X)
  { hxRange: [1.2, 2.0],   hzRange: [0.25, 0.4],  heightRange: [1.4, 1.8] },
  // Squat wide block
  { hxRange: [0.7, 1.2],   hzRange: [0.7, 1.2],   heightRange: [0.7, 1.0] },
];

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

function boxesOverlap(a: CoverBox, b: CoverBox, margin: number): boolean {
  return Math.abs(a.x - b.x) < a.hx + b.hx + margin &&
         Math.abs(a.z - b.z) < a.hz + b.hz + margin;
}

// Cheap conservative check against environment boxes (circle vs circle) so
// generated debris never merges into a village wall.
function overlapsStatic(box: CoverBox): boolean {
  const r = Math.max(box.hx, box.hz);
  for (const s of STATIC_COVER) {
    const sr = Math.hypot(s.hx, s.hz);
    if (Math.hypot(box.x - s.x, box.z - s.z) < r + sr + 0.9) return true;
  }
  return false;
}

function tooCloseToClear(box: CoverBox, zone: CoverZone): boolean {
  for (const [sx, sz] of zone.clear) {
    const dist = Math.hypot(box.x - sx, box.z - sz);
    if (dist - Math.max(box.hx, box.hz) < SPAWN_CLEAR) return true;
  }
  return false;
}

function outsideZone(box: CoverBox, zone: CoverZone): boolean {
  const corners = [
    [box.x - box.hx, box.z - box.hz],
    [box.x + box.hx, box.z - box.hz],
    [box.x - box.hx, box.z + box.hz],
    [box.x + box.hx, box.z + box.hz],
  ];
  const rMax = zone.radius - ARENA_INSET;
  return corners.some(([cx, cz]) => {
    const dx = cx - zone.cx, dz = cz - zone.cz;
    return dx * dx + dz * dz > rMax * rMax;
  });
}

function generateLayout(seed: number, zone: CoverZone): CoverBox[] {
  const rand = splitmix32(seed);
  const pieces: CoverBox[] = [];

  // Piece budget scales with zone size — a road skirmish (r≈6) gets a tighter
  // layout than the full village square (r≈11).
  const sizeScale = zone.radius / DEFAULT_ZONE.radius;

  // Optionally place a centre piece (~40% chance) — sits on the duel line.
  if (rand() < 0.4) {
    const t = TEMPLATES[Math.floor(rand() * TEMPLATES.length)];
    const box: CoverBox = {
      x: zone.cx,
      z: zone.cz,
      hx: lerp(t.hxRange[0], t.hxRange[1], rand()),
      hz: lerp(t.hzRange[0], t.hzRange[1], rand()),
      height: lerp(t.heightRange[0], t.heightRange[1], rand()),
    };
    if (!tooCloseToClear(box, zone) && !overlapsStatic(box)) pieces.push(box);
  }

  // Place symmetric pairs — enough to break sightlines without cluttering.
  const pairCount = Math.max(2, Math.round((3 + Math.floor(rand() * 3)) * sizeScale));
  let attempts = 0;
  let placed = 0;

  while (placed < pairCount && attempts < 300) {
    attempts++;
    const t = TEMPLATES[Math.floor(rand() * TEMPLATES.length)];
    const hx = lerp(t.hxRange[0], t.hxRange[1], rand());
    const hz = lerp(t.hzRange[0], t.hzRange[1], rand());
    const height = lerp(t.heightRange[0], t.heightRange[1], rand());

    // Spread evenly through the combat zone (no outer-rim bias) so cover lands in
    // the mid-field where fighters actually engage — close enough to use, not at
    // the walls. Stay just off the spawns so the opening isn't point-blank.
    const angle = rand() * Math.PI * 2;
    const minDist = 1.5;
    const maxDist = zone.radius - ARENA_INSET;
    const dist = minDist + rand() * (maxDist - minDist);
    const x = zone.cx + Math.cos(angle) * dist;
    const z = zone.cz + Math.sin(angle) * dist;

    const a: CoverBox = { x, z, hx, hz, height };
    const b: CoverBox = { x: zone.cx * 2 - x, z: zone.cz * 2 - z, hx, hz, height };

    if (outsideZone(a, zone) || outsideZone(b, zone)) continue;
    if (tooCloseToClear(a, zone) || tooCloseToClear(b, zone)) continue;
    if (overlapsStatic(a) || overlapsStatic(b)) continue;

    let overlaps = false;
    for (const p of pieces) {
      if (boxesOverlap(a, p, PIECE_MARGIN) || boxesOverlap(b, p, PIECE_MARGIN)) {
        overlaps = true;
        break;
      }
    }
    // Also check the pair against each other (if they're near the origin).
    if (!overlaps && boxesOverlap(a, b, PIECE_MARGIN)) overlaps = true;
    if (overlaps) continue;

    pieces.push(a);
    // Don't double-add if the mirror is nearly the same piece (centre-ish).
    if (Math.abs(x - zone.cx) > 0.3 || Math.abs(z - zone.cz) > 0.3) pieces.push(b);
    placed++;
  }

  return pieces;
}

// ── Module-level layouts ──────────────────────────────────────────────────────
// STATIC_COVER must initialize FIRST: generateLayout consults it (overlapsStatic)
// and the COVER initializer below runs at import time.

/** Environment colliders (village walls etc.) — registered by the stage. */
export let STATIC_COVER: CoverBox[] = [];

/** Dressed debris inside the active combat zone — regenerated per encounter. */
export let COVER: CoverBox[] = generateLayout(Date.now(), DEFAULT_ZONE);

export function regenerateCover(seed?: number, zone?: CoverZone): CoverBox[] {
  COVER = generateLayout(seed ?? Date.now(), zone ?? DEFAULT_ZONE);
  return COVER;
}

/** Replace the active debris layout outright — for deterministic matches and tests. */
export function setCover(boxes: CoverBox[]): void {
  COVER = boxes;
}

/** Register/clear the stage's environment colliders (empty for arena stages). */
export function setStaticCover(boxes: CoverBox[]): void {
  STATIC_COVER = boxes;
}

// Shots travel between muzzle (~1.4m) and torso (~1.05m); for v1 any box that is
// taller than this and crossed by the sightline in XZ blocks the shot.
const SHOT_HEIGHT = 1.05;

// World→local: rotate a point into the box frame (box centre at origin).
// Matches the THREE rotateY convention the renderer uses to place these walls:
// local→world is  wx = cos(yaw)*lx + sin(yaw)*lz,  wz = -sin(yaw)*lx + cos(yaw)*lz.
function toLocal(box: CoverBox, px: number, pz: number): [number, number] {
  const yaw = box.yaw ?? 0;
  const dx = px - box.x, dz = pz - box.z;
  if (yaw === 0) return [dx, dz];
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [c * dx - s * dz, s * dx + c * dz];
}

/**
 * Push a circle (a fighter) out of every box it overlaps — debris AND static
 * environment. Returns the corrected [x, z]. Handles the centre-inside case by
 * ejecting along the shallowest axis. Rotated boxes resolve in their local frame.
 */
export function resolveCover(px: number, pz: number, radius: number): [number, number] {
  for (const list of [COVER, STATIC_COVER]) {
    for (const c of list) {
      const yaw = c.yaw ?? 0;
      const [lx, lz] = toLocal(c, px, pz);
      const cx = Math.max(-c.hx, Math.min(lx, c.hx));
      const cz = Math.max(-c.hz, Math.min(lz, c.hz));
      let dx = lx - cx, dz = lz - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > radius * radius) continue;

      // Local-frame push-out…
      let pushX: number, pushZ: number;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        const push = radius - d;
        pushX = (dx / d) * push;
        pushZ = (dz / d) * push;
      } else {
        // Centre is inside the box — eject along the nearest face.
        const toRight = c.hx - lx, toLeft = lx + c.hx;
        const toFar = c.hz - lz, toNear = lz + c.hz;
        const m = Math.min(toRight, toLeft, toFar, toNear);
        pushX = 0; pushZ = 0;
        if (m === toRight) pushX = toRight + radius;
        else if (m === toLeft) pushX = -(toLeft + radius);
        else if (m === toFar) pushZ = toFar + radius;
        else pushZ = -(toNear + radius);
      }
      // …rotated back into world (local→world, THREE rotateY convention).
      if (yaw === 0) {
        px += pushX; pz += pushZ;
      } else {
        const cy = Math.cos(yaw), sy = Math.sin(yaw);
        px += cy * pushX + sy * pushZ;
        pz += -sy * pushX + cy * pushZ;
      }
    }
  }
  return [px, pz];
}

/**
 * Line-of-sight test in XZ against debris AND static environment. Returns the
 * closest point where the segment a→b first enters a box (where a blocked shot
 * should spark), or null if the sightline is clear. Slab method in each box's
 * local frame; tracks the nearest entry across all pieces.
 */
export function losHit(
  ax: number, az: number,
  bx: number, bz: number,
  shotHeight: number = SHOT_HEIGHT,
): { x: number; z: number } | null {
  const dxW = bx - ax, dzW = bz - az;
  let bestT = Infinity;

  for (const list of [COVER, STATIC_COVER]) {
    for (const c of list) {
      if (c.height < shotHeight) continue; // too low to block this shot
      const [lax, laz] = toLocal(c, ax, az);
      const [lbx, lbz] = toLocal(c, bx, bz);
      const dx = lbx - lax, dz = lbz - laz;
      let t0 = 0, t1 = 1;

      if (Math.abs(dx) < 1e-9) {
        if (lax < -c.hx || lax > c.hx) continue;
      } else {
        let ta = (-c.hx - lax) / dx, tb = (c.hx - lax) / dx;
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      }
      if (Math.abs(dz) < 1e-9) {
        if (laz < -c.hz || laz > c.hz) continue;
      } else {
        let ta = (-c.hz - laz) / dz, tb = (c.hz - laz) / dz;
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      }

      if (t0 <= t1 && t1 >= 0 && t0 <= 1 && t0 < bestT) {
        bestT = t0;
      }
    }
  }
  // Entry point is frame-independent: same t along the world segment.
  return bestT === Infinity ? null : { x: ax + dxW * bestT, z: az + dzW * bestT };
}
