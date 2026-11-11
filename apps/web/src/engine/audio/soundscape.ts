// The sounds of a site, placed where the things that make them stand.
//
// Emitters are read from the level's own geometry: a truck is an idling engine, a server is
// a hum, a steam vent is a hiss, a pump is a pulse. Which ones you hear is decided by how
// near they are, and what lies between you and them (real walls, and roofs) muffles them.
// Only the nearest few are voiced at once, so a site is never all-ambience-at-full-volume.
//
// This file is the pure model (emitters, selection, occlusion, scheduling). The runtime that
// turns it into WebAudio is `SoundscapeRunner` below.

import type { Art, Box, LevelDef } from '../fps/levels'
import { isIndoors } from './acoustics'
import { spatialize } from './spatial'

export type EmitterKind =
  | 'engine' | 'server' | 'lamp' | 'stack' | 'pump' | 'tank'       // continuous: held while you are near
  | 'steam' | 'camera' | 'radar' | 'clank' | 'chime' | 'boom'     // periodic: a one-shot every so often

export interface Emitter { id: string; kind: EmitterKind; x: number; z: number }

export interface EmitterSpec {
  continuous: boolean
  /** Beyond this many metres it is silent and not voiced. */
  range: number
  /** Loudness at the source, before distance. Everything here is a bed, so all are quiet. */
  gain: number
  /** Periodic only: seconds between one-shots, [min, max]. */
  every?: [number, number]
}

export const SPEC: Record<EmitterKind, EmitterSpec> = {
  engine: { continuous: true, range: 24, gain: 0.5 },
  server: { continuous: true, range: 14, gain: 0.45 },
  lamp: { continuous: true, range: 10, gain: 0.25 },
  stack: { continuous: true, range: 60, gain: 0.55 },
  pump: { continuous: true, range: 26, gain: 0.5 },
  tank: { continuous: true, range: 22, gain: 0.35 },
  steam: { continuous: false, range: 34, gain: 0.5, every: [5, 11] },
  camera: { continuous: false, range: 18, gain: 0.35, every: [6, 12] },
  radar: { continuous: false, range: 40, gain: 0.3, every: [3.5, 4.5] },
  clank: { continuous: false, range: 60, gain: 0.55, every: [9, 20] },
  chime: { continuous: false, range: 40, gain: 0.45, every: [55, 95] },
  boom: { continuous: false, range: 400, gain: 0.5, every: [18, 42] },
}

/** Voices held at once. */
export const MAX_CONTINUOUS = 6

const BOX_KIND: Partial<Record<Box['kind'], EmitterKind>> = { truck: 'engine', server: 'server', pump: 'pump', tank: 'tank' }
const ART_KIND: Partial<Record<Art['kind'], EmitterKind>> = { lamp: 'lamp', light_pole: 'lamp', floodlight: 'lamp', stack: 'stack', steam: 'steam', camera: 'camera', radar: 'radar' }
/** At most this many of one kind, so a level with many lamps does not become a field of hums. */
const CAP_PER_KIND = 6

/** What a level sounds like, from what is in it. */
export function emittersFor(level: LevelDef): Emitter[] {
  const out: Emitter[] = []
  const count: Partial<Record<EmitterKind, number>> = {}
  const add = (kind: EmitterKind, x: number, z: number) => {
    if ((count[kind] ?? 0) >= CAP_PER_KIND) return
    count[kind] = (count[kind] ?? 0) + 1
    out.push({ id: `${kind}-${count[kind]}`, kind, x, z })
  }
  for (const b of [...level.walls, ...level.cover]) { const k = BOX_KIND[b.kind]; if (k) add(k, b.x, b.z) }
  for (const a of level.art) { const k = ART_KIND[a.kind]; if (k) add(k, a.x, a.z) }
  // Site-wide events that do not come from one object:
  const b = level.bounds
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2
  if (level.id === 'dustline_depot') add('boom', cx + 220, cz - 160)                         // distant artillery, off to one side
  if (level.id === 'blacksite') for (const e of out.filter((e) => e.kind === 'lamp').slice(0, 3)) add('chime', e.x, e.z)  // the PA, from the ceiling lamps' positions
  if (level.id === 'cinder_yard') { add('clank', b.minX + 6, b.minZ + 6); add('clank', b.maxX - 6, b.minZ + 10) }          // heavy machinery at the far corners
  return out
}

const dist = (e: Emitter, x: number, z: number) => Math.hypot(e.x - x, e.z - z)

/** The nearest `k` continuous emitters within their own range, nearest first. */
export function nearestContinuous(emitters: readonly Emitter[], x: number, z: number, k = MAX_CONTINUOUS): Emitter[] {
  return emitters
    .filter((e) => SPEC[e.kind].continuous && dist(e, x, z) <= SPEC[e.kind].range)
    .sort((a, b) => dist(a, x, z) - dist(b, x, z))
    .slice(0, k)
}

// ── Occlusion ────────────────────────────────────────────────────────────────

/** Whether the segment (ax,az)-(bx,bz) crosses an axis-aligned box (slab test). */
export function segmentHitsBox(ax: number, az: number, bx: number, bz: number, box: { x: number; z: number; w: number; d: number }): boolean {
  const minX = box.x - box.w / 2, maxX = box.x + box.w / 2, minZ = box.z - box.d / 2, maxZ = box.z + box.d / 2
  let t0 = 0, t1 = 1
  const dx = bx - ax, dz = bz - az
  for (const [p, q] of [[-dx, ax - minX], [dx, maxX - ax], [-dz, az - minZ], [dz, maxZ - az]] as const) {
    if (p === 0) { if (q < 0) return false; continue }
    const r = q / p
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r } else { if (r < t0) return false; if (r < t1) t1 = r }
  }
  return true
}

export interface Occlusion {
  /** Walls (and roof edges) between source and listener. */
  blocked: number
  /** 0..1 multiplier on loudness. */
  gain: number
  /** Cap on the lowpass cutoff, Hz: walls take the highs first. */
  lowpass: number
}

/** What stands between a source and the listener: real walls, and a roof edge if one of them is
 *  under a roof and the other is not. Walls too low to matter (under 1.5 m) are ignored. */
export function occlusion(level: Pick<LevelDef, 'walls' | 'art'>, lx: number, lz: number, sx: number, sz: number): Occlusion {
  let blocked = 0
  for (const w of level.walls) if ((w.h ?? 3) >= 1.5 && segmentHitsBox(lx, lz, sx, sz, w)) blocked++
  if (isIndoors(level.art, lx, lz, 0.5) !== isIndoors(level.art, sx, sz, 0.5)) blocked++
  const n = Math.min(4, blocked)
  // each wall takes about a quarter of the loudness (never all of it: bass leaks through walls)
  return { blocked, gain: Math.max(0.15, 1 - 0.27 * n), lowpass: n === 0 ? 18000 : Math.max(450, 2600 / (1 + n)) }
}

/** What a continuous emitter does at the listener's position: loudness, pan and brightness. */
export function mixFor(level: LevelDef, e: Emitter, lx: number, lz: number, yaw: number): { gain: number; pan: number; lowpass: number; blocked: number } {
  const sp = spatialize(lx, lz, yaw, e.x, e.z)
  const d = dist(e, lx, lz)
  const range = SPEC[e.kind].range
  // fade to nothing at the edge of its range so voices never pop in or out
  const edge = d >= range ? 0 : Math.min(1, (range - d) / (range * 0.25))
  const occ = occlusion(level, lx, lz, e.x, e.z)
  return { gain: SPEC[e.kind].gain * sp.gain * occ.gain * edge, pan: sp.pan, lowpass: Math.min(sp.lowpass, occ.lowpass), blocked: occ.blocked }
}

/** When the next one-shot of a periodic kind is due, given a uniform random in [0,1). */
export const nextDelay = (kind: EmitterKind, r: number): number => {
  const [lo, hi] = SPEC[kind].every ?? [10, 10]
  return lo + (hi - lo) * r
}
