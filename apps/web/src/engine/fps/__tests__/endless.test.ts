import { describe, it, expect } from 'vitest';
import {
  mulberry32,
  seedFromString,
  roomsForWave,
  firstRoomOfWave,
  waveOfRoom,
  roomEnemyCount,
  roomEnemyHpMult,
  generateRoom,
  buildChain,
  zForWaveStart,
  CHAIN_START_Z,
  ROOM_W,
  DOOR_W,
  WALL_T,
} from '../endless';
import { FpsSim } from '../FpsSim';

describe('wave shape', () => {
  it('grows 2,2,3,3,4,4 and caps at 6', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(roomsForWave)).toEqual([2, 2, 3, 3, 4, 4, 5, 5]);
    expect(roomsForWave(50)).toBe(6);
  });

  it('firstRoomOfWave and waveOfRoom are inverses', () => {
    for (let wave = 1; wave <= 30; wave++) {
      const first = firstRoomOfWave(wave);
      expect(waveOfRoom(first)).toBe(wave);
      // the room just before a wave's first room belongs to the previous wave
      if (wave > 1) expect(waveOfRoom(first - 1)).toBe(wave - 1);
    }
  });

  it('wave 1 starts at room 0', () => {
    expect(firstRoomOfWave(1)).toBe(0);
  });
});

describe('escalation', () => {
  it('enemy count grows and caps at 8', () => {
    expect(roomEnemyCount(0)).toBe(2);
    expect(roomEnemyCount(12)).toBe(8);
    expect(roomEnemyCount(200)).toBe(8);
    // Never decreasing — a later room must never be softer than an earlier one.
    for (let i = 1; i < 40; i++) {
      expect(roomEnemyCount(i)).toBeGreaterThanOrEqual(roomEnemyCount(i - 1));
    }
  });

  it('the opening room stays under the sim\'s simultaneous-attacker budget', () => {
    // FPS_TUNING.ENEMY.MAX_ATTACKERS is 3. A first room of exactly 3 means every
    // defender in it can be shooting at once, which made the run's opening seconds
    // its hardest moment.
    expect(roomEnemyCount(0)).toBeLessThan(3);
  });

  it('hp multiplier grows and caps at 3x', () => {
    expect(roomEnemyHpMult(0)).toBe(1);
    expect(roomEnemyHpMult(1000)).toBe(3);
    expect(roomEnemyHpMult(5)).toBeGreaterThan(roomEnemyHpMult(4));
  });
});

describe('determinism', () => {
  it('the same seed gives byte-identical rooms', () => {
    const a = generateRoom(7, -40, 12345);
    const b = generateRoom(7, -40, 12345);
    expect(a).toEqual(b);
  });

  it('different seeds give different layouts', () => {
    const a = buildChain(0, 12, CHAIN_START_Z, seedFromString('season-1'));
    const b = buildChain(0, 12, CHAIN_START_Z, seedFromString('season-2'));
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));
  });

  it('room N is generatable without generating rooms 0..N-1', () => {
    // This is what lets a resumed run drop straight in at a deep wave.
    const chain = buildChain(0, 20, CHAIN_START_Z, 999);
    const direct = generateRoom(19, chain[19].zNear, 999);
    expect(direct).toEqual(chain[19]);
  });

  it('mulberry32 is stable and in range', () => {
    const rng = mulberry32(42);
    const runs = [rng(), rng(), rng()];
    for (const v of runs) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(mulberry32(42)()).toBe(runs[0]);
  });
});

describe('room geometry', () => {
  const seed = seedFromString('geo');
  const chain = buildChain(0, 30, CHAIN_START_Z, seed);

  it('rooms tile without gaps: each room starts where the last ended', () => {
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i].zNear).toBe(chain[i - 1].zFar);
    }
  });

  it('every room advances toward -Z', () => {
    for (const r of chain) expect(r.zFar).toBeLessThan(r.zNear);
  });

  it('the far wall is sealed except for exactly one doorway', () => {
    for (const r of chain) {
      const farSegments = r.walls.filter((w) => Math.abs(w.z - r.zFar) < 1e-9);
      expect(farSegments).toHaveLength(2);
      const [left, right] = farSegments.sort((a, b) => a.x - b.x);
      const gapStart = left.x + left.w / 2;
      const gapEnd = right.x - right.w / 2;
      // the gap is the doorway, and it is where exitX says it is
      expect(gapEnd - gapStart).toBeCloseTo(DOOR_W, 5);
      expect((gapStart + gapEnd) / 2).toBeCloseTo(r.exitX, 5);
      // and the wall spans the full room width either side of it
      const outer = ROOM_W / 2 + WALL_T;
      expect(left.x - left.w / 2).toBeCloseTo(-outer, 5);
      expect(right.x + right.w / 2).toBeCloseTo(outer, 5);
    }
  });

  it('neighbouring rooms never overlap coplanar wall faces', () => {
    // Two identical surfaces occupying the same space z-fight: the renderer flickers
    // between them as the camera moves, which in game reads as the building shaking.
    // Side walls used to extend a wall-thickness past each end to seal the corners,
    // which made every junction share 1.2m of duplicated surface.
    for (let i = 0; i < chain.length - 1; i++) {
      const sidesOf = (r: typeof chain[number]) =>
        r.walls.filter((w) => Math.abs(Math.abs(w.x) - (ROOM_W / 2 + WALL_T / 2)) < 1e-9);
      for (const a of sidesOf(chain[i])) {
        for (const b of sidesOf(chain[i + 1])) {
          if (Math.abs(a.x - b.x) > 1e-9) continue; // different side of the corridor
          const overlap = Math.min(a.z + a.d / 2, b.z + b.d / 2) - Math.max(a.z - a.d / 2, b.z - b.d / 2);
          expect(overlap).toBeLessThanOrEqual(1e-9);
        }
      }
    }
  });

  it('the doorway is never jammed into a corner', () => {
    for (const r of chain) {
      expect(Math.abs(r.exitX) + DOOR_W / 2).toBeLessThan(ROOM_W / 2);
    }
  });

  it('the exit marker sits past the far wall, in the next room', () => {
    for (const r of chain) {
      expect(r.exitPos[0]).toBeCloseTo(r.exitX, 5);
      expect(r.exitPos[1]).toBeLessThan(r.zFar);
    }
  });

  it('side walls cover the room depth', () => {
    for (const r of chain) {
      const sides = r.walls.filter((w) => Math.abs(Math.abs(w.x) - (ROOM_W / 2 + WALL_T / 2)) < 1e-9);
      expect(sides).toHaveLength(2);
      for (const s of sides) {
        expect(s.z + s.d / 2).toBeGreaterThanOrEqual(r.zNear);
        expect(s.z - s.d / 2).toBeLessThanOrEqual(r.zFar);
      }
    }
  });
});

describe('enemy placement', () => {
  const chain = buildChain(0, 25, CHAIN_START_Z, seedFromString('enemies'));

  it('spawns the escalating count, tagged to its own room', () => {
    for (const r of chain) {
      expect(r.enemies).toHaveLength(roomEnemyCount(r.index));
      for (const e of r.enemies) expect(e.room).toBe(r.index + 1);
    }
  });

  it('holds defenders to the far half, so a breach is never an ambush', () => {
    // The player always enters at the near edge. A defender parked just inside the
    // door turns the breach into an instant point-blank fight, which is what this
    // guards against.
    for (const r of chain) {
      const depth = r.zNear - r.zFar;
      const halfway = r.zFar + depth / 2;
      for (const e of r.enemies) {
        expect(e.pos[1]).toBeLessThanOrEqual(halfway + 1e-9);
      }
    }
  });

  it('gives the breacher at least 5m of standoff on entry', () => {
    for (const r of chain) {
      // Where the player stands on entering this room (just past the near wall).
      const entryZ = r.zNear - 1.5;
      const nearest = Math.max(...r.enemies.map((e) => e.pos[1]));
      expect(entryZ - nearest).toBeGreaterThan(5);
    }
  });

  it('keeps every enemy inside its own room', () => {
    for (const r of chain) {
      for (const e of r.enemies) {
        const [x, z] = e.pos;
        expect(Math.abs(x)).toBeLessThan(ROOM_W / 2);
        expect(z).toBeGreaterThan(r.zFar);
        expect(z).toBeLessThan(r.zNear);
      }
    }
  });
});

describe('resume', () => {
  it('zForWaveStart lands exactly on that wave\'s first room', () => {
    const seed = seedFromString('resume');
    for (const wave of [1, 2, 5, 7, 12]) {
      const z = zForWaveStart(wave, seed);
      const room = generateRoom(firstRoomOfWave(wave), z, seed);
      expect(room.wave).toBe(wave);
      expect(room.zNear).toBe(z);
    }
  });

  it('wave 1 resumes at the chain origin', () => {
    expect(zForWaveStart(1, 123)).toBe(CHAIN_START_Z);
  });
});

describe('streaming into a live sim', () => {
  function simWithChain(rooms: ReturnType<typeof buildChain>) {
    const sim = new FpsSim({ loadout: ['assault_rifle'], enemies: [], cover: [], respawnEnabled: false });
    for (const r of rooms) {
      sim.appendCover([...r.walls, ...r.cover]);
      sim.appendEnemies(r.enemies);
    }
    return sim;
  }

  it('appended enemies arrive dormant so a room stays quiet until breached', () => {
    const rooms = buildChain(0, 3, CHAIN_START_Z, 7);
    const sim = simWithChain(rooms);
    expect(sim.getEnemies().every((e) => !e.active)).toBe(true);
    sim.setRoomActive(1, true);
    expect(sim.roomAlive(1)).toBe(roomEnemyCount(0));
    expect(sim.getEnemies().filter((e) => e.active)).toHaveLength(roomEnemyCount(0));
  });

  it('breaching a room staggers its defenders instead of waking them in lockstep', () => {
    // Every streamed-in enemy spawns with aiUntil 0, so before this they all cleared
    // the "may I peek" gate on the same frame: they took aggression tokens together,
    // telegraphed together and fired as one volley, then stayed in lockstep because
    // their timers were identical. Waking must spread that first peek.
    const rooms = buildChain(0, 3, CHAIN_START_Z, seedFromString('stagger'));
    const sim = new FpsSim({ loadout: ['assault_rifle'], enemies: [], cover: [], respawnEnabled: false });
    for (const r of rooms) {
      sim.appendCover([...r.walls, ...r.cover]);
      sim.appendEnemies(r.enemies);
    }

    sim.setRoomActive(1, true);
    const woken = sim.getEnemies().filter((e) => e.room === 1);
    expect(woken.length).toBeGreaterThan(1);

    const times = woken.map((e) => e.aiUntil);
    // None may be ready instantly, and they must not share one deadline.
    for (const t of times) expect(t).toBeGreaterThan(0);
    expect(new Set(times).size).toBe(times.length);
  });

  it('appendCover grows the live collision set in place', () => {
    const sim = new FpsSim({ loadout: ['assault_rifle'], enemies: [], cover: [], respawnEnabled: false });
    const live = sim.getCover(); // the scene holds this reference across frames
    const room = generateRoom(0, CHAIN_START_Z, 5);
    sim.appendCover(room.walls);
    expect(live.length).toBe(room.walls.length); // same array, seen without re-reading
  });

  it('pruneBehind drops old rooms and keeps enemies/spawns aligned', () => {
    const rooms = buildChain(0, 6, CHAIN_START_Z, 11);
    const sim = simWithChain(rooms);
    const before = sim.getEnemies().length;

    sim.pruneBehind(4, rooms[2].zFar);

    expect(sim.getEnemies().length).toBeLessThan(before);
    expect(sim.getEnemies().every((e) => e.room >= 4)).toBe(true);
    // No cover box may survive entirely behind the prune plane.
    for (const c of sim.getCover()) expect(c.z - c.d / 2).toBeLessThanOrEqual(rooms[2].zFar);

    // The spawns array is parallel to enemies; reinforce reads both by index. If
    // they desynced, reviving room 4 would teleport enemies to another room's spot.
    sim.setRoomActive(4, true);
    const room4 = sim.getEnemies().filter((e) => e.room === 4);
    for (const e of room4) e.alive = false;
    expect(sim.reinforce(4, 2)).toBe(2);
    for (const e of sim.getEnemies().filter((x) => x.room === 4 && x.alive)) {
      expect(e.z).toBeGreaterThan(rooms[3].zFar);
      expect(e.z).toBeLessThan(rooms[3].zNear);
    }
  });

  it('enemies deep in the chain are never yanked back toward the origin', () => {
    // The sim's enemy safety box defaults to a fixed square around the ORIGIN. Every
    // authored mission fits inside it, but the endless chain runs hundreds of metres
    // out — and an enemy clamped back to that box teleports into the geometry near the
    // start of the chain and shoots the player from inside a wall. This is the third
    // origin-anchored assumption endless has tripped over (the player clamp and the
    // sun's shadow frustum were the others), so it is worth pinning.
    const seed = seedFromString('deep');
    const chain = buildChain(0, 24, CHAIN_START_Z, seed);
    const deep = chain[chain.length - 1];

    const sim = new FpsSim({ loadout: ['assault_rifle'], enemies: [], cover: [], respawnEnabled: false });
    sim.appendCover([...deep.walls, ...deep.cover]);
    sim.appendEnemies(deep.enemies, true);
    sim.setBounds(-9, 9, deep.zFar, deep.zNear);

    // Drive the sim with the player standing at this room's entrance, so the AI has a
    // reason to move. Deep rooms sit far past the default clamp.
    expect(deep.zFar).toBeLessThan(-100);
    for (let i = 0; i < 240; i++) {
      sim.step(1 / 60, {
        firing: false, wantReload: false, adsFactor: 0, moving: false, crouched: false,
        origin: [0, 1.6, deep.zNear - 1], dir: [0, 0, -1],
      });
    }

    for (const e of sim.getEnemies()) {
      expect(e.z).toBeLessThanOrEqual(deep.zNear + 1e-6);
      expect(e.z).toBeGreaterThanOrEqual(deep.zFar - 1e-6);
    }
  });

  it('a long run stays bounded when pruned as the player advances', () => {
    const seed = seedFromString('long');
    const sim = new FpsSim({ loadout: ['assault_rifle'], enemies: [], cover: [], respawnEnabled: false });
    let z = CHAIN_START_Z;
    for (let i = 0; i < 120; i++) {
      const room = generateRoom(i, z, seed);
      sim.appendCover([...room.walls, ...room.cover]);
      sim.appendEnemies(room.enemies);
      z = room.zFar;
      if (i >= 3) sim.pruneBehind(i - 1, generateRoom(i - 3, 0, seed).zNear + z);
    }
    // Bounded rather than growing with run length: the win condition for streaming.
    expect(sim.getEnemies().length).toBeLessThan(60);
  });
});
