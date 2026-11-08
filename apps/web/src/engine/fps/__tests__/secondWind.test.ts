import { describe, it, expect } from 'vitest';
import { FpsSim, FPS_TUNING, type FpsInput, type Vec3 } from '../FpsSim';

const EYE: Vec3 = [0, 1.6, 0];

function input(over: Partial<FpsInput> = {}): FpsInput {
  return { firing: false, wantReload: false, origin: EYE, dir: [0, 0, -1], adsFactor: 0, moving: false, crouched: false, ...over };
}

/** Put the player on the deck, the way a firefight does. */
function downed() {
  const sim = new FpsSim({ gunId: 'sidearm', enemies: [{ pos: [0, -6] }], rng: () => 0.5 });
  sim.debugKillPlayer();
  sim.step(1 / 60, input());
  return sim;
}

describe('secondWind', () => {
  it('puts a downed player back on full health', () => {
    const sim = downed();
    expect(sim.snapshot().playerAlive).toBe(false);
    sim.secondWind();
    const s = sim.snapshot();
    expect(s.playerAlive).toBe(true);
    expect(s.playerHp).toBe(FPS_TUNING.PLAYER_HP);
  });

  it('leaves the fight standing — unlike the paid revive, which clears it', () => {
    const wind = downed();
    const before = wind.getEnemies().filter((e) => e.alive).length;
    wind.secondWind();
    expect(wind.getEnemies().filter((e) => e.alive).length).toBe(before);

    // The survival re-arm you pay G$ for is the one that wipes the swarm.
    const paid = downed();
    paid.revive();
    expect(paid.getEnemies().filter((e) => e.alive).length).toBe(0);
  });

  it('grants a moment of grace, so you are not cut down by the same burst', () => {
    const sim = downed();
    sim.secondWind();
    const hp = sim.snapshot().playerHp;
    // Enemy fire during the mercy window cannot touch you.
    for (let i = 0; i < 30; i++) sim.step(1 / 60, input());
    expect(sim.snapshot().playerHp).toBe(hp);
    expect(sim.snapshot().playerAlive).toBe(true);
  });

  it('does nothing to a player who is already up', () => {
    const sim = new FpsSim({ gunId: 'sidearm', enemies: [], rng: () => 0.5 });
    sim.step(1 / 60, input());
    const before = sim.snapshot().playerHp;
    sim.secondWind();
    expect(sim.snapshot().playerHp).toBe(before);
  });

  it('is repeatable — the budget is the scene\'s to spend, not the sim\'s', () => {
    const sim = downed();
    sim.secondWind();
    sim.debugKillPlayer();
    sim.step(1 / 60, input());
    expect(sim.snapshot().playerAlive).toBe(false);
    sim.secondWind();
    expect(sim.snapshot().playerAlive).toBe(true);
  });
});
