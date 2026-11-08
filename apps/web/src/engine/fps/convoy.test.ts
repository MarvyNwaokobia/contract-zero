import { describe, it, expect } from 'vitest';
import { buildConvoyMission, convoyDifficulty, loadSeconds, CARGO_POINT, type ConvoyContract } from './convoy';
import type { CoverBox } from './index';

const base: ConvoyContract = {
  id: 'c-001', issuer: 'Vex Exchange', target: 'Vanguard', cargo: { resource: 'fuel', units: 120 }, defense: 2, seed: 42,
};

function inside(px: number, pz: number, b: CoverBox, margin: number): boolean {
  return Math.abs(px - b.x) < b.w / 2 + margin && Math.abs(pz - b.z) < b.d / 2 + margin;
}

describe('convoy mission', () => {
  it('is deterministic for the same contract', () => {
    expect(buildConvoyMission(base)).toEqual(buildConvoyMission(base));
  });

  it('places escorts differently for a different seed', () => {
    const a = buildConvoyMission(base).enemies.map((e) => e.pos);
    const b = buildConvoyMission({ ...base, seed: 7 }).enemies.map((e) => e.pos);
    expect(a).not.toEqual(b);
  });

  it('runs intercept → clear → push → load → extract', () => {
    const m = buildConvoyMission(base);
    expect(m.objectives.map((o) => o.kind)).toEqual(['reach', 'clear', 'reach', 'defend', 'reach']);
    const load = m.objectives[3];
    expect(load.pos).toEqual(CARGO_POINT);
    expect(load.holdSecs).toBe(loadSeconds(120));
    expect(m.objectives[4].pos).toEqual(m.start); // walk the cargo back out
  });

  it('spawns every escort clear of walls and cover', () => {
    for (let defense = 1; defense <= 5; defense++) {
      for (const seed of [1, 2, 3, 99, 12345]) {
        const m = buildConvoyMission({ ...base, defense, seed });
        for (const e of m.enemies) {
          for (const b of [...m.walls, ...m.cover]) {
            expect(inside(e.pos[0], e.pos[1], b, 0.3), `${e.pos} in ${JSON.stringify(b)}`).toBe(false);
          }
        }
      }
    }
  });

  it('keeps the start and the cargo point clear of geometry', () => {
    const m = buildConvoyMission(base);
    for (const p of [m.start, CARGO_POINT]) {
      for (const b of [...m.walls, ...m.cover]) expect(inside(p[0], p[1], b, 0.4)).toBe(false);
    }
  });

  it('fields the full escort for each defense level', () => {
    for (let defense = 1; defense <= 5; defense++) {
      const d = convoyDifficulty(defense);
      const m = buildConvoyMission({ ...base, defense });
      expect(m.enemies.filter((e) => e.room === 1)).toHaveLength(d.hallEscorts);
      expect(m.enemies.filter((e) => e.room === 2)).toHaveLength(d.yardEscorts);
    }
  });

  it('gets strictly harder as defense rises, and clamps out-of-range input', () => {
    for (let d = 1; d < 5; d++) {
      const lo = convoyDifficulty(d), hi = convoyDifficulty(d + 1);
      expect(hi.hallEscorts + hi.yardEscorts).toBeGreaterThan(lo.hallEscorts + lo.yardEscorts);
      expect(hi.escortHp).toBeGreaterThan(lo.escortHp);
      expect(hi.reinforceEvery).toBeLessThan(lo.reinforceEvery);
    }
    expect(convoyDifficulty(0)).toEqual(convoyDifficulty(1));
    expect(convoyDifficulty(99)).toEqual(convoyDifficulty(5));
  });

  it('bounds the load time', () => {
    expect(loadSeconds(0)).toBe(8);
    expect(loadSeconds(100_000)).toBe(20);
  });

  it('fits NVG on night convoys only', () => {
    expect(buildConvoyMission(base).attachments).toBeUndefined();
    expect(buildConvoyMission({ ...base, zone: 'BLACKSITE' }).attachments).toEqual(['nvg']);
  });
});

describe('convoy mission from the server guard plan', () => {
  const plan = {
    hall: { rifles: 1, sidearms: 2 }, yard: { rifles: 4, sidearms: 0 },
    guard_hp: 112, sidearm_damage_bp: 4500, reinforce_per_drop: 0, reinforce_every_secs_x100: 370,
  };

  it('fields exactly the guards the faction could arm, with their loadouts', () => {
    const m = buildConvoyMission({ ...base, guards: plan });
    const hall = m.enemies.filter((e) => e.room === 1);
    const yard = m.enemies.filter((e) => e.room === 2);
    expect(hall).toHaveLength(3);
    expect(yard).toHaveLength(4);
    expect(hall.filter((e) => e.dmgMult === 0.45)).toHaveLength(2);
    expect(yard.every((e) => e.dmgMult === undefined)).toBe(true);
    expect(m.enemies.every((e) => e.hp === 112)).toBe(true);
  });

  it('sends no reinforcements when the faction has no medicine', () => {
    const load = buildConvoyMission({ ...base, guards: plan }).objectives[3];
    expect(load.reinforceCount).toBe(0);
    expect(load.reinforceEvery).toBe(3.7);
  });

  it('can field no guards at all when the faction has no ammunition', () => {
    const empty = { ...plan, hall: { rifles: 0, sidearms: 0 }, yard: { rifles: 0, sidearms: 0 } };
    expect(buildConvoyMission({ ...base, guards: empty }).enemies).toHaveLength(0);
  });
});
