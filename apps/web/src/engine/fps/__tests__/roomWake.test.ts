import { describe, it, expect } from 'vitest';
import { FpsSim, FPS_TUNING, type FpsInput, type Vec3 } from '../FpsSim';
import { CAMPAIGN } from '../campaign';

/**
 * A room defends itself the moment you walk into it.
 *
 * Rooms start dormant so the whole compound doesn't open up on you from across
 * the map at spawn, and the objective flow wakes each one as you breach it. But
 * the objective CURSOR only advances when the previous objective completes, so on
 * a two-room op the wake for room 2 sat behind "clear room 1": you could run past
 * the front room mid-firefight, stand in the middle of five defenders, and every
 * one of them would keep facing the wall until you had killed everybody behind
 * you. These pin that shut — entering is what wakes a room, not the objective
 * you happen to be on.
 */

const mission = CAMPAIGN[0];

function sim(): FpsSim {
  const s = new FpsSim({
    enemies: mission.enemies,
    cover: [...mission.walls, ...mission.cover],
    respawnEnabled: false,
  });
  s.setAllActive(false);
  return s;
}

function inputAt(pos: [number, number]): FpsInput {
  return {
    firing: false,
    wantReload: false,
    origin: [pos[0], 1.65, pos[1]] as Vec3,
    dir: [0, 0, -1] as Vec3,
    adsFactor: 0,
    moving: true,
    crouched: false,
  };
}

/** Run the sim for `secs` with the player parked at `pos`. */
function stand(s: FpsSim, pos: [number, number], secs = 1) {
  const input = inputAt(pos);
  for (let i = 0; i < Math.round(secs * 60); i++) s.step(1 / 60, input);
}

function activeIn(s: FpsSim, room: number): number {
  let n = 0;
  for (const e of s.getEnemies()) if (e.alive && e.room === room && e.active) n++;
  return n;
}

/** Where a room's defenders are posted, averaged. */
function roomCentre(room: number): [number, number] {
  const posts = mission.enemies.filter((e) => (e.room ?? 0) === room).map((e) => e.pos);
  const x = posts.reduce((a, p) => a + p[0], 0) / posts.length;
  const z = posts.reduce((a, p) => a + p[1], 0) / posts.length;
  return [x, z];
}

describe('walking into a room wakes it', () => {
  it('room 2 comes alive when you enter it, with room 1 still full of live enemies', () => {
    const s = sim();
    s.setRoomActive(1, true);        // you breached the front room; room 2 untouched
    expect(activeIn(s, 2)).toBe(0);
    expect(s.roomAlive(1)).toBeGreaterThan(0); // nobody has been killed

    stand(s, roomCentre(2), 1);

    expect(activeIn(s, 2)).toBe(s.roomAlive(2));
    expect(s.roomAlive(1)).toBeGreaterThan(0); // and it did NOT need room 1 cleared
  });

  it('a woken room shoots back — dormancy was the only thing stopping it', () => {
    const s = sim();
    s.setRoomActive(1, true);
    // Long enough to clear the wake stagger and a telegraph.
    stand(s, roomCentre(2), 6);
    const fired = s.getEnemies().some((e) => e.room === 2 && e.ai !== 'hidden');
    expect(fired).toBe(true);
  });

  it('the room you have not reached yet stays asleep', () => {
    // The whole point of dormancy: standing in the front room must not open up
    // the objective room from the other side of the divider.
    const s = sim();
    s.setRoomActive(1, true);
    stand(s, roomCentre(1), 1);
    expect(activeIn(s, 2)).toBe(0);
  });

  it('a room that chases you does not keep the next one asleep', () => {
    // Room territory has to be read off the POSTS the defenders were placed on,
    // not off where they have run to. Room 1's enemies maneuver toward the player,
    // so a centroid taken from live positions would follow you into room 2 and
    // room 2 would never register as the room you are standing in.
    const s = sim();
    s.setRoomActive(1, true);
    stand(s, roomCentre(1), 4);          // let room 1 close on the player first
    stand(s, roomCentre(2), 1);
    expect(activeIn(s, 2)).toBe(s.roomAlive(2));
  });

  it('once awake a room stays awake when you push past it', () => {
    const s = sim();
    s.setRoomActive(1, true);
    stand(s, roomCentre(2), 1);
    stand(s, [roomCentre(2)[0], roomCentre(2)[1] - 8], 1); // run on toward extract
    expect(activeIn(s, 2)).toBe(s.roomAlive(2));
  });

  it('a dead player wakes nothing', () => {
    const s = sim();
    s.setRoomActive(1, true);
    s.debugKillPlayer();
    stand(s, roomCentre(2), 1);
    expect(activeIn(s, 2)).toBe(0);
  });
});

/**
 * The rule is spatial, so it lives or dies on the SHAPE of each authored compound —
 * and a margin tuned on op 1 is worth nothing if op 9 lays its rooms 3m apart. These
 * run the whole campaign, so the day someone authors a layout the margin cannot
 * separate, it fails here instead of in a player's op.
 */
describe('every authored op has rooms the walk-in rule can tell apart', () => {
  const ops = CAMPAIGN.filter((m) => new Set(m.enemies.map((e) => e.room ?? 0)).size > 1);

  it('the campaign really is multi-room, or this sweep proves nothing', () => {
    expect(ops.length).toBeGreaterThan(8);
  });

  for (const m of ops) {
    const rooms = [...new Set(m.enemies.map((e) => e.room ?? 0))].sort((a, b) => a - b);

    const build = () => {
      const s = new FpsSim({
        enemies: m.enemies,
        cover: [...m.walls, ...m.cover],
        respawnEnabled: false,
      });
      s.setAllActive(false);
      return s;
    };
    const centreOf = (room: number): [number, number] => {
      const posts = m.enemies.filter((e) => (e.room ?? 0) === room).map((e) => e.pos);
      return [
        posts.reduce((a, p) => a + p[0], 0) / posts.length,
        posts.reduce((a, p) => a + p[1], 0) / posts.length,
      ];
    };
    const awake = (s: FpsSim, room: number) =>
      s.getEnemies().some((e) => e.alive && e.room === room && e.active);

    it(`${m.id}: standing in one room never reaches into another`, () => {
      for (const here of rooms) {
        const s = build();
        stand(s, centreOf(here), 0.5);
        expect(awake(s, here)).toBe(true);          // the room you are in answers
        for (const other of rooms) {
          if (other === here) continue;
          expect({ op: m.id, standingIn: here, woke: other, alsoWoke: awake(s, other) })
            .toEqual({ op: m.id, standingIn: here, woke: other, alsoWoke: false });
        }
      }
    });

    it(`${m.id}: the compound is quiet where the op starts`, () => {
      // The player is dropped outside the objective before the briefing has even
      // faded. Nothing should be shooting at them yet.
      const s = build();
      stand(s, m.start, 0.5);
      for (const room of rooms) expect({ op: m.id, room, awake: awake(s, room) }).toEqual({ op: m.id, room, awake: false });
    });
  }

  it('ROOM_ENTRY_REACH still fits the window the authored layouts leave for it', () => {
    // The sweep above catches a broken layout, but only tells you THAT it broke.
    // This re-derives the window from the mission data, so the failure message hands
    // you the two numbers you need to retune (or tells you the layout has no valid
    // reach at all and the rooms themselves have to move).
    const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    let mustCover = 0, coverOp = '';      // reach at least this, or a room misses its own middle
    let mustNotCross = Infinity, crossOp = ''; // reach under this, or it reaches into the next room

    for (const m of ops) {
      const rooms = [...new Set(m.enemies.map((e) => e.room ?? 0))];
      const posts = (r: number) => m.enemies.filter((e) => (e.room ?? 0) === r).map((e) => e.pos);
      for (const r of rooms) {
        const p = posts(r);
        const centre = [p.reduce((a, q) => a + q[0], 0) / p.length, p.reduce((a, q) => a + q[1], 0) / p.length];
        const own = Math.min(...p.map((q) => dist(centre, q)));
        if (own > mustCover) { mustCover = own; coverOp = `${m.id} room ${r}`; }
        const foreign = Math.min(...rooms.filter((o) => o !== r).flatMap((o) => posts(o).map((q) => dist(centre, q))));
        if (foreign < mustNotCross) { mustNotCross = foreign; crossOp = `${m.id} room ${r}`; }
      }
      // Spawning in must not put the player inside anybody's trigger.
      const atStart = Math.min(...rooms.flatMap((r) => posts(r).map((q) => dist(m.start, q))));
      if (atStart < mustNotCross) { mustNotCross = atStart; crossOp = `${m.id} start`; }
    }

    const reach = FPS_TUNING.ENEMY.ROOM_ENTRY_REACH;
    expect({ reach, floor: +mustCover.toFixed(2), ceiling: +mustNotCross.toFixed(2), tightestFloor: coverOp, tightestCeiling: crossOp })
      .toEqual({ reach, floor: +mustCover.toFixed(2), ceiling: +mustNotCross.toFixed(2), tightestFloor: coverOp, tightestCeiling: crossOp });
    expect(reach).toBeGreaterThanOrEqual(mustCover);
    expect(reach).toBeLessThan(mustNotCross);
    // And the window has not closed to the point where the number is only just working.
    expect(mustNotCross - mustCover).toBeGreaterThan(1.5);
  });
});
