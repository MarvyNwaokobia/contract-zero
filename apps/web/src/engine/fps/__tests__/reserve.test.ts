import { describe, it, expect } from 'vitest';
import { FpsSim, FPS_TUNING, RESERVE_CAP_MAGS, MAX_MEDKITS, HEAL_SECS, HEAL_HP, type FpsInput } from '../FpsSim';

const idle = (over: Partial<FpsInput> = {}): FpsInput =>
  ({ firing: false, wantReload: false, origin: [0, 1.6, 0], dir: [0, 0, -1], adsFactor: 0, moving: false, crouched: false, ...over });

function emptyMag(s: FpsSim) {
  for (let i = 0; i < 400 && s.ammo > 0; i++) s.step(0.2, idle({ firing: i % 2 === 0, dir: [0, 1, 0] }));
}

describe('finite reserve ammunition', () => {
  it('a reload takes rounds from the reserve and stops when it is empty', () => {
    const s = new FpsSim({ gunId: 'sidearm', enemies: [], reserveMags: 1, rng: () => 0 });
    const mag = s.gun.magazine;
    expect(s.reserve).toBe(mag);
    emptyMag(s);
    for (let i = 0; i < 20; i++) s.step(0.2, idle()); // auto-reload completes
    expect(s.ammo).toBe(mag);
    expect(s.reserve).toBe(0);
    emptyMag(s);
    for (let i = 0; i < 20; i++) s.step(0.2, idle({ wantReload: true }));
    expect(s.ammo).toBe(0);
    expect(s.drain().some((e) => e.kind === 'noReserve')).toBe(true);
  });

  it('a partial magazine only draws what it needs', () => {
    const s = new FpsSim({ gunId: 'sidearm', enemies: [], reserveMags: 2, rng: () => 0 });
    const mag = s.gun.magazine;
    s.step(0.01, idle({ firing: true, dir: [0, 1, 0] }));
    s.step(0.01, idle());
    s.step(0.01, idle({ wantReload: true }));
    for (let i = 0; i < 20; i++) s.step(0.2, idle());
    expect(s.ammo).toBe(mag);
    expect(s.reserve).toBe(2 * mag - 1);
  });

  it('loot fills matching weapons up to a cap and leaves the rest', () => {
    const s = new FpsSim({ loadout: ['assault_rifle', 'sidearm'], enemies: [], reserveMags: 1 });
    const rifleMag = s.gun.magazine;
    const room = s.reserveRoom('rifle');
    expect(room).toBe((RESERVE_CAP_MAGS - 1) * rifleMag);
    expect(s.addReserve('rifle', 10_000)).toBe(room);
    expect(s.reserve).toBe(RESERVE_CAP_MAGS * rifleMag);
    expect(s.addReserve('rifle', 5)).toBe(0);
    expect(s.addReserve('pistol', 12)).toBe(12); // the sidearm takes pistol rounds
  });

  it('the arena modes keep an unlimited reserve', () => {
    const s = new FpsSim({ gunId: 'smg', enemies: [] });
    expect(s.reserve).toBe(Infinity);
    expect(s.addReserve('pistol', 30)).toBe(0);
  });
});

describe('field dressings', () => {
  it('heals after a delay, blocks firing meanwhile, and is capped', () => {
    const s = new FpsSim({ gunId: 'sidearm', enemies: [], medkits: 1 });
    expect(s.useMedkit()).toBe(false); // full health: nothing to dress
    s.playerHp = 30;
    expect(s.useMedkit()).toBe(true);
    expect(s.medkits).toBe(0);
    const before = s.ammo;
    s.step(0.1, idle({ firing: true }));
    expect(s.ammo).toBe(before);
    s.step(HEAL_SECS, idle());
    expect(s.playerHp).toBe(Math.min(FPS_TUNING.PLAYER_HP, 30 + HEAL_HP));
    for (let i = 0; i < MAX_MEDKITS; i++) expect(s.addMedkit()).toBe(true);
    expect(s.addMedkit()).toBe(false);
  });
});
