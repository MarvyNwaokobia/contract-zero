import type { GunId } from './GunStats';

/**
 * Per-gun FEEL profiles — the presentation half of GunStats.
 *
 * GunStats owns the numbers the sim resolves (damage, cadence, accuracy);
 * this table owns how each weapon reads to the senses: what the shot sounds
 * like, how thick the tracer is, how hard the muzzle light pops, how much the
 * body and camera kick. Every gun should feel like a different machine even
 * before the player reads a single stat. New guns get a row here alongside
 * their GUN_CATALOG entry.
 */

export interface GunShotAudio {
  noiseDur: number; // seconds of the crack noise burst
  hpFreq: number;   // highpass cutoff on the crack — higher = lighter/snappier
  bodyF0: number;   // body punch start frequency (Hz)
  bodyF1: number;   // body punch end frequency (Hz)
  bodyDur: number;  // seconds of the body punch
  vol: number;      // overall loudness 0..1
  thump?: boolean;  // extra sub-bass thump (the big guns)
}

export interface GunFeelProfile {
  kick: number;           // 0..1 procedural recoil pulse on the rig per shot
  camShake: number;       // camera shake intensity on the local player's own fire
  camPunch: number;       // camera punch-in on the local player's own fire
  beamScale: number;      // tracer thickness multiplier
  flashScale: number;     // muzzle flash size multiplier
  lightIntensity: number; // muzzle point-light peak intensity
  audio: GunShotAudio;
}

const SEASONAL_FEEL: Record<'ashfall_carbine' | 'warden_repeater' | 'rift_lance' | 'seraph_lmg' | 'ember_halo', GunFeelProfile> = {
  // Carbine: quick and light, a shade fuller than the SMG.
  ashfall_carbine: {
    kick: 0.3, camShake: 0.026, camPunch: 0.011,
    beamScale: 1.0, flashScale: 1.0, lightIntensity: 7,
    audio: { noiseDur: 0.045, hpFreq: 1500, bodyF0: 210, bodyF1: 100, bodyDur: 0.06, vol: 0.48 },
  },
  // Battle rifle: heavy, deliberate, real shoulder shove.
  warden_repeater: {
    kick: 0.72, camShake: 0.055, camPunch: 0.026,
    beamScale: 1.3, flashScale: 1.3, lightIntensity: 10,
    audio: { noiseDur: 0.09, hpFreq: 820, bodyF0: 150, bodyF1: 55, bodyDur: 0.13, vol: 0.72 },
  },
  // Energy DMR: a tight electric snap rather than a bang.
  rift_lance: {
    kick: 0.6, camShake: 0.048, camPunch: 0.03,
    beamScale: 1.7, flashScale: 1.5, lightIntensity: 14,
    audio: { noiseDur: 0.07, hpFreq: 2400, bodyF0: 320, bodyF1: 90, bodyDur: 0.16, vol: 0.66 },
  },
  // LMG: relentless low chatter, more rumble than crack.
  seraph_lmg: {
    kick: 0.34, camShake: 0.042, camPunch: 0.013,
    beamScale: 1.2, flashScale: 1.25, lightIntensity: 9,
    audio: { noiseDur: 0.05, hpFreq: 950, bodyF0: 160, bodyF1: 70, bodyDur: 0.07, vol: 0.55 },
  },
  // Exotic: bright, fast, unmistakable.
  ember_halo: {
    kick: 0.42, camShake: 0.04, camPunch: 0.02,
    beamScale: 1.45, flashScale: 1.5, lightIntensity: 15,
    audio: { noiseDur: 0.06, hpFreq: 1900, bodyF0: 260, bodyF1: 95, bodyDur: 0.1, vol: 0.62 },
  },
};

export const GUN_FEEL: Record<GunId, GunFeelProfile> = {
  ...SEASONAL_FEEL,
  // Service pistol: clean, medium crack. The baseline everything is tuned against.
  sidearm: {
    kick: 0.35, camShake: 0.03, camPunch: 0.012,
    beamScale: 1, flashScale: 1, lightIntensity: 6,
    audio: { noiseDur: 0.06, hpFreq: 1100, bodyF0: 180, bodyF1: 70, bodyDur: 0.08, vol: 0.55 },
  },
  // SMG: light, snappy chatter — quiet per shot because it fires 10/s.
  smg: {
    kick: 0.18, camShake: 0.018, camPunch: 0.007,
    beamScale: 0.8, flashScale: 0.8, lightIntensity: 5,
    audio: { noiseDur: 0.04, hpFreq: 1700, bodyF0: 220, bodyF1: 110, bodyDur: 0.05, vol: 0.4 },
  },
  // AR: fuller, lower crack with real body.
  assault_rifle: {
    kick: 0.45, camShake: 0.035, camPunch: 0.015,
    beamScale: 1.15, flashScale: 1.15, lightIntensity: 8,
    audio: { noiseDur: 0.07, hpFreq: 900, bodyF0: 160, bodyF1: 60, bodyDur: 0.09, vol: 0.6 },
  },
  // Marksman: the BOOM. Long low crack, sub-thump, big flash, hard kick.
  marksman: {
    kick: 1, camShake: 0.06, camPunch: 0.03,
    beamScale: 1.6, flashScale: 1.7, lightIntensity: 14,
    audio: { noiseDur: 0.12, hpFreq: 500, bodyF0: 120, bodyF1: 42, bodyDur: 0.16, vol: 0.8, thump: true },
  },
  // Prototype: zappy energy signature — bright crack, high sweep, glowing tracer.
  legendary: {
    kick: 0.4, camShake: 0.03, camPunch: 0.013,
    beamScale: 1.3, flashScale: 1.25, lightIntensity: 10,
    audio: { noiseDur: 0.06, hpFreq: 1400, bodyF0: 320, bodyF1: 90, bodyDur: 0.07, vol: 0.6 },
  },
};
