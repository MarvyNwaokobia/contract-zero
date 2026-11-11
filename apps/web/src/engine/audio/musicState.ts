// What the score is doing, by where the player is.
//
// One score runs for the whole game. A state is a target level for each of its layers
// (the drone, the pulse, the plucked theme, a rising riser); changing state moves the layers
// toward their new targets, swelling in slowly and relaxing quickly, so music is layered
// and crossfaded and never restarted. The fight drives the states from the guards' real
// behaviour; every other screen sets the state for what it is for.

export type MusicState = 'silent' | 'hub' | 'prep' | 'infiltration' | 'detection' | 'combat' | 'boss' | 'extraction' | 'results' | 'table'

export interface Targets { drone: number; pulse: number; motif: number; riser: number }

export const STATE_TARGETS: Record<MusicState, Targets> = {
  silent: { drone: 0, pulse: 0, motif: 0, riser: 0 },
  // headquarters: the bed and a sparse, quiet theme
  hub: { drone: 0.14, pulse: 0, motif: 0.14, riser: 0 },
  // contract preparation: tension in the pulse, no theme yet
  prep: { drone: 0.16, pulse: 0.22, motif: 0, riser: 0 },
  // in and unseen: only the bed
  infiltration: { drone: 0.16, pulse: 0, motif: 0, riser: 0 },
  // spotted: the heartbeat comes in
  detection: { drone: 0.16, pulse: 0.5, motif: 0, riser: 0 },
  // under fire: the theme joins
  combat: { drone: 0.16, pulse: 0.5, motif: 0.42, riser: 0 },
  boss: { drone: 0.18, pulse: 0.6, motif: 0.5, riser: 0 },
  // the countdown: everything, and a riser climbing under it
  extraction: { drone: 0.16, pulse: 0.6, motif: 0.46, riser: 0.35 },
  // after: the pulse drops out, the theme stays softly, and a resolution is sounded on entering
  results: { drone: 0.12, pulse: 0, motif: 0.3, riser: 0 },
  // the war table and the exchange: a slow, watchful pulse and a sparse theme
  table: { drone: 0.12, pulse: 0.1, motif: 0.16, riser: 0 },
}

/** The fight's intensity (0 calm, 1 alerted, 2 under fire, 3 boss) as a state. */
export const stateForIntensity = (level: 0 | 1 | 2 | 3): MusicState => (['infiltration', 'detection', 'combat', 'boss'] as const)[level]

/** What is heard: an override (extraction) wins over the base state (the screen, or the fight's intensity). */
export const effectiveState = (base: MusicState, override: MusicState | null): MusicState => override ?? base

/** States that sound a one-shot when entered. */
export const ENTRY_STINGER: Partial<Record<MusicState, 'resolve'>> = { results: 'resolve' }

/** Whether going from `a` to `b` is a swell in (any layer rising) or only a relaxing, to pick the time constant. */
export function rising(a: MusicState, b: MusicState): boolean {
  const x = STATE_TARGETS[a], y = STATE_TARGETS[b]
  return y.drone > x.drone || y.pulse > x.pulse || y.motif > x.motif || y.riser > x.riser
}
