// What the space around the listener does to sound. Indoors and outdoors are told from the
// level's own geometry: an `art` roof is an enclosed area. Reverb is a decaying-noise
// impulse response, generated deterministically so it is testable and identical every run.

import type { Art } from '../fps/levels'

/** Whether (x, z) is under a roof. `margin` lets the doorway count as inside a little early. */
export function isIndoors(art: readonly Art[] | null | undefined, x: number, z: number, margin = 0): boolean {
  if (!art) return false
  for (const a of art) {
    if (a.kind !== 'roof') continue
    const hw = (a.w ?? 0) / 2 + margin, hd = (a.d ?? 0) / 2 + margin
    if (Math.abs(x - a.x) <= hw && Math.abs(z - a.z) <= hd) return true
  }
  return false
}

export interface SpaceMix { indoorWet: number; outdoorWet: number }
/** Reverb send levels per space: indoors a dense short room; outdoors a faint long slap off the walls. */
export function spaceMix(indoors: boolean): SpaceMix {
  return indoors ? { indoorWet: 0.34, outdoorWet: 0 } : { indoorWet: 0, outdoorWet: 0.12 }
}

/** A small, fast deterministic generator (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

export interface IrSpec { seconds: number; decay: number; /** Sparse discrete echoes instead of a dense tail (open ground). */ sparse?: boolean; seed: number }
export const INDOOR_IR: IrSpec = { seconds: 0.7, decay: 4.2, seed: 11 }
export const OUTDOOR_IR: IrSpec = { seconds: 1.6, decay: 2.4, sparse: true, seed: 23 }

/** One channel of impulse response: noise under an exponential decay, or a handful of echoes. */
export function impulseResponse(sampleRate: number, spec: IrSpec, channel = 0): Float32Array {
  const n = Math.max(1, Math.floor(sampleRate * spec.seconds))
  const out = new Float32Array(n)
  const r = rng(spec.seed + channel * 101)
  if (spec.sparse) {
    // open ground: a few distinct reflections off far walls, each thinning out
    const echoes = 5
    for (let e = 0; e < echoes; e++) {
      const at = Math.floor(n * (0.08 + (e / echoes) * 0.85 + r() * 0.04))
      const amp = (1 - e / echoes) * 0.8
      for (let i = 0; i < 480 && at + i < n; i++) out[at + i] += (r() * 2 - 1) * amp * Math.exp(-i / 90)
    }
    return out
  }
  for (let i = 0; i < n; i++) out[i] = (r() * 2 - 1) * Math.exp((-spec.decay * i) / n)
  return out
}
