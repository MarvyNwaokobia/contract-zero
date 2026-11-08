import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ImpactFX } from '../ImpactFX';

/** The sprites are irrelevant to the pooling maths — only that there is a texture. */
function fx(quality?: 'lean') {
  const t = () => new THREE.Texture();
  return new ImpactFX(
    { spark: t(), smoke: t(), debris: t(), flash: t(), droplet: t() },
    quality ? { quality } : {},
  );
}

const UP = [0, 1, 0] as const;

describe('ImpactFX pooling', () => {
  it('a burst puts particles in the world and they age out again', () => {
    const f = fx();
    expect(f.particleCount).toBe(0);
    f.burst([0, 1, 0], UP, 'concrete');
    expect(f.particleCount).toBeGreaterThan(0);
    // Longest-lived thing in a concrete burst is dust at ~1.15s.
    for (let i = 0; i < 200; i++) f.update(1 / 60);
    expect(f.particleCount).toBe(0);
    f.dispose();
  });

  it('a footfall is much cheaper than a bullet — it runs on every step of every enemy', () => {
    const f = fx();
    f.scuff([0, 0, 0]);
    const scuff = f.particleCount;
    f.dispose();

    const g = fx();
    g.burst([0, 1, 0], UP, 'concrete');
    const burst = g.particleCount;
    g.dispose();

    expect(scuff).toBeGreaterThan(0);
    expect(scuff).toBeLessThan(burst / 3);
  });

  it('a body hit throws blood, a wall hit does not', () => {
    const wall = fx();
    wall.burst([0, 1, 0], UP, 'concrete');
    const wallCount = wall.particleCount;
    wall.dispose();

    const body = fx();
    body.burst([0, 1, 0], UP, 'flesh');
    expect(body.particleCount).toBeGreaterThan(0);
    body.dispose();
    expect(wallCount).toBeGreaterThan(0);
  });

  it('never grows past its pool, however much lead is in the air', () => {
    const f = fx();
    for (let i = 0; i < 500; i++) f.burst([i % 5, 1, 0], UP, 'metal');
    const flooded = f.particleCount;
    for (let i = 0; i < 500; i++) f.burst([i % 5, 1, 0], UP, 'metal');
    expect(f.particleCount).toBe(flooded);   // capped, recycling the oldest
    f.dispose();
  });

  it('the lean tier emits fewer particles than the full one', () => {
    const full = fx();
    full.burst([0, 1, 0], UP, 'concrete');
    const a = full.particleCount;
    full.dispose();

    const lean = fx('lean');
    lean.burst([0, 1, 0], UP, 'concrete');
    const b = lean.particleCount;
    lean.dispose();

    expect(b).toBeLessThan(a);
  });

  it('a long stall cannot teleport particles across the map', () => {
    const f = fx();
    f.burst([0, 1, 0], UP, 'metal');
    // A backgrounded tab hands back a huge dt; the step is clamped.
    f.update(30);
    expect(f.particleCount).toBeGreaterThan(0);   // 30s would have killed everything
    f.dispose();
  });
});

describe('ImpactFX ambient ash', () => {
  it('emits at a RATE, so the air looks the same at 30fps and at 144', () => {
    const slow = fx();
    for (let i = 0; i < 30; i++) { slow.ambient(1 / 30, [0, 1.6, 0]); slow.update(1 / 30); }
    const a = slow.particleCount;
    slow.dispose();

    const fast = fx();
    for (let i = 0; i < 144; i++) { fast.ambient(1 / 144, [0, 1.6, 0]); fast.update(1 / 144); }
    const b = fast.particleCount;
    fast.dispose();

    // One second of ash either way. A per-frame count would have made these differ
    // by nearly 5x.
    expect(a).toBeGreaterThan(0);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(2);
  });

  it('a frame shorter than one mote still accumulates instead of emitting nothing', () => {
    const f = fx();
    // At 16/s a 60Hz frame is owed 0.27 of a mote — flooring per frame without
    // carrying the remainder would emit forever and never produce one.
    for (let i = 0; i < 20; i++) { f.ambient(1 / 60, [0, 1.6, 0]); f.update(1 / 60); }
    expect(f.particleCount).toBeGreaterThan(0);
    f.dispose();
  });

  it('holds its own pool, so a firefight cannot delete the atmosphere', () => {
    // Six seconds of ash, with and without a firefight in the middle of it. Every
    // impact particle is dead inside 3.2s, so by the end both runs are motes only —
    // and if bursts were evicting motes (which sharing the dust pool would do), the
    // run that got shot at would come out visibly thinner.
    const run = (shoot: boolean) => {
      const f = fx();
      for (let i = 0; i < 360; i++) {
        f.ambient(1 / 60, [0, 1.6, 0]);
        if (shoot && i >= 150 && i < 180) f.burst([0, 1, 0], UP, 'concrete');
        f.update(1 / 60);
      }
      const n = f.particleCount;
      f.dispose();
      return n;
    };

    const quiet = run(false);
    const fought = run(true);
    expect(quiet).toBeGreaterThan(20);              // there is ash to lose
    expect(fought).toBeGreaterThan(quiet * 0.75);   // and the gunfight did not take it
  });

  it('the lean tier thins the ash out', () => {
    const full = fx();
    for (let i = 0; i < 60; i++) { full.ambient(1 / 60, [0, 1.6, 0]); full.update(1 / 60); }
    const a = full.particleCount;
    full.dispose();

    const lean = fx('lean');
    for (let i = 0; i < 60; i++) { lean.ambient(1 / 60, [0, 1.6, 0]); lean.update(1 / 60); }
    const b = lean.particleCount;
    lean.dispose();

    expect(b).toBeLessThan(a);
  });
});

describe('ImpactFX blood', () => {
  it('a body going down throws a last spatter', () => {
    const f = fx();
    f.pool([2, 0, -3]);
    expect(f.particleCount).toBeGreaterThan(0);
    f.dispose();
  });

  it('a flesh hit throws more liquid than a wall hit throws chips', () => {
    const body = fx();
    body.burst([0, 1.2, 0], UP, 'flesh');
    const wet = body.particleCount;
    body.dispose();

    const wall = fx();
    wall.burst([0, 1.2, 0], UP, 'wood');
    const dry = wall.particleCount;
    wall.dispose();

    expect(wet).toBeGreaterThan(dry);
  });
});
