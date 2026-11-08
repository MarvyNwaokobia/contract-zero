/**
 * @module scene/setDressing
 * @description Set-dressing placement (A5) — pure so it's testable without three.
 *
 * Scatters believable clutter (barrels / crates / sandbags / rubble) that HUGS the
 * compound walls, deterministic per layout, kept clear of every enemy / objective
 * / the start so it can never hide a target from the player.
 *
 * Props are SOLID: `propCollider` gives each one a footprint, and the scene feeds
 * those to the sim alongside the walls and cover. They used to be pure decoration
 * that nothing collided with, which is what let people and enemies walk through a
 * stack of barrels as if it were fog.
 *
 * The debris scatter is the exception and stays walk-through: it is ankle-high
 * rubble, and being stopped dead by a brick reads as a bug, not as cover.
 */
import type { Mission } from '../fps/campaign';
import type { CoverBox } from '../fps';

export type PropKind = 'barrels' | 'crates' | 'sandbags' | 'debris';
export interface PropSpec { kind: PropKind; x: number; z: number; rot: number; }

/** Clearance kept between a prop and any enemy / objective / the player start. */
export const PROP_CLEAR = 2.4;
/** A prop sits this far off the nearest wall face (hug the wall, don't clip it). */
export const PROP_WALL_MIN = 0.55;
export const PROP_WALL_MAX = 1.35;

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS: PropKind[] = ['barrels', 'crates', 'sandbags', 'debris'];

export function dressingFor(mission: Mission): PropSpec[] {
  const rng = mulberry(hashStr(mission.id));
  const solids = [...mission.walls, ...mission.cover];
  const avoid: [number, number][] = [mission.start, ...mission.enemies.map((e) => e.pos), ...mission.objectives.map((o) => o.pos)];
  if (mission.hostage) avoid.push(mission.hostage);
  const inBox = (x: number, z: number, b: CoverBox, pad: number) => Math.abs(x - b.x) < b.w / 2 + pad && Math.abs(z - b.z) < b.d / 2 + pad;
  const wallDist = (x: number, z: number) => {
    let m = Infinity;
    for (const b of mission.walls) {
      const dx = Math.max(Math.abs(x - b.x) - b.w / 2, 0), dz = Math.max(Math.abs(z - b.z) - b.d / 2, 0);
      m = Math.min(m, Math.hypot(dx, dz));
    }
    return m;
  };
  const props: PropSpec[] = [];
  for (let tries = 0; tries < 220 && props.length < 11; tries++) {
    const x = (rng() * 2 - 1) * 9.2, z = -16 + rng() * 33;
    if (solids.some((b) => inBox(x, z, b, 0.5))) continue;                 // not inside geometry
    const dw = wallDist(x, z);
    if (dw < PROP_WALL_MIN || dw > PROP_WALL_MAX) continue;                // hug a wall, don't clip it
    if (avoid.some(([ax, az]) => Math.hypot(x - ax, z - az) < PROP_CLEAR)) continue; // clear of the play space
    if (props.some((p) => Math.hypot(x - p.x, z - p.z) < 1.7)) continue;   // spacing
    props.push({ kind: KINDS[(rng() * KINDS.length) | 0], x, z, rot: rng() * Math.PI * 2 });
  }
  return props;
}

/**
 * The footprint a prop blocks, or null if you should be able to walk over it.
 *
 * Square, and sized to the prop's widest span rather than its exact silhouette,
 * because CoverBox is axis-aligned and every prop is placed at a random yaw — a
 * tight box would poke out of the mesh at 45°. A shade generous is the right error
 * here: brushing to a stop just before a barrel reads fine, clipping into one does
 * not. Heights are the real ones, so a crate you can shoot over still stops a body.
 */
export function propCollider(p: PropSpec): CoverBox | null {
  switch (p.kind) {
    // Three 0.56-wide barrels spread over a ~0.6 cluster.
    case 'barrels': return { x: p.x, z: p.z, w: 1.15, d: 1.15, h: 0.9 };
    // A 0.66 crate with a smaller one stacked on it.
    case 'crates': return { x: p.x, z: p.z, w: 0.95, d: 0.95, h: 1.05 };
    // A row of bags about 1.1 across and two courses high. Square like the rest,
    // not 1.1 x 0.5: the row is laid at a random yaw, and an oblong axis-aligned
    // box would be plain wrong half the time.
    case 'sandbags': return { x: p.x, z: p.z, w: 1.1, d: 1.1, h: 0.68 };
    // Rubble: ankle height. You step over it.
    case 'debris': return null;
  }
}

/** Every solid footprint in a mission's dressing, ready to hand to the sim. */
export function dressingColliders(props: readonly PropSpec[]): CoverBox[] {
  return props.map(propCollider).filter((c): c is CoverBox => c !== null);
}
