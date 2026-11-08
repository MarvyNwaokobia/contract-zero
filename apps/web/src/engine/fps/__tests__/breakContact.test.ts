import { describe, it, expect } from 'vitest';
import { FpsSim, FPS_TUNING, type CoverBox, type FpsInput, type Vec3 } from '../FpsSim';

/**
 * You can hide.
 *
 * Enemies used to be omniscient. `e.facing` and the maneuver goal were both taken
 * from the player's LIVE position every frame, whether or not there was any line of
 * sight, so breaking cover stopped them SHOOTING and nothing else: they still turned
 * to face you through a wall and walked straight to where you actually were. Cover
 * was a bullet shield and never a way to disappear.
 *
 * Now each enemy acts on the last place it SAW you, and that memory goes stale.
 * These pin the three states that fall out of it — eyes on, hunting, given up — and
 * the two transitions between them.
 */

const E = FPS_TUNING.ENEMY;

/** A tall slab: wide enough to hide behind, high enough to break an eye line. */
const WALL: CoverBox = { x: 0, z: 0, w: 14, d: 0.6, h: 3 };

/** Enemy posted south of the wall, player starts north of it in the open. */
function sim(): FpsSim {
  const s = new FpsSim({
    enemies: [{ pos: [0, -6], room: 1 }],
    cover: [WALL],
    respawnEnabled: false,
  });
  return s;
}

function inputAt(x: number, z: number, crouched = false): FpsInput {
  return {
    firing: false,
    wantReload: false,
    origin: [x, crouched ? 1.02 : 1.6, z] as Vec3,
    dir: [0, 0, -1] as Vec3,
    adsFactor: 0,
    moving: false,
    crouched,
  };
}

function stand(s: FpsSim, x: number, z: number, secs: number, crouched = false) {
  const input = inputAt(x, z, crouched);
  const steps = Math.round(secs * 60);
  for (let i = 0; i < steps; i++) s.step(1 / 60, input);
}

const only = (s: FpsSim) => s.getEnemies()[0];

/** Where the enemy is heading, relative to a point. */
const distTo = (s: FpsSim, x: number, z: number) => Math.hypot(only(s).x - x, only(s).z - z);

describe('breaking line of sight', () => {
  it('with eyes on you, what it believes IS the truth, refreshed every frame', () => {
    const s = sim();
    // Same side of the wall, in the open: clear sightline.
    stand(s, 0, -14, 4);
    const e = only(s);
    expect(e.seenAt).toBeGreaterThan(0);
    expect(Math.hypot(e.seenX - 0, e.seenZ - -14)).toBeLessThan(0.01);

    // Walk somewhere else, still in the open, and the belief follows.
    stand(s, 7, -15, 2);
    expect(Math.hypot(only(s).seenX - 7, only(s).seenZ - -15)).toBeLessThan(0.01);
  });

  it('with eyes on you it maneuvers to its preferred fighting range', () => {
    // Posted 8m out, it should work OUT to about PREFERRED_DIST rather than sit
    // still — the eyes-on branch is the one that keeps combat distance.
    const s = sim();
    stand(s, 0, -14, 8);
    const gap = Math.hypot(only(s).x - 0, only(s).z - -14);
    expect(Math.abs(gap - E.PREFERRED_DIST)).toBeLessThan(6);
  });

  it('once you are behind cover it hunts the LAST place it saw you, not you', () => {
    const s = sim();
    stand(s, 6, -14, 3);          // seen, out in the open
    const seenAt: [number, number] = [only(s).seenX, only(s).seenZ];
    expect(Math.hypot(seenAt[0] - 6, seenAt[1] - -14)).toBeLessThan(0.01);

    // Duck behind the slab, well away from where it last had you.
    stand(s, -6, 5, 2);

    const e = only(s);
    // Its memory did NOT update to the new position...
    expect(Math.hypot(e.seenX - -6, e.seenZ - 5)).toBeGreaterThan(5);
    // ...and it is closing on the stale one instead of on the player.
    expect(distTo(s, seenAt[0], seenAt[1])).toBeLessThan(distTo(s, -6, 5));
  });

  it('it faces where it believes you are, not through the wall at you', () => {
    const s = sim();
    stand(s, 8, -12, 3);
    stand(s, -8, 6, 2);           // gone, the other side and the other way

    const e = only(s);
    const atBelief = Math.atan2(e.seenX - e.x, e.seenZ - e.z);
    const atPlayer = Math.atan2(-8 - e.x, 6 - e.z);
    const wrapped = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
    expect(Math.abs(wrapped(e.facing - atBelief))).toBeLessThan(0.01);
    expect(Math.abs(wrapped(e.facing - atPlayer))).toBeGreaterThan(0.5);
  });

  it('it gives up after SEARCH_SECS and goes back to its post', () => {
    const s = sim();
    stand(s, 0, -14, 3);           // contact
    const post: [number, number] = [0, -6];

    // Hide, and stay hidden past the search window.
    stand(s, -6, 8, E.SEARCH_SECS + 6);

    expect(distTo(s, post[0], post[1])).toBeLessThan(1.2);
  });

  it('one glimpse re-acquires you, however long it had been searching', () => {
    const s = sim();
    stand(s, 0, -14, 3);
    stand(s, -6, 8, E.SEARCH_SECS + 4);   // it has given up
    expect(only(s).seenAt).toBeLessThan(s.snapshot().time - E.SEARCH_SECS);

    stand(s, 0, -12, 1);                  // step back into the open
    const e = only(s);
    expect(Math.hypot(e.seenX - 0, e.seenZ - -12)).toBeLessThan(0.01);
  });

  it('a hidden player is never shot at', () => {
    const s = sim();
    stand(s, 0, -14, 2);
    let shots = 0;
    const input = inputAt(-6, 8);
    for (let i = 0; i < 60 * 10; i++) {
      for (const ev of s.step(1 / 60, input)) if (ev.kind === 'enemyFire') shots++;
    }
    expect(shots).toBe(0);
  });
});

describe('crouching', () => {
  it('drops the eye line, which is what lets low cover hide you', () => {
    // A crate you can see over standing but not crouched.
    const crate: CoverBox = { x: 0, z: 0, w: 8, d: 1, h: 1.3 };
    const build = () => new FpsSim({ enemies: [{ pos: [0, -5], room: 1 }], cover: [crate], respawnEnabled: false });

    // Standing right behind it, eyes at 1.6 clear the 1.3 crate against a 1.5 eye.
    const up = build();
    stand(up, 0, 2, 3, false);
    const upSeen = Math.hypot(up.getEnemies()[0].seenX - 0, up.getEnemies()[0].seenZ - 2);

    // Crouched, the eye drops to 1.02 and the crate cuts the line.
    const down = build();
    stand(down, 0, 2, 3, true);
    const downSeen = Math.hypot(down.getEnemies()[0].seenX - 0, down.getEnemies()[0].seenZ - 2);

    expect(upSeen).toBeLessThan(0.01);      // standing: seen
    expect(downSeen).toBeGreaterThan(0.5);  // crouched: never acquired at that spot
  });

  it('tightens the cone, so hiding is not the only reason to use it', () => {
    const s = sim();
    expect(s.spreadFor(0, false, true)).toBeLessThan(s.spreadFor(0, false, false));
  });
});

describe('a room that wakes without ever seeing you still fights', () => {
  it('defenders woken by a breach know roughly where you came in', () => {
    // The regression this guards: `hunting` keys off having had contact, so an
    // enemy that comes online never having seen anyone would be born already given
    // up and walk back to the post it is standing on. A whole survival wave would
    // spawn and ignore the player.
    const s = new FpsSim({
      enemies: [{ pos: [0, -6], room: 1 }],
      cover: [WALL],
      respawnEnabled: false,
    });
    s.setAllActive(false);
    // Stood off past ROOM_ENTRY_REACH, or walking in would wake the room by itself
    // (see roomWake.test.ts) and this would be testing that instead.
    stand(s, 0, -18, 0.2);
    expect(only(s).active).toBe(false);

    s.setRoomActive(1, true);      // woken by the objective flow, having seen nobody
    stand(s, 0, -18, 0.5);
    const e = only(s);
    expect(e.seenAt).toBeGreaterThan(0);
    expect(Math.hypot(e.seenX - 0, e.seenZ - -18)).toBeLessThan(1.5);
  });

  it('enemies spawned already-active engage instead of standing on their spawn', () => {
    // Survival/endless waves come in with active: true and no sighting.
    const s = new FpsSim({ enemies: [{ pos: [0, -30], room: 1 }], cover: [], respawnEnabled: false });
    const start = Math.hypot(only(s).x - 0, only(s).z - 0);   // 30m out, well past engage range
    stand(s, 0, 0, 8);
    const now = Math.hypot(only(s).x - 0, only(s).z - 0);
    expect(only(s).seenAt).toBeGreaterThan(0);
    expect(now).toBeLessThan(start - 5);   // it advanced, rather than holding its post
  });
});
