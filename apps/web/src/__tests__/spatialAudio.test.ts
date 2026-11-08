import { describe, it, expect } from 'vitest';
import { spatialize, combatIntensity } from '@/engine/audio/spatial';

/**
 * Slice 2 (CLONE_PLAN.md): the informational half of the audio grammar.
 * Listener yaw convention matches BattleCamera: forward = (-sin yaw, -cos yaw),
 * so yaw 0 faces -z and +x is the right ear.
 */

describe('spatialize', () => {
  it('pans a source on the right to the right ear', () => {
    const s = spatialize(0, 0, 0, 5, 0);
    expect(s.pan).toBeGreaterThan(0.8);
  });

  it('pans a source on the left to the left ear', () => {
    const s = spatialize(0, 0, 0, -5, 0);
    expect(s.pan).toBeLessThan(-0.8);
  });

  it('keeps a dead-ahead source centred and bright', () => {
    const s = spatialize(0, 0, 0, 0, -5);
    expect(Math.abs(s.pan)).toBeLessThan(0.01);
    expect(s.lowpass).toBeGreaterThan(10000);
  });

  it('muffles a source directly behind (the stereo "behind you" cue)', () => {
    const ahead = spatialize(0, 0, 0, 0, -5);
    const behind = spatialize(0, 0, 0, 0, 5);
    expect(behind.lowpass).toBeLessThan(ahead.lowpass * 0.4);
    expect(Math.abs(behind.pan)).toBeLessThan(0.01); // still centred, just dark
  });

  it('attenuates with distance: half loudness at 9m, silent past 45m', () => {
    expect(spatialize(0, 0, 0, 0, -9).gain).toBeCloseTo(0.5, 5);
    expect(spatialize(0, 0, 0, 0, -50).gain).toBe(0);
  });

  it('respects listener yaw: facing +x puts a +x source dead ahead', () => {
    // forward = (-sin, -cos); yaw = -π/2 → forward (1, 0).
    const s = spatialize(0, 0, -Math.PI / 2, 5, 0);
    expect(Math.abs(s.pan)).toBeLessThan(0.01);
    expect(s.lowpass).toBeGreaterThan(10000);
  });

  it('a source on top of the listener is centred at full volume', () => {
    const s = spatialize(3, 3, 1.2, 3.1, 3);
    expect(s.pan).toBe(0);
    expect(s.gain).toBe(1);
  });
});

describe('combatIntensity', () => {
  it('is calm when nothing is near and nothing happened', () => {
    expect(combatIntensity(null, 100)).toBe(0);
    expect(combatIntensity(30, 100)).toBe(0);
  });

  it('engages when an enemy is close', () => {
    expect(combatIntensity(10, 100)).toBe(1);
  });

  it('goes to combat when close AND trading hits', () => {
    expect(combatIntensity(10, 1)).toBe(2);
  });

  it('recent hits at range still read as engaged', () => {
    expect(combatIntensity(30, 1)).toBe(1);
    expect(combatIntensity(null, 1)).toBe(1);
  });
});
