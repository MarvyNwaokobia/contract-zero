import { describe, it, expect } from 'vitest';
import { FpsSim, FPS_TUNING, slideMove, type CoverBox } from '../FpsSim';
import { CAMPAIGN } from '../campaign';

/**
 * Walls are solid — for ENEMIES as much as for the player.
 *
 * The player already had a fuzz test for this; these are the cases an enemy hits
 * that the player mostly doesn't: an AI walks itself into inside corners and
 * doorway jambs continuously, at a body radius nearly twice the player's, and it
 * gets put back at an authored spawn point every time the op restarts.
 */

const R = FPS_TUNING.ENEMY.BODY_R;

/** Is a body of radius `r` overlapping any box? */
function insideAny(x: number, z: number, boxes: readonly CoverBox[], r: number) {
  return boxes.some((c) => Math.abs(x - c.x) < c.w / 2 + r - 1e-6 && Math.abs(z - c.z) < c.d / 2 + r - 1e-6);
}

describe('enemies cannot enter or pass through geometry', () => {
  it('fuzz: driven into an inside corner, a body never ends up in or through a wall', () => {
    // The corner every room has: a long wall with a divider running off it.
    const wall: CoverBox = { x: 0, z: 0, w: 40, d: 0.6, h: 3 };
    const divider: CoverBox = { x: -4, z: 4, w: 0.6, d: 8, h: 3 };
    let bad = 0;
    for (let trial = 0; trial < 2000; trial++) {
      // Start in the free quadrant north-east of the corner.
      let x = -3.15 + Math.random() * 6;
      let z = 0.85 + Math.random() * 6;
      for (let s = 0; s < 120; s++) {
        [x, z] = slideMove(x, z, x - Math.random() * 0.25, z - Math.random() * 0.25, R, [wall, divider]);
        // Through either slab, or standing in one.
        if (x < -4.85 || z < -0.85 || insideAny(x, z, [wall, divider], 0)) { bad++; break; }
      }
    }
    expect(bad).toBe(0);
  });

  it('fuzz: squeezing through a doorway never puts a body inside a jamb', () => {
    // A 3m doorway, the width the campaign actually authors.
    const left: CoverBox = { x: -6.5, z: 0, w: 7, d: 0.6, h: 3 };
    const right: CoverBox = { x: 6.5, z: 0, w: 7, d: 0.6, h: 3 };
    let bad = 0;
    for (let trial = 0; trial < 2000; trial++) {
      let x = (Math.random() - 0.5) * 10;
      let z = 0.9 + Math.random() * 3;
      for (let s = 0; s < 120; s++) {
        [x, z] = slideMove(x, z, x + (Math.random() - 0.5) * 0.3, z - Math.random() * 0.25, R, [left, right]);
        if (insideAny(x, z, [left, right], 0)) { bad++; break; }
      }
    }
    expect(bad).toBe(0);
  });

  it('a body that is somehow already embedded is freed, not walked through', () => {
    // A bounds clamp or a shove off a corpse can plant a body inside a slab. It
    // must come back OUT — the old failure was drifting on through, because a
    // sweep that starts inside a box reports no hit at all.
    const wall: CoverBox = { x: 0, z: 0, w: 40, d: 0.6, h: 3 };
    for (let trial = 0; trial < 500; trial++) {
      const [x, z] = slideMove(
        (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 0.6,
        R, [wall],
      );
      expect(insideAny(x, z, [wall], 0)).toBe(false);
    }
  });

  it('no campaign enemy ever stands inside the scenery, at spawn or after a restart', () => {
    // A quarter of the authored spawn points sit inside a crate; the sim ejects
    // them on placement. Rooms start DORMANT and a dormant enemy never moves, so
    // if that eject ever regressed they would just stand in the crate all match.
    for (const m of CAMPAIGN) {
      const boxes = [...m.walls, ...m.cover];
      const sim = new FpsSim({ gunId: 'sidearm', enemies: m.enemies, cover: boxes, rng: () => 0.5 });
      for (const e of sim.getEnemies()) {
        expect(insideAny(e.x, e.z, boxes, R), `${m.id} spawn [${e.x}, ${e.z}]`).toBe(false);
      }
      sim.resetEncounter();
      for (const e of sim.getEnemies()) {
        expect(insideAny(e.x, e.z, boxes, R), `${m.id} after reset [${e.x}, ${e.z}]`).toBe(false);
      }
    }
  });
});
