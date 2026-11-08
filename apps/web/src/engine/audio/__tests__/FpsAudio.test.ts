import { describe, it, expect } from 'vitest';
import { shotShape, zoneAmbience } from '../FpsAudio';
import { GUN_FEEL } from '../../combat/GunFeel';
import { ZONE_THEMES } from '../../fps/campaign';

// A3: per-weapon fire shaping + per-zone ambience. The audio graph itself needs
// WebAudio, but the SHAPING math is pure — this pins the per-weapon distinction.
describe('per-weapon shot shaping', () => {
  const smg = shotShape(GUN_FEEL.smg.audio);
  const ar = shotShape(GUN_FEEL.assault_rifle.audio);
  const dmr = shotShape(GUN_FEEL.marksman.audio);
  const pistol = shotShape(GUN_FEEL.sidearm.audio);

  it('snappier guns pitch UP and stay brighter than boomy guns', () => {
    // marksman is the BOOM (low cutoff), smg the snappy spitter (high cutoff)
    expect(smg.rate).toBeGreaterThan(ar.rate);
    expect(ar.rate).toBeGreaterThan(dmr.rate);
    expect(smg.toneHz).toBeGreaterThan(dmr.toneHz);   // brighter top end
    expect(pistol.rate).toBeGreaterThan(dmr.rate);
  });

  it('louder profiles drive a louder shot, and rate stays in a sane band', () => {
    expect(dmr.gain).toBeGreaterThan(smg.gain);       // marksman vol 0.8 > smg 0.4
    for (const id of Object.keys(GUN_FEEL) as (keyof typeof GUN_FEEL)[]) {
      const s = shotShape(GUN_FEEL[id].audio);
      expect(s.rate).toBeGreaterThanOrEqual(0.72);
      expect(s.rate).toBeLessThanOrEqual(1.3);
    }
  });
});

describe('per-zone ambience', () => {
  it('every campaign zone (plus Survival) has an ambience bed', () => {
    for (const zone of Object.keys(ZONE_THEMES)) {
      const amb = zoneAmbience(zone);
      expect(amb.vol).toBeGreaterThan(0);
      expect(amb.lp).toBeGreaterThan(0);
    }
  });

  it('the Rift is darker (lower room tone) than Ashfall and hums with a drone', () => {
    expect(zoneAmbience('THE RIFT').lp).toBeLessThan(zoneAmbience('ASHFALL').lp);
    expect(zoneAmbience('THE RIFT').drone).toBeGreaterThan(0);
    expect(zoneAmbience('ASHFALL').drone).toBeUndefined();
  });

  it('an unknown zone falls back to the Ashfall bed', () => {
    expect(zoneAmbience('NOWHERE')).toEqual(zoneAmbience('ASHFALL'));
  });
});
