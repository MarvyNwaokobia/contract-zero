import { describe, it, expect } from 'vitest';
import { dressingFor, dressingColliders, propCollider, PROP_CLEAR, PROP_WALL_MIN, PROP_WALL_MAX } from '../setDressing';
import { CAMPAIGN } from '../../fps/campaign';
import { slideMove, FPS_TUNING } from '../../fps';
import type { CoverBox } from '../../fps';

const inBox = (x: number, z: number, b: CoverBox, pad: number) => Math.abs(x - b.x) < b.w / 2 + pad && Math.abs(z - b.z) < b.d / 2 + pad;
const wallDist = (x: number, z: number, walls: CoverBox[]) => {
  let m = Infinity;
  for (const b of walls) {
    const dx = Math.max(Math.abs(x - b.x) - b.w / 2, 0), dz = Math.max(Math.abs(z - b.z) - b.d / 2, 0);
    m = Math.min(m, Math.hypot(dx, dz));
  }
  return m;
};

describe('set dressing is SOLID', () => {
  it('gives barrels, crates and sandbags a footprint, and leaves rubble walkable', () => {
    expect(propCollider({ kind: 'barrels', x: 1, z: 2, rot: 0 })).toMatchObject({ x: 1, z: 2 });
    expect(propCollider({ kind: 'crates', x: 0, z: 0, rot: 0 })).not.toBeNull();
    expect(propCollider({ kind: 'sandbags', x: 0, z: 0, rot: 0 })).not.toBeNull();
    // Ankle-high rubble: being stopped dead by a brick reads as a bug.
    expect(propCollider({ kind: 'debris', x: 0, z: 0, rot: 0 })).toBeNull();
  });

  it('a body cannot walk through a barrel stack', () => {
    const prop = { kind: 'barrels' as const, x: 0, z: 0, rot: 0.7 };
    const boxes = dressingColliders([prop]);
    const R = FPS_TUNING.ENEMY.BODY_R;
    let x = 0, z = 4;
    for (let s = 0; s < 300; s++) [x, z] = slideMove(x, z, x, z - 0.05, R, boxes);
    // Walked straight at it for 15m of travel and it is still on the near side.
    expect(z).toBeGreaterThan(0);
  });

  it('every mission dressing produces colliders the sim can take', () => {
    for (const m of CAMPAIGN) {
      const props = dressingFor(m);
      const boxes = dressingColliders(props);
      expect(boxes.length).toBe(props.filter((p) => p.kind !== 'debris').length);
      for (const b of boxes) {
        expect(b.w).toBeGreaterThan(0);
        expect(b.d).toBeGreaterThan(0);
        expect(b.h).toBeGreaterThan(0);
      }
    }
  });
});

describe('set dressing (A5)', () => {
  it('is deterministic for a given op', () => {
    const a = dressingFor(CAMPAIGN[0]);
    const b = dressingFor(CAMPAIGN[0]);
    expect(a).toEqual(b);
  });

  for (const m of CAMPAIGN) {
    describe(`${m.id}`, () => {
      const props = dressingFor(m);
      const avoid: [number, number][] = [m.start, ...m.enemies.map((e) => e.pos), ...m.objectives.map((o) => o.pos)];
      if (m.hostage) avoid.push(m.hostage);

      it('dresses the op with some clutter', () => {
        expect(props.length).toBeGreaterThan(0);
      });

      it('never places a prop inside a wall or cover block', () => {
        for (const p of props) {
          const hit = [...m.walls, ...m.cover].find((b) => inBox(p.x, p.z, b, 0.5));
          expect(hit, `prop ${p.kind} at [${p.x},${p.z}] overlaps geometry`).toBeUndefined();
        }
      });

      it('keeps every prop clear of enemies, objectives and the start (no hidden targets)', () => {
        for (const p of props) {
          const near = avoid.find(([ax, az]) => Math.hypot(p.x - ax, p.z - az) < PROP_CLEAR);
          expect(near, `prop ${p.kind} at [${p.x},${p.z}] is too close to play at [${near}]`).toBeUndefined();
        }
      });

      it('hugs a wall (not floating in the open, not clipping the wall)', () => {
        for (const p of props) {
          const dw = wallDist(p.x, p.z, m.walls);
          expect(dw).toBeGreaterThanOrEqual(PROP_WALL_MIN);
          expect(dw).toBeLessThanOrEqual(PROP_WALL_MAX);
        }
      });
    });
  }
});
