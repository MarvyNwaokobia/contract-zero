import { describe, it, expect } from 'vitest';
import { CAMPAIGN, ZONE_THEMES, themeForMission, SURVIVAL_MISSION, GAUNTLET_MISSION, survivalWaveCount, survivalWaveHp, gauntletWaveCount, gauntletWaveHp } from './campaign';
import type { CoverBox } from './index';

// A spawned enemy / a standing objective marker must not overlap a wall or a
// cover block. 0.3 ≈ an enemy's body radius, so this flags a spawn that clips
// into geometry while still allowing enemies to hug cover.
const CLEAR = 0.3;

function inside(px: number, pz: number, b: CoverBox, margin: number): boolean {
  return Math.abs(px - b.x) < b.w / 2 + margin && Math.abs(pz - b.z) < b.d / 2 + margin;
}

describe('campaign geometry', () => {
  it('has 15 missions, 5 per zone, across 3 themed zones', () => {
    expect(CAMPAIGN).toHaveLength(15);
    const order = ['ASHFALL', 'PROVING GROUND', 'THE RIFT'];
    expect(Array.from(new Set(CAMPAIGN.map((m) => m.zone)))).toEqual(order);
    for (const z of order) {
      expect(CAMPAIGN.filter((m) => m.zone === z)).toHaveLength(5);
      expect(ZONE_THEMES[z]).toBeDefined();
    }
  });

  it('puts a boss on op 5, 10 and 15 and nowhere else', () => {
    expect(CAMPAIGN.map((m, i) => (m.boss ? i : -1)).filter((i) => i >= 0)).toEqual([4, 9, 14]);
  });

  it('gives each zone exactly one signature non-doorkicker op', () => {
    const verbs = (kind: string) => CAMPAIGN.filter((m) => m.objectives.some((o) => o.kind === kind));
    expect(verbs('defend').map((m) => m.zone)).toEqual(['ASHFALL']);
    expect(verbs('rescue').map((m) => m.zone)).toEqual(['PROVING GROUND']);
    expect(CAMPAIGN.filter((m) => m.blackout).map((m) => m.zone)).toEqual(['THE RIFT']);
  });

  for (const m of CAMPAIGN) {
    describe(`${m.id} (${m.zone})`, () => {
      const solids = [...m.walls, ...m.cover];

      it('spawns no enemy inside a wall or cover block', () => {
        for (const e of m.enemies) {
          const hit = solids.find((b) => inside(e.pos[0], e.pos[1], b, CLEAR));
          expect(hit, `enemy at [${e.pos}] overlaps box @[${hit?.x},${hit?.z}]`).toBeUndefined();
        }
      });

      it('keeps every objective marker on standable floor (walls only)', () => {
        for (const o of m.objectives) {
          const hit = m.walls.find((b) => inside(o.pos[0], o.pos[1], b, CLEAR));
          expect(hit, `objective "${o.text}" at [${o.pos}] is inside a wall`).toBeUndefined();
        }
      });

      it('starts the player in the open', () => {
        expect(solids.find((b) => inside(m.start[0], m.start[1], b, CLEAR))).toBeUndefined();
      });

      it('tags exactly one boss iff it is a boss op', () => {
        const bosses = m.enemies.filter((e) => e.boss);
        expect(bosses).toHaveLength(m.boss ? 1 : 0);
      });

      it('opens on a breach and ends on extract, using only valid verbs', () => {
        const kinds = m.objectives.map((o) => o.kind);
        expect(kinds[0], 'first objective is a breach reach').toBe('reach');
        expect(kinds[kinds.length - 1], 'last objective is an extract reach').toBe('reach');
        for (const k of kinds) expect(['reach', 'clear', 'defend', 'rescue']).toContain(k);
        expect(m.enemies.some((e) => e.room === 1)).toBe(true);
        expect(m.enemies.some((e) => e.room === 2)).toBe(true);
      });

      it('defend objectives declare a positive hold time and a reinforcement pool', () => {
        for (const o of m.objectives) {
          if (o.kind !== 'defend') continue;
          expect(o.holdSecs && o.holdSecs > 0, `${o.text} needs holdSecs`).toBeTruthy();
          const room = o.reinforceRoom ?? o.room ?? 0;
          expect(m.enemies.some((e) => e.room === room), `${o.text} has no reinforcements`).toBe(true);
        }
      });

      it('a rescue objective iff the op carries a hostage', () => {
        expect(m.objectives.some((o) => o.kind === 'rescue')).toBe(!!m.hostage);
        const hostage = m.hostage;
        if (hostage) {
          const hit = m.walls.find((b) => inside(hostage[0], hostage[1], b, CLEAR));
          expect(hit, `hostage at [${hostage}] is inside a wall`).toBeUndefined();
        }
      });
    });
  }
});

describe('day → night arc (A1)', () => {
  it('the first op of a zone keeps the tuned anchor theme', () => {
    const ash1 = CAMPAIGN.find((m) => m.id === 'ash-1')!;
    expect(themeForMission(ash1)).toEqual(ZONE_THEMES.ASHFALL);
  });

  it('later ops in a zone step the key light down and the ambient darker', () => {
    const zoneOps = CAMPAIGN.filter((m) => m.zone === 'ASHFALL');
    const first = themeForMission(zoneOps[0]);
    const last = themeForMission(zoneOps[zoneOps.length - 1]);
    expect(last.sun.intensity).toBeLessThan(first.sun.intensity);
    expect(last.ambient).toBeLessThan(first.ambient);
    expect(last.practicalIntensity).toBeGreaterThan(first.practicalIntensity); // lamps matter more at dusk
  });
});

describe('debrief', () => {
  it('every campaign op carries a story lead-in for the between-mission screen', () => {
    for (const m of CAMPAIGN) expect(m.story, `${m.id} has no story`).toBeTruthy();
  });
});

describe('survival mode', () => {
  it('escalates in size and toughness, capped at the pool', () => {
    expect(survivalWaveCount(1)).toBeLessThan(survivalWaveCount(5));
    expect(survivalWaveCount(100)).toBeLessThanOrEqual(10);
    expect(survivalWaveHp(1)).toBe(1);
    expect(survivalWaveHp(6)).toBeGreaterThan(survivalWaveHp(1));
  });

  it('is a themed arena with a full pool and no objectives', () => {
    expect(SURVIVAL_MISSION.survival).toBe(true);
    expect(ZONE_THEMES[SURVIVAL_MISSION.zone]).toBeDefined();
    expect(SURVIVAL_MISSION.enemies.length).toBe(10);
    expect(SURVIVAL_MISSION.objectives).toEqual([]);
  });

  it('places no spawn or the player start inside a wall or cover', () => {
    const solids = [...SURVIVAL_MISSION.walls, ...SURVIVAL_MISSION.cover];
    expect(solids.find((b) => inside(SURVIVAL_MISSION.start[0], SURVIVAL_MISSION.start[1], b, CLEAR))).toBeUndefined();
    for (const e of SURVIVAL_MISSION.enemies) {
      const hit = solids.find((b) => inside(e.pos[0], e.pos[1], b, CLEAR));
      expect(hit, `survival spawn [${e.pos}] overlaps a box`).toBeUndefined();
    }
  });
});

describe('gauntlet mode (B2 prestige)', () => {
  it('is a strictly harder curve than practice Survival', () => {
    for (const w of [1, 3, 6, 10]) {
      expect(gauntletWaveCount(w)).toBeGreaterThan(survivalWaveCount(w));
      expect(gauntletWaveHp(w)).toBeGreaterThanOrEqual(survivalWaveHp(w));
    }
    expect(gauntletWaveHp(10)).toBeGreaterThan(survivalWaveHp(10)); // steeper toughness
    expect(gauntletWaveCount(100)).toBeLessThanOrEqual(12);          // capped at its pool
  });

  it('is a ranked survival arena with a full pool and no objectives', () => {
    expect(GAUNTLET_MISSION.survival).toBe(true);
    expect(GAUNTLET_MISSION.gauntlet).toBe(true);
    expect(GAUNTLET_MISSION.enemies.length).toBe(12);
    expect(GAUNTLET_MISSION.objectives).toEqual([]);
    expect(ZONE_THEMES[GAUNTLET_MISSION.zone]).toBeDefined();
  });

  it('places no spawn or the player start inside a wall or cover', () => {
    const solids = [...GAUNTLET_MISSION.walls, ...GAUNTLET_MISSION.cover];
    expect(solids.find((b) => inside(GAUNTLET_MISSION.start[0], GAUNTLET_MISSION.start[1], b, CLEAR))).toBeUndefined();
    for (const e of GAUNTLET_MISSION.enemies) {
      const hit = solids.find((b) => inside(e.pos[0], e.pos[1], b, CLEAR));
      expect(hit, `gauntlet spawn [${e.pos}] overlaps a box`).toBeUndefined();
    }
  });
});
