import { describe, it, expect } from 'vitest';
import { setCover, regenerateCover, resolveCover, losHit } from '../engine/sim/Cover';

const CENTER = { x: 0, z: 0, hx: 1, hz: 1, height: 1.7 };

describe('Cover geometry (explicit layout)', () => {
  it('blocks a sightline that crosses a piece', () => {
    setCover([CENTER]);
    const hit = losHit(-3, 0, 3, 0);
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeLessThan(0); // enters at the near (−x) face
    expect(Math.abs(hit!.z)).toBeLessThan(1e-6);
  });

  it('clears a sightline that misses every piece', () => {
    setCover([CENTER]);
    expect(losHit(-3, 5, 3, 5)).toBeNull();
  });

  it('does not block a shot that flies over a short piece', () => {
    setCover([{ ...CENTER, height: 0.8 }]); // shorter than the shot height
    expect(losHit(-3, 0, 3, 0, 1.05)).toBeNull();
  });

  it('ejects a fighter standing inside a piece', () => {
    setCover([CENTER]);
    const [x, z] = resolveCover(0, 0, 0.5);
    const stillInside = Math.abs(x) <= CENTER.hx && Math.abs(z) <= CENTER.hz;
    expect(stillInside).toBe(false);
  });

  it('leaves a fighter clear of cover untouched', () => {
    setCover([CENTER]);
    const [x, z] = resolveCover(5, 5, 0.5);
    expect(x).toBeCloseTo(5);
    expect(z).toBeCloseTo(5);
  });
});

describe('Cover generator', () => {
  it('is 180°-symmetric and keeps clear of both spawns', () => {
    const layout = regenerateCover(12345);
    expect(layout.length).toBeGreaterThan(0);

    // Every piece has a mirror partner of equal size (rotational symmetry).
    for (const p of layout) {
      const mirror = layout.find(
        (q) => Math.abs(q.x + p.x) < 1e-6 && Math.abs(q.z + p.z) < 1e-6 && Math.abs(q.hx - p.hx) < 1e-6,
      );
      expect(mirror).toBeTruthy();
    }

    // No piece intrudes on a spawn point (±5, 0).
    for (const p of layout) {
      for (const sx of [-5, 5]) {
        const clearance = Math.hypot(p.x - sx, p.z) - Math.max(p.hx, p.hz);
        expect(clearance).toBeGreaterThanOrEqual(2.4 - 1e-6);
      }
    }
  });

  it('is reproducible from a seed', () => {
    expect(regenerateCover(777)).toEqual(regenerateCover(777));
  });
});
