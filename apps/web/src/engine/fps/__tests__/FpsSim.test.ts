import { describe, it, expect } from 'vitest';
import { FpsSim, FPS_TUNING, raySphere, rayAABB, rayGround, aabbFaceNormal, jitter, slideMove, type FpsInput, type Vec3, type CoverBox } from '../FpsSim';
import { getGun } from '../../combat/GunStats';

// A shooter at the origin, eye height 1.6, looking straight down -Z. rng=0 makes
// jitter deterministic (a straight shot), so tests assert on geometry not luck.
const EYE: Vec3 = [0, 1.6, 0];
const FWD: Vec3 = [0, 0, -1];

function input(over: Partial<FpsInput> = {}): FpsInput {
  return { firing: true, wantReload: false, origin: EYE, dir: FWD, adsFactor: 1, moving: false, crouched: false, ...over };
}

function noJitter() {
  return new FpsSim({ gunId: 'sidearm', enemies: [{ pos: [0, -6] }], rng: () => 0 });
}

describe('FpsSim geometry helpers', () => {
  it('raySphere hits a sphere dead ahead and misses one off to the side', () => {
    expect(raySphere(EYE, FWD, [0, 1.6, -5], 0.2)).toBeCloseTo(4.8, 1);
    expect(raySphere(EYE, FWD, [3, 1.6, -5], 0.2)).toBeNull();
  });
  it('rayAABB hits a box in the path and misses one beside it', () => {
    expect(rayAABB(EYE, FWD, [[-0.5, 1.4, -6], [0.5, 1.8, -4]])).toBeCloseTo(4, 1);
    expect(rayAABB(EYE, FWD, [[5, 1.4, -6], [6, 1.8, -4]])).toBeNull();
  });
  it('rayGround meets the floor where a downward shot would land', () => {
    // From 1.6m up, angled 45° down: it reaches y=0 after 1.6m of drop.
    const down: Vec3 = [0, -Math.SQRT1_2, -Math.SQRT1_2];
    expect(rayGround(EYE, down)).toBeCloseTo(1.6 * Math.SQRT2, 3);
    expect(rayGround(EYE, FWD)).toBeNull();          // level: never comes down
    expect(rayGround(EYE, [0, 1, 0])).toBeNull();    // climbing
  });

  it('aabbFaceNormal names the face the round actually struck', () => {
    const box: [Vec3, Vec3] = [[-1, 0, -1], [1, 2, 1]];
    expect(aabbFaceNormal([-1, 1, 0], box)).toEqual([-1, 0, 0]);  // west face
    expect(aabbFaceNormal([1, 1, 0], box)).toEqual([1, 0, 0]);    // east face
    expect(aabbFaceNormal([0, 2, 0], box)).toEqual([0, 1, 0]);    // top
    expect(aabbFaceNormal([0, 1, 1], box)).toEqual([0, 0, 1]);    // south face
  });

  it('jitter with zero spread returns the same direction', () => {
    expect(jitter(FWD, 0, () => 0.5)).toEqual(FWD);
  });
  it('jitter stays within the cone half-angle', () => {
    const rng = (() => { let i = 0; const seq = [0.9, 0.3, 0.5, 0.7]; return () => seq[i++ % seq.length]; })();
    const d = jitter(FWD, 0.1, rng);
    const dot = d[0] * FWD[0] + d[1] * FWD[1] + d[2] * FWD[2];
    expect(Math.acos(dot)).toBeLessThanOrEqual(0.1 + 1e-6);
  });
});

describe('slideMove: walls are solid, no tunnelling', () => {
  // A thin wall centred at x=0, spanning z ∈ [-5, 5], 0.3m thick.
  const WALL: CoverBox = { x: 0, z: 0, w: 0.3, d: 10, h: 3 };
  const R = 0.35;
  const inside = (x: number, z: number, c: CoverBox, r: number) =>
    Math.abs(x - c.x) < c.w / 2 + r - 1e-9 && Math.abs(z - c.z) < c.d / 2 + r - 1e-9;

  const FACE = WALL.w / 2 + R; // 0.65: distance from centre a body's centre can reach

  it('blocks a body walking straight into a wall, stopping just outside the near face', () => {
    // Start left of the wall, aim well past it.
    const [nx, nz] = slideMove(-2, 0, 2, 0, R, [WALL]);
    expect(nx).toBeLessThanOrEqual(-FACE);     // never reaches the surface
    expect(nx).toBeCloseTo(-FACE, 2);          // and stops right at it
    expect(nz).toBeCloseTo(0, 5);
    expect(inside(nx, nz, WALL, R)).toBe(false);
  });

  it('does NOT tunnel even when one step would cross the whole wall', () => {
    // A huge step (slow frame): from far left to far right in one move.
    const [nx] = slideMove(-8, 0, 8, 0, R, [WALL]);
    expect(nx).toBeLessThanOrEqual(-FACE); // never reaches the far side
    expect(nx).toBeGreaterThan(-8);        // but it did advance up to the wall
  });

  it('the reverse direction is symmetric (blocks at the +x face)', () => {
    const [nx] = slideMove(2, 0, -2, 0, R, [WALL]);
    expect(nx).toBeGreaterThanOrEqual(FACE);
    expect(nx).toBeCloseTo(FACE, 2);
  });

  it('slides ALONG a wall instead of stopping dead', () => {
    // Pressing into the wall (+x) while also moving down (+z): x is blocked, z passes.
    const [nx, nz] = slideMove(-1, 0, 1, 3, R, [WALL]);
    expect(nx).toBeLessThanOrEqual(-FACE); // held outside the face
    expect(nx).toBeCloseTo(-FACE, 2);
    expect(nz).toBeCloseTo(3, 2);          // free to slide along it
    expect(inside(nx, nz, WALL, R)).toBe(false);
  });

  it('rounds a corner: moving past the end of the wall is not blocked', () => {
    // Origin is beyond the wall's z-extent, so the wall cannot block x movement.
    const [nx] = slideMove(-2, 8, 2, 8, R, [WALL]);
    expect(nx).toBeCloseTo(2, 5); // free, went around the end
  });

  it('ejects a body that starts buried inside geometry', () => {
    const [nx] = slideMove(0.05, 0, 0.05, 0, R, [WALL]); // dead centre in the wall
    expect(inside(nx, 0, WALL, R)).toBe(false);
  });

  it('a random walk can never end up inside a wall (fuzz)', () => {
    const boxes: CoverBox[] = [
      { x: 0, z: 0, w: 0.3, d: 8, h: 3 },
      { x: 3, z: 2, w: 2, d: 0.3, h: 3 },
      { x: -2, z: -3, w: 1, d: 1, h: 3 },
    ];
    let rng = 42;
    const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
    let x = -6, z = -6;
    for (let i = 0; i < 4000; i++) {
      // Deliberately large steps (up to ~1.2m) to stress the thin walls on a slow frame.
      const tx = x + (rand() - 0.5) * 2.4;
      const tz = z + (rand() - 0.5) * 2.4;
      [x, z] = slideMove(x, z, tx, tz, R, boxes);
      for (const c of boxes) {
        expect(inside(x, z, c, R)).toBe(false);
      }
    }
  });
});

describe('FpsSim firing', () => {
  // The eye (1.6) sits at head height (1.62), so a LEVEL shot is a headshot;
  // the torso, legs and arms are hit by aiming at those parts. Enemy at (0,-6).
  const TORSO: Vec3 = [0, -0.6, -6]; // aim down at the chest
  const LEG: Vec3 = [0, -1.1, -6];   // aim down at the legs
  const ARM: Vec3 = [-0.3, -0.41, -6]; // aim at the left arm, off to the side

  it('an aim at the torso hits the body and reports damage', () => {
    const sim = noJitter();
    const evs = sim.step(1 / 60, input({ dir: TORSO }));
    expect(evs.find((e) => e.kind === 'fire')).toBeTruthy();
    expect(evs.find((e) => e.kind === 'hit')).toMatchObject({ kind: 'hit', part: 'torso' });
    expect(sim.snapshot().stats.hits).toBe(1);
    expect(sim.ammo).toBe(sim.gun.magazine - 1);
  });

  it('any part of the body registers a hit (torso, legs and arms all connect)', () => {
    for (const [dir, part] of [[TORSO, 'torso'], [LEG, 'leg'], [ARM, 'arm']] as const) {
      const sim = noJitter();
      const hit = sim.step(1 / 60, input({ dir })).find((e) => e.kind === 'hit') as { part: string } | undefined;
      expect(hit?.part).toBe(part);
    }
  });

  it('a level shot lands a headshot for more damage than a torso shot', () => {
    const bodySim = noJitter();
    bodySim.step(1 / 60, input({ dir: TORSO }));
    const bodyDmg = (bodySim.drain().find((e) => e.kind === 'hit') as { damage: number }).damage;

    const headSim = noJitter();
    const evs = headSim.step(1 / 60, input({ dir: [0, 0, -1] }));
    const hit = evs.find((e) => e.kind === 'hit') as { part: string; damage: number };
    expect(hit.part).toBe('head');
    expect(hit.damage).toBeGreaterThan(bodyDmg);
  });

  it('SEMI fires exactly one round per trigger pull, even if held', () => {
    const sim = new FpsSim({ gunId: 'marksman', enemies: [{ pos: [0, -6] }], rng: () => 0 }); // marksman = semi
    expect(sim.fireMode).toBe('semi');
    // hold the trigger for many frames past the cadence -> still only ONE shot
    let shots = 0;
    for (let i = 0; i < 30; i++) shots += sim.step(0.1, input()).filter((e) => e.kind === 'fire').length;
    expect(shots).toBe(1);
    // release, then pull again -> a second shot
    sim.step(0.1, input({ firing: false }));
    for (let i = 0; i < 30; i++) shots += sim.step(0.1, input()).filter((e) => e.kind === 'fire').length;
    expect(shots).toBe(2);
  });

  it('BURST fires a fixed count per pull, then waits for release', () => {
    const sim = new FpsSim({ gunId: 'assault_rifle', enemies: [{ pos: [0, -6] }], rng: () => 0 });
    sim.cycleFireMode(); // auto -> burst
    expect(sim.fireMode).toBe('burst');
    let shots = 0;
    for (let i = 0; i < 40; i++) shots += sim.step(0.1, input()).filter((e) => e.kind === 'fire').length; // held
    expect(shots).toBe(3); // exactly one burst, not endless
    sim.step(0.1, input({ firing: false }));
    for (let i = 0; i < 40; i++) shots += sim.step(0.1, input()).filter((e) => e.kind === 'fire').length;
    expect(shots).toBe(6); // a second burst on the second pull
  });

  it('AUTO sprays continuously while held', () => {
    const sim = new FpsSim({ gunId: 'smg', enemies: [{ pos: [0, -6] }], rng: () => 0 }); // smg = auto
    expect(sim.fireMode).toBe('auto');
    let shots = 0;
    for (let i = 0; i < 12; i++) shots += sim.step(1, input()).filter((e) => e.kind === 'fire').length; // dt=1 clears cadence
    expect(shots).toBeGreaterThan(3); // it keeps firing (until it empties + reloads)
  });

  it('cycleFireMode walks a gun\'s allowed modes and single-mode guns stay put', () => {
    const ar = new FpsSim({ gunId: 'assault_rifle', enemies: [], rng: () => 0 });
    expect(ar.fireMode).toBe('auto');
    expect(ar.cycleFireMode()).toBe('burst');
    expect(ar.cycleFireMode()).toBe('semi');
    expect(ar.cycleFireMode()).toBe('auto'); // wraps
    const pistol = new FpsSim({ gunId: 'sidearm', enemies: [], rng: () => 0 });
    expect(pistol.cycleFireMode()).toBe('semi'); // only one mode -> unchanged
  });

  it('respects fire cadence (no second shot before the cooldown elapses)', () => {
    const sim = noJitter();
    expect(sim.step(1 / 60, input()).filter((e) => e.kind === 'fire').length).toBe(1);
    // sidearm = 180rpm → 0.333s between shots; a 1/60s step later must not fire.
    expect(sim.step(1 / 60, input()).filter((e) => e.kind === 'fire').length).toBe(0);
  });

  it('kills a target with enough shots and stops hitting the corpse', () => {
    const sim = new FpsSim({ gunId: 'marksman', enemies: [{ pos: [0, -6], hp: 100 }], rng: () => 0 });
    let killed = false;
    for (let i = 0; i < 40 && !killed; i++) {
      const e = sim.getEnemies()[0];
      const dir: Vec3 = [e.x, FPS_TUNING.HEAD_Y - 1.6, e.z]; // aim at the (maneuvering) enemy's head
      const evs = sim.step(0.3, input({ dir, firing: i % 2 === 0 })); // marksman = semi, so pulse
      if (evs.some((ev) => ev.kind === 'kill')) killed = true;
    }
    expect(killed).toBe(true);
    expect(sim.aliveCount()).toBe(0);
    expect(sim.snapshot().stats.kills).toBe(1);
  });

  it('AUTO-reloads the instant the magazine runs dry, then refills', () => {
    const sim = new FpsSim({ gunId: 'assault_rifle', enemies: [{ pos: [0, -6] }], rng: () => 0 }); // auto
    const mag = sim.gun.magazine;
    for (let i = 0; i < mag; i++) sim.step(1, input());
    expect(sim.ammo).toBe(0);
    expect(sim.reloading).toBe(true); // started on its own — no R pressed
    sim.step(sim.gun.reloadTime + 0.1, input({ firing: false }));
    expect(sim.reloading).toBe(false);
    expect(sim.ammo).toBe(mag);
  });

  it('manual reload (R / button) tops up before the mag is empty', () => {
    const sim = new FpsSim({ gunId: 'sidearm', enemies: [{ pos: [0, -6] }], rng: () => 0 });
    sim.step(1, input()); // fire one
    expect(sim.ammo).toBe(sim.gun.magazine - 1);
    sim.step(1 / 60, input({ firing: false, wantReload: true }));
    expect(sim.reloading).toBe(true);
    sim.step(sim.gun.reloadTime + 0.1, input({ firing: false }));
    expect(sim.ammo).toBe(sim.gun.magazine);
  });

  it('cover between the shooter and an enemy eats the round (no hit)', () => {
    const sim = new FpsSim({
      gunId: 'sidearm',
      enemies: [{ pos: [0, -8] }],
      cover: [{ x: 0, z: -4, w: 2, d: 1, h: 2 }],
      rng: () => 0,
    });
    const evs = sim.step(1 / 60, input());
    expect(evs.some((e) => e.kind === 'wall')).toBe(true);
    expect(evs.some((e) => e.kind === 'hit')).toBe(false);
  });

  it('a wall hit reports the face it struck, so the impact can spark back out of it', () => {
    const sim = new FpsSim({
      gunId: 'sidearm',
      enemies: [{ pos: [0, -8] }],
      cover: [{ x: 0, z: -4, w: 2, d: 1, h: 2 }],
      rng: () => 0,
    });
    const wall = sim.step(1 / 60, input()).find((e) => e.kind === 'wall');
    // Shooting down -Z into the crate's near face: the normal points back at you.
    expect(wall && wall.kind === 'wall' && wall.normal).toEqual([0, 0, 1]);
  });

  it('a round aimed at the floor lands ON the floor instead of missing into the sky', () => {
    // Steeply down and forward, with nothing in the way but the ground.
    const sim = new FpsSim({ gunId: 'sidearm', enemies: [], rng: () => 0 });
    const evs = sim.step(1 / 60, input({ dir: [0, -0.6, -0.8] }));
    const wall = evs.find((e) => e.kind === 'wall');
    expect(wall).toBeDefined();
    expect(evs.some((e) => e.kind === 'miss')).toBe(false);
    if (wall && wall.kind === 'wall') {
      expect(wall.point[1]).toBeCloseTo(0, 5);   // on the deck
      expect(wall.normal).toEqual([0, 1, 0]);    // facing up out of it
    }
  });

  it('ADS spread is tighter than hip spread for the same gun', () => {
    const sim = noJitter();
    const hip = sim.spreadFor(0, false, false);
    const ads = sim.spreadFor(1, false, false);
    expect(ads).toBeLessThan(hip);
  });

  it('a dead enemy respawns after the delay', () => {
    const sim = new FpsSim({ gunId: 'marksman', enemies: [{ pos: [0, -6] }], rng: () => 0 });
    sim.debugKillAll();
    expect(sim.aliveCount()).toBe(0);
    const evs = sim.step(FPS_TUNING.RESPAWN_DELAY + 0.1, input({ firing: false }));
    expect(evs.some((e) => e.kind === 'spawn')).toBe(true);
    expect(sim.aliveCount()).toBe(1);
  });
});

describe('FpsSim enemies fighting back (slice 3)', () => {
  // The player stands at the origin, not firing; enemies act on their own.
  const idle = (over: Partial<FpsInput> = {}): FpsInput =>
    ({ firing: false, wantReload: false, origin: [0, 1.6, 0], dir: [0, 0, -1], adsFactor: 0, moving: false, crouched: false, ...over });

  it('an enemy with line of sight telegraphs (enemyAim) then fires and damages the player', () => {
    const sim = new FpsSim({ gunId: 'sidearm', enemies: [{ pos: [0, -6] }], rng: () => 0 });
    const first = sim.step(0.1, idle());
    expect(first.some((e) => e.kind === 'enemyAim')).toBe(true); // telegraph before the shot
    let fired = false, hurt = false;
    for (let i = 0; i < 20; i++) {
      const evs = sim.step(0.1, idle());
      if (evs.some((e) => e.kind === 'enemyFire')) fired = true;
      if (evs.some((e) => e.kind === 'playerHit')) hurt = true;
    }
    expect(fired).toBe(true);
    expect(hurt).toBe(true);
    expect(sim.playerHp).toBeLessThan(100);
  });

  it('never lets more than MAX_ATTACKERS aim at once (aggression tokens)', () => {
    const enemies = Array.from({ length: 6 }, (_, i) => ({ pos: [(i - 3) * 1.5, -8] as [number, number] }));
    const sim = new FpsSim({ gunId: 'sidearm', enemies, rng: () => 0.5 });
    let peak = 0;
    for (let i = 0; i < 60; i++) {
      sim.step(0.1, idle());
      peak = Math.max(peak, sim.getEnemies().filter((e) => e.token).length);
    }
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(FPS_TUNING.ENEMY.MAX_ATTACKERS);
  });

  it('an enemy fully behind cover from the player does not fire', () => {
    const sim = new FpsSim({
      gunId: 'sidearm',
      enemies: [{ pos: [0, -10] }],
      cover: [{ x: 0, z: -4, w: 40, d: 1, h: 3 }], // a full wall — no reachable line of sight
      rng: () => 0,
    });
    let fired = false;
    for (let i = 0; i < 60; i++) if (sim.step(0.1, idle()).some((e) => e.kind === 'enemyFire')) fired = true;
    expect(fired).toBe(false);
    expect(sim.playerHp).toBe(100);
  });

  it('two hits cannot land inside the mercy window', () => {
    const sim = new FpsSim({ gunId: 'sidearm', enemies: [{ pos: [0, -5] }, { pos: [1, -5] }], rng: () => 0 });
    // step in one 0.3s chunk (< MERCY_MS) after the telegraph; at most one hit sticks
    for (let i = 0; i < 8; i++) sim.step(0.1, idle()); // let them telegraph + fire
    const hpAfter = sim.playerHp;
    // a single sub-mercy step can only remove one DMG worth
    const before = sim.playerHp;
    sim.step(0.3, idle());
    expect(before - sim.playerHp).toBeLessThanOrEqual(FPS_TUNING.ENEMY.DMG);
    expect(hpAfter).toBeLessThan(100);
  });

  it('a dormant room holds fire until it is activated (mission gating)', () => {
    const sim = new FpsSim({ gunId: 'sidearm', enemies: [{ pos: [0, -6], room: 1 }], rng: () => 0 });
    sim.setRoomActive(1, false);
    let fired = false;
    for (let i = 0; i < 30; i++) if (sim.step(0.1, idle()).some((e) => e.kind === 'enemyFire')) fired = true;
    expect(fired).toBe(false);
    expect(sim.roomAlive(1)).toBe(1);
    sim.setRoomActive(1, true); // breach → the room wakes and engages
    let firedNow = false;
    for (let i = 0; i < 30; i++) if (sim.step(0.1, idle()).some((e) => e.kind === 'enemyFire')) firedNow = true;
    expect(firedNow).toBe(true);
  });

  it('mission mode leaves cleared enemies down (no respawn)', () => {
    const sim = new FpsSim({ gunId: 'marksman', enemies: [{ pos: [0, -6] }], rng: () => 0, respawnEnabled: false });
    sim.debugKillAll();
    expect(sim.aliveCount()).toBe(0);
    sim.step(FPS_TUNING.RESPAWN_DELAY + 1, idle());
    expect(sim.aliveCount()).toBe(0);
  });

  it('DELIVERS enemy events to the scene via drain(), not only via step()', () => {
    // Regression: enemyAim/enemyFire/playerHit went into step()'s return value
    // only, so the scene (which reads drain()) never saw them — no tracer, no
    // muzzle flash, no sound, no hit reaction.
    const sim = new FpsSim({ gunId: 'sidearm', enemies: [{ pos: [0, -6] }], rng: () => 0 });
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      sim.step(0.1, idle());
      for (const e of sim.drain()) seen.add(e.kind);
    }
    expect(seen.has('enemyAim')).toBe(true);
    expect(seen.has('enemyFire')).toBe(true);
    expect(seen.has('playerHit')).toBe(true);
  });

  it('an enemy round leaves the MUZZLE of the rifle, not the middle of its chest', () => {
    const sim = new FpsSim({ gunId: 'sidearm', enemies: [{ pos: [0, -8] }], rng: () => 0 });
    let fire: any = null;
    for (let i = 0; i < 40 && !fire; i++) fire = sim.step(0.1, idle()).find((e) => e.kind === 'enemyFire');
    expect(fire).toBeTruthy();
    const E = FPS_TUNING.ENEMY;
    expect(fire.from[1]).toBeCloseTo(E.MUZZLE_Y, 5);            // barrel height
    const offset = Math.hypot(fire.from[0] - 0, fire.from[2] - -8);
    expect(offset).toBeGreaterThan(0.3);                        // out in front of the body
    // the impact must actually lie along the reported ray
    const t = Math.hypot(fire.impact[0] - fire.from[0], fire.impact[1] - fire.from[1], fire.impact[2] - fire.from[2]);
    for (let k = 0; k < 3; k++) expect(fire.impact[k]).toBeCloseTo(fire.from[k] + fire.dir[k] * t, 4);
  });

  it('an enemy round resolves against a BODY PART, and damage follows the part', () => {
    const sim = new FpsSim({ gunId: 'sidearm', enemies: [{ pos: [0, -8] }], rng: () => 0 });
    let hit: any = null;
    for (let i = 0; i < 60 && !hit; i++) hit = sim.step(0.1, idle()).find((e) => e.kind === 'playerHit');
    expect(hit).toBeTruthy();
    expect(['head', 'torso', 'leg', 'arm']).toContain(hit.part);
    const mult = FPS_TUNING.PLAYER_HIT.PART_MULT[hit.part as 'torso'];
    expect(hit.damage).toBe(Math.round(FPS_TUNING.ENEMY.DMG * mult));
  });

  it('a headshot on the player would hurt far more than a torso hit', () => {
    const M = FPS_TUNING.PLAYER_HIT.PART_MULT;
    expect(M.head).toBeGreaterThan(M.torso);
    expect(M.torso).toBeGreaterThan(M.leg);
  });

  it('cover eats the enemy round: no body part, no damage', () => {
    const sim = new FpsSim({
      gunId: 'sidearm',
      enemies: [{ pos: [0, -10] }],
      cover: [{ x: 0, z: -4, w: 40, d: 1, h: 3 }], // full wall
      rng: () => 0,
    });
    let sawFire = false, sawHit = false;
    for (let i = 0; i < 60; i++) {
      for (const e of sim.step(0.1, idle())) {
        if (e.kind === 'enemyFire') { sawFire = true; expect(e.hit).toBe(false); expect(e.part).toBeNull(); }
        if (e.kind === 'playerHit') sawHit = true;
      }
    }
    expect(sawHit).toBe(false);
    expect(sim.playerHp).toBe(100);
    expect(sawFire).toBe(false); // no LOS, so it never even fires
  });

  it('the player goes DOWN under sustained fire; resetEncounter restores everything', () => {
    const sim = new FpsSim({ gunId: 'sidearm', enemies: [{ pos: [0, -5] }, { pos: [2, -5] }], rng: () => 0 });
    let down = false;
    for (let i = 0; i < 300 && !down; i++) if (sim.step(0.1, idle()).some((e) => e.kind === 'playerDown')) down = true;
    expect(down).toBe(true);
    expect(sim.playerAlive).toBe(false);
    sim.resetEncounter();
    expect(sim.playerAlive).toBe(true);
    expect(sim.playerHp).toBe(100);
    expect(sim.aliveCount()).toBe(2);
  });
});

// Co-op Endless (party mode): a HOST's own FpsSim additionally tracks
// teammates as live AI targets via setCombatant/resolveRemoteShot. Every
// other describe block in this file never calls either — these tests are
// what actually proves that path stays inert until something does.
describe('FpsSim co-op combatants (party mode)', () => {
  const idle = (over: Partial<FpsInput> = {}): FpsInput =>
    ({ firing: false, wantReload: false, origin: [0, 1.6, 0], dir: [0, 0, -1], adsFactor: 0, moving: false, crouched: false, ...over });

  it('with zero registered combatants, an enemy always stays locked on the local player', () => {
    const sim = new FpsSim({ gunId: 'sidearm', enemies: [{ pos: [0, -6] }], rng: () => 0 });
    for (let i = 0; i < 10; i++) sim.step(0.1, idle());
    expect(sim.getEnemies()[0].targetId).toBe('__local__');
  });

  it('an enemy the local player cannot see still engages a teammate who has a clean line of sight', () => {
    const sim = new FpsSim({
      gunId: 'sidearm',
      enemies: [{ pos: [0, -10] }],
      cover: [{ x: 0, z: -4, w: 40, d: 1, h: 3 }], // blocks the local player's LOS entirely
      rng: () => 0,
    });
    sim.setCombatant('teammate', 3, -9, 1.6); // same side of the wall as the enemy — clear LOS
    for (let i = 0; i < 60; i++) sim.step(0.1, idle());

    expect(sim.playerHp).toBe(100); // never engaged — the wall protected them
    expect(sim.snapshot().combatants.teammate.hp).toBeLessThan(100); // the teammate took the fire instead
    // getCombatant is the same truth by a different door — the host's own
    // client (never a target itself) has no other way to read a teammate's
    // hp/alive, unlike a non-host reading it off the broadcast snapshot.
    expect(sim.getCombatant('teammate')?.hp).toBe(sim.snapshot().combatants.teammate.hp);
    expect(sim.getCombatant('nobody-registered')).toBeNull();
  });

  it("a teammate's shot kills an enemy without inflating the local player's own session stats", () => {
    const sim = new FpsSim({ gunId: 'sidearm', enemies: [{ pos: [0, -6], hp: 1 }], rng: () => 0 });
    sim.resolveRemoteShot('teammate', [0, 1.6, -3], [0, 0, -1], 0);
    expect(sim.getEnemies()[0].alive).toBe(false);
    expect(sim.hits).toBe(0);
    expect(sim.kills).toBe(0);
    expect(sim.headshots).toBe(0);
  });

  it("a teammate's landed hit is tagged with their id, not the local player's", () => {
    const sim = new FpsSim({ gunId: 'sidearm', enemies: [{ pos: [0, -6] }], rng: () => 0 });
    sim.resolveRemoteShot('teammate', [0, 1.6, -3], [0, 0, -1], 0);
    const hit = sim.drain().find((e) => e.kind === 'hit');
    expect(hit).toBeTruthy();
    expect((hit as { shooterId?: string }).shooterId).toBe('teammate');
  });

  it('removeCombatant makes an enemy drop them as a target instead of firing at a ghost', () => {
    const sim = new FpsSim({
      gunId: 'sidearm',
      enemies: [{ pos: [0, -10] }],
      cover: [{ x: 0, z: -4, w: 40, d: 1, h: 3 }],
      rng: () => 0,
    });
    sim.setCombatant('teammate', 3, -9, 1.6);
    for (let i = 0; i < 10; i++) sim.step(0.1, idle());
    expect(sim.getEnemies()[0].targetId).toBe('teammate');

    sim.removeCombatant('teammate');
    sim.step(0.1, idle());
    expect(sim.getEnemies()[0].targetId).not.toBe('teammate');
  });

  it("a downed teammate stops being targeted, and the local player is never touched", () => {
    const sim = new FpsSim({
      gunId: 'sidearm',
      enemies: [{ pos: [0, -9] }, { pos: [2, -9] }],
      cover: [{ x: 0, z: -4, w: 40, d: 1, h: 3 }],
      rng: () => 0,
    });
    sim.setCombatant('teammate', 3, -8, 1.6);
    for (let i = 0; i < 300; i++) sim.step(0.1, idle());

    const teammate = sim.snapshot().combatants.teammate;
    expect(teammate.alive).toBe(false);
    expect(teammate.hp).toBe(0);
    expect(sim.playerAlive).toBe(true);
    expect(sim.playerHp).toBe(100);
  });
});

describe('FpsSim boss phases', () => {
  const idle = (over: Partial<FpsInput> = {}): FpsInput =>
    ({ firing: false, wantReload: false, origin: [0, 1.6, 0], dir: [0, 0, -1], adsFactor: 0, moving: false, crouched: false, ...over });
  const bossSim = (hp = 300) =>
    new FpsSim({ gunId: 'sidearm', enemies: [{ pos: [0, -6], hp, boss: true }], rng: () => 0.5, respawnEnabled: false });

  it('starts in phase 1 and escalates through 2 then 3 as its health falls', () => {
    const sim = bossSim();
    const boss = sim.getEnemies()[0];
    expect(boss.phase).toBe(1);
    const seen: number[] = [];
    (boss as any).hp = boss.maxHp * 0.5;  // below PHASE_AT[0] → phase 2
    for (const e of sim.step(0.1, idle())) if (e.kind === 'bossPhase') seen.push(e.phase);
    (boss as any).hp = boss.maxHp * 0.2;  // below PHASE_AT[1] → phase 3
    for (const e of sim.step(0.1, idle())) if (e.kind === 'bossPhase') seen.push(e.phase);
    expect(seen).toEqual([2, 3]);
    expect(boss.phase).toBe(3);
  });

  it('announces each phase exactly once', () => {
    const sim = bossSim();
    (sim.getEnemies()[0] as any).hp = sim.getEnemies()[0].maxHp * 0.5;
    let count = 0;
    for (let i = 0; i < 10; i++) for (const e of sim.step(0.1, idle())) if (e.kind === 'bossPhase') count++;
    expect(count).toBe(1);
  });

  it('gives a mook no phase but a boss always one', () => {
    const sim = new FpsSim({ gunId: 'sidearm', enemies: [{ pos: [0, -6] }, { pos: [2, -6], boss: true }], rng: () => 0 });
    const [mook, boss] = sim.getEnemies();
    expect(mook.phase).toBe(0);
    expect(boss.phase).toBe(1);
  });

  it('lets a boss fight OUTSIDE the MAX_ATTACKERS token budget', () => {
    // Saturate the mook budget, then check the boss still gets to fire.
    const mooks = Array.from({ length: FPS_TUNING.ENEMY.MAX_ATTACKERS }, (_, i) => ({ pos: [(i - 1) * 1.2, -5] as [number, number] }));
    const sim = new FpsSim({ gunId: 'sidearm', enemies: [...mooks, { pos: [0, -6], hp: 500, boss: true }], rng: () => 0.5, respawnEnabled: false });
    const bossId = sim.getEnemies().at(-1)!.id;
    let bossFired = false, mookTokenPeak = 0;
    for (let i = 0; i < 90; i++) {
      for (const e of sim.step(0.1, idle())) if (e.kind === 'enemyFire' && e.enemyId === bossId) bossFired = true;
      mookTokenPeak = Math.max(mookTokenPeak, sim.getEnemies().filter((e) => e.token && !e.boss).length);
    }
    expect(mookTokenPeak).toBe(FPS_TUNING.ENEMY.MAX_ATTACKERS); // the shared budget IS saturated
    expect(bossFired).toBe(true);                                // and the boss fired regardless
  });

  it('only sharpens as it escalates (aim, recovery, spread, distance all shrink)', () => {
    const B = FPS_TUNING.BOSS;
    expect(B.AIM_MS[0]).toBeGreaterThan(B.AIM_MS[1]);
    expect(B.AIM_MS[1]).toBeGreaterThan(B.AIM_MS[2]);
    expect(B.RECOVER_MS[0]).toBeGreaterThan(B.RECOVER_MS[2]);
    expect(B.SPREAD_MULT[0]).toBeGreaterThan(B.SPREAD_MULT[2]);
    expect(B.PREFERRED_DIST[0]).toBeGreaterThan(B.PREFERRED_DIST[2]);
  });

  it('an enraged boss puts out more fire than a fresh one in the same window', () => {
    const firesAt = (frac: number) => {
      const sim = bossSim(1000);
      const boss = sim.getEnemies()[0];
      let fires = 0;
      for (let i = 0; i < 140; i++) {
        (boss as any).hp = boss.maxHp * frac; // pin the phase for the window
        for (const e of sim.step(0.1, idle())) if (e.kind === 'enemyFire') fires++;
      }
      return fires;
    };
    expect(firesAt(0.2)).toBeGreaterThan(firesAt(0.9));
  });
});

describe('FpsSim loadout + weapon switch', () => {
  it('a bare gunId is a single-weapon loadout with no swap', () => {
    const sim = new FpsSim({ gunId: 'assault_rifle', enemies: [], rng: () => 0 });
    expect(sim.loadout).toEqual(['assault_rifle']);
    expect(sim.gun.id).toBe('assault_rifle');
    expect(sim.nextWeapon()).toBe(false);
    expect(sim.switchGun(1)).toBe(false);
  });

  it('carries two weapons and switching changes the active gun + fire mode', () => {
    const sim = new FpsSim({ loadout: ['marksman', 'sidearm'], enemies: [], rng: () => 0 });
    expect(sim.gun.id).toBe('marksman');
    expect(sim.ammo).toBe(sim.gun.magazine); // 8
    expect(sim.switchGun(1)).toBe(true);
    expect(sim.gun.id).toBe('sidearm');
    expect(sim.ammo).toBe(12);
    const evs = sim.drain();
    expect(evs.some((e) => e.kind === 'weaponSwitch' && e.gunId === 'sidearm' && e.slot === 1)).toBe(true);
  });

  it('tracks ammo PER weapon — swapping never refills the other', () => {
    const sim = new FpsSim({ loadout: ['assault_rifle', 'sidearm'], enemies: [{ pos: [0, -100] }], rng: () => 0 });
    for (let i = 0; i < 3; i++) sim.step(0.2, input()); // burn a few AR rounds (target too far to kill)
    const arAmmo = sim.ammo;
    expect(arAmmo).toBeLessThan(24);
    sim.switchGun(1);
    expect(sim.ammo).toBe(12);   // sidearm is full
    sim.switchGun(0);
    expect(sim.ammo).toBe(arAmmo); // AR kept exactly what it had
  });

  it('imposes a raise time: you cannot fire immediately after a swap', () => {
    const sim = new FpsSim({ loadout: ['smg', 'assault_rifle'], enemies: [{ pos: [0, -6] }], rng: () => 0 });
    sim.switchGun(1); // raise the assault rifle
    let early = false;
    for (const e of sim.step(0.1, input())) if (e.kind === 'fire') early = true; // 0.1s < SWAP_TIME
    expect(early).toBe(false);
    let fired = false;
    for (let i = 0; i < 8 && !fired; i++) for (const e of sim.step(0.1, input())) if (e.kind === 'fire') fired = true;
    expect(fired).toBe(true); // once the raise time passes, it fires
  });

  it('nextWeapon cycles through the loadout', () => {
    const sim = new FpsSim({ loadout: ['assault_rifle', 'sidearm'], enemies: [], rng: () => 0 });
    expect(sim.activeSlot).toBe(0);
    sim.nextWeapon(); expect(sim.activeSlot).toBe(1);
    sim.nextWeapon(); expect(sim.activeSlot).toBe(0);
  });

  it('a reload refills only the active weapon', () => {
    const sim = new FpsSim({ loadout: ['sidearm', 'smg'], enemies: [{ pos: [0, -100] }], rng: () => 0 });
    sim.ammo = 0;
    sim.startReload();
    sim.step(sim.gun.reloadTime + 0.05, input({ firing: false }));
    expect(sim.ammo).toBe(12); // sidearm refilled
    sim.switchGun(1);
    expect(sim.ammo).toBe(30);  // smg still full, untouched by the reload
  });

  it('resetEncounter returns you to the primary with both weapons full', () => {
    const sim = new FpsSim({ loadout: ['assault_rifle', 'sidearm'], enemies: [{ pos: [0, -100] }], rng: () => 0 });
    for (let i = 0; i < 3; i++) sim.step(0.2, input());
    sim.switchGun(1); sim.ammo = 2;
    sim.resetEncounter();
    expect(sim.activeSlot).toBe(0);
    expect(sim.gun.id).toBe('assault_rifle');
    expect(sim.ammo).toBe(24);
    sim.switchGun(1);
    expect(sim.ammo).toBe(12);
  });
});

describe('FpsSim attachments', () => {
  it('starts with none, toggles on then off, and announces each change', () => {
    const sim = new FpsSim({ gunId: 'assault_rifle', enemies: [], rng: () => 0 });
    expect(sim.hasAttachment('laser')).toBe(false);
    expect(sim.toggleAttachment('laser')).toBe(true);
    expect(sim.hasAttachment('laser')).toBe(true);
    const on = sim.drain().find((e) => e.kind === 'attachment');
    expect(on).toMatchObject({ kind: 'attachment', id: 'laser', on: true });
    expect(sim.toggleAttachment('laser')).toBe(false);
    expect(sim.hasAttachment('laser')).toBe(false);
  });

  it('seeds attachments fitted at op start (NVG in the Rift)', () => {
    const sim = new FpsSim({ gunId: 'smg', attachments: ['nvg'], enemies: [], rng: () => 0 });
    expect(sim.hasAttachment('nvg')).toBe(true);
    expect(sim.snapshot().attachments).toContain('nvg');
  });

  it('the laser tightens HIP-fire but does nothing while aimed', () => {
    const sim = new FpsSim({ gunId: 'assault_rifle', enemies: [], rng: () => 0 });
    const hipOff = sim.spreadFor(0, false, false);
    const adsOff = sim.spreadFor(1, false, false);
    sim.toggleAttachment('laser');
    expect(sim.spreadFor(0, false, false)).toBeLessThan(hipOff); // hip is tighter
    expect(sim.spreadFor(1, false, false)).toBeCloseTo(adsOff, 6); // aimed is unchanged
  });

  it('the optic tightens AIMED fire but does nothing at the hip', () => {
    const sim = new FpsSim({ gunId: 'assault_rifle', enemies: [], rng: () => 0 });
    const hipOff = sim.spreadFor(0, false, false);
    const adsOff = sim.spreadFor(1, false, false);
    sim.toggleAttachment('optic');
    expect(sim.spreadFor(1, false, false)).toBeLessThan(adsOff); // aimed is tighter
    expect(sim.spreadFor(0, false, false)).toBeCloseTo(hipOff, 6); // hip is unchanged
  });
});

describe('FpsSim survival waves', () => {
  const arena = () => new FpsSim({
    gunId: 'assault_rifle',
    enemies: Array.from({ length: 10 }, (_, i) => ({ pos: [i - 5, -6] as [number, number] })),
    rng: () => 0.5, respawnEnabled: false,
  });

  it('despawnAll clears the field WITHOUT counting kills', () => {
    const sim = arena();
    const kills = sim.snapshot().stats.kills;
    sim.despawnAll();
    expect(sim.aliveCount()).toBe(0);
    expect(sim.snapshot().stats.kills).toBe(kills);              // not counted as kills
    for (const e of sim.getEnemies()) expect(e.deadAt).toBeLessThan(0); // marked hidden
  });

  it('startWave revives exactly `count` slots with scaled, woken enemies', () => {
    const sim = arena();
    sim.despawnAll();
    expect(sim.startWave(4, 1.5)).toBe(4);
    expect(sim.aliveCount()).toBe(4);
    const alive = sim.getEnemies().filter((e) => e.alive);
    expect(alive.every((e) => e.active)).toBe(true);
    expect(alive[0].maxHp).toBe(Math.round(FPS_TUNING.DEFAULT_ENEMY_HP * 1.5));
    expect(alive[0].hp).toBe(alive[0].maxHp);
  });

  it('startWave never spawns more than the pool holds', () => {
    const sim = arena();
    sim.despawnAll();
    expect(sim.startWave(50, 1)).toBe(10);
    expect(sim.aliveCount()).toBe(10);
  });
});

// ── A2: the varied objective verbs (defend reinforcements, rescue hostage) ──
describe('FpsSim defend reinforcements', () => {
  function defendSim() {
    return new FpsSim({
      gunId: 'assault_rifle', respawnEnabled: false, rng: () => 0.5,
      enemies: [
        { pos: [-1, -6], room: 1 }, { pos: [1, -6], room: 1 },   // front foothold
        { pos: [-2, -10], room: 2 }, { pos: [2, -10], room: 2 }, // reinforcement pool
      ],
    });
  }

  it('reinforce revives ONLY dead enemies of the named room', () => {
    const sim = defendSim();
    for (const e of sim.getEnemies()) if (e.room === 2) { e.alive = false; e.hp = 0; }
    const n = sim.reinforce(2, 5);
    expect(n).toBe(2);                                             // both room-2 slots, nothing more
    const room2 = sim.getEnemies().filter((e) => e.room === 2);
    expect(room2.every((e) => e.alive && e.active)).toBe(true);
    // room-1 enemies were alive and untouched
    expect(sim.getEnemies().filter((e) => e.room === 1).every((e) => e.alive)).toBe(true);
  });

  it('reinforce leaves a still-living room alone (nothing to revive)', () => {
    const sim = defendSim();
    expect(sim.reinforce(2, 5)).toBe(0);
    expect(sim.aliveCount()).toBe(4);
  });
});

describe('FpsSim rescue hostage', () => {
  function rescueSim() {
    return new FpsSim({ gunId: 'assault_rifle', enemies: [{ pos: [0, -12] }], hostage: [0, -8], respawnEnabled: false, rng: () => 0.5 });
  }
  const at = (x: number, z: number): FpsInput => input({ firing: false, origin: [x, 1.6, z], dir: FWD });

  it('the hostage waits until rescued, then trails the player', () => {
    const sim = rescueSim();
    const start = { ...sim.snapshot().hostage! };
    // not rescued: stays put even as the player moves around
    sim.step(0.1, at(3, -8));
    expect(sim.snapshot().hostage!.x).toBeCloseTo(start.x, 5);
    expect(sim.snapshot().hostage!.rescued).toBe(false);
    // rescue, then walk away — the hostage closes the gap and follows
    sim.rescueHostage();
    expect(sim.snapshot().hostage!.rescued).toBe(true);
    for (let i = 0; i < 60; i++) sim.step(0.1, at(0, 6)); // player walks toward extract
    const h = sim.snapshot().hostage!;
    expect(h.z).toBeGreaterThan(start.z);              // moved toward the player's new side
    expect(Math.hypot(h.x - 0, h.z - 6)).toBeLessThan(3); // trailing within the follow gap
  });

  it('a reset un-rescues the hostage and returns them to the mark', () => {
    const sim = rescueSim();
    sim.rescueHostage();
    for (let i = 0; i < 20; i++) sim.step(0.1, at(0, 6));
    sim.resetEncounter();
    const h = sim.snapshot().hostage!;
    expect(h.rescued).toBe(false);
    expect([h.x, h.z]).toEqual([0, -8]);
  });
});

describe('FpsSim survival re-arm (B1)', () => {
  it('revive brings the player back at full HP and clears the swarm', () => {
    const sim = new FpsSim({ gunId: 'smg', enemies: [{ pos: [0, -6] }, { pos: [1, -6] }], rng: () => 0 });
    sim.playerHp = 0; sim.playerAlive = false;
    sim.revive();
    expect(sim.playerAlive).toBe(true);
    expect(sim.playerHp).toBe(FPS_TUNING.PLAYER_HP);
    expect(sim.aliveCount()).toBe(0); // the swarm that downed you is cleared for a fair restart
  });

  it('revive is a no-op while the player is still alive', () => {
    const sim = new FpsSim({ gunId: 'smg', enemies: [{ pos: [0, -6] }], rng: () => 0 });
    sim.playerHp = 40;
    sim.revive();
    expect(sim.playerHp).toBe(40);           // health untouched
    expect(sim.aliveCount()).toBe(1);        // enemy not cleared
  });

  it('resupply heals to full and refills ammo, and is a no-op if dead', () => {
    const sim = new FpsSim({ gunId: 'smg', enemies: [], rng: () => 0 });
    sim.playerHp = 30;
    sim.ammo = 1;
    sim.resupply();
    expect(sim.playerHp).toBe(FPS_TUNING.PLAYER_HP);
    expect(sim.ammo).toBe(sim.gun.magazine); // topped off
    // dead → must revive first, resupply does nothing
    sim.playerAlive = false; sim.playerHp = 0;
    sim.resupply();
    expect(sim.playerHp).toBe(0);
  });
});

describe('FpsSim loadout mods (B: equipped ammo + attachments)', () => {
  const TORSO: Vec3 = [0, -0.6, -6]; // a clean body shot on the enemy at (0,-6)

  function shotDamage(sim: FpsSim): number {
    const hit = sim.step(1 / 60, input({ dir: TORSO })).find((e) => e.kind === 'hit') as { damage: number } | undefined;
    return hit?.damage ?? 0;
  }

  it('an extended magazine raises the carried gun capacity', () => {
    const base = new FpsSim({ gunId: 'assault_rifle', enemies: [{ pos: [0, -6] }], rng: () => 0 });
    const modded = new FpsSim({ gunId: 'assault_rifle', gunMods: { magazine: 'extended_mag' }, enemies: [{ pos: [0, -6] }], rng: () => 0 });
    expect(modded.gun.magazine).toBe(base.gun.magazine + 10);
  });

  it('hollow point ammo increases per-shot damage vs standard FMJ', () => {
    const std = new FpsSim({ gunId: 'assault_rifle', enemies: [{ pos: [0, -6] }], rng: () => 0 });
    const hp = new FpsSim({ gunId: 'assault_rifle', ammoId: 'hollow_point', enemies: [{ pos: [0, -6] }], rng: () => 0 });
    expect(shotDamage(hp)).toBeGreaterThan(shotDamage(std));
  });

  it('incendiary rounds keep burning a target after you stop firing', () => {
    const sim = new FpsSim({ gunId: 'sidearm', ammoId: 'incendiary', enemies: [{ pos: [0, -6], hp: 500 }], rng: () => 0, respawnEnabled: false });
    shotDamage(sim); // one incendiary hit — enemy is tanky, survives the round
    const enemy = sim.getEnemies()[0];
    expect(enemy.alive).toBe(true);
    const afterShot = enemy.hp;
    for (let i = 0; i < 180; i++) sim.step(1 / 60, input({ firing: false })); // ~3s, no more shots
    expect(enemy.hp).toBeLessThan(afterShot); // burn ate health on its own
  });

  it('standard ammo never applies a burn', () => {
    const sim = new FpsSim({ gunId: 'sidearm', enemies: [{ pos: [0, -6], hp: 500 }], rng: () => 0, respawnEnabled: false });
    shotDamage(sim);
    const enemy = sim.getEnemies()[0];
    const afterShot = enemy.hp;
    for (let i = 0; i < 180; i++) sim.step(1 / 60, input({ firing: false }));
    expect(enemy.hp).toBe(afterShot); // no DoT with FMJ
  });
});

describe('FpsSim crit (the marketplace CRIT stat is now real)', () => {
  const TORSO: Vec3 = [0, -0.6, -6];

  it('a crit multiplies damage by the gun critMult and flags the hit', () => {
    // rng=0 → the crit roll (rng < critChance) always passes; rng=0.99 never does.
    const critSim = new FpsSim({ gunId: 'assault_rifle', enemies: [{ pos: [0, -6], hp: 1000 }], rng: () => 0, respawnEnabled: false });
    const cHit = critSim.step(1 / 60, input({ dir: TORSO })).find((e) => e.kind === 'hit') as { damage: number; crit: boolean };
    const noSim = new FpsSim({ gunId: 'assault_rifle', enemies: [{ pos: [0, -6], hp: 1000 }], rng: () => 0.99, respawnEnabled: false });
    const nHit = noSim.step(1 / 60, input({ dir: TORSO })).find((e) => e.kind === 'hit') as { damage: number; crit: boolean };

    expect(cHit.crit).toBe(true);
    expect(nHit.crit).toBe(false);
    expect(cHit.damage).toBeCloseTo(nHit.damage * getGun('assault_rifle').critMult, 1);
  });
});
