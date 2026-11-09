import { describe, it, expect } from 'vitest';
import { FieldRuntime, type FieldEvent, buildField, practiceManifest, CARRY_MAX, CASE_SECS, CHARGE_SECS, EXTRACT_SECS, FUSE_SECS, type Pockets, type ViewState } from '../field';
import { LEVELS } from '../levels';
import { slideMove } from '../FpsSim';

const lv = LEVELS.dustline_depot;
const opts = { charges: lv.points.charges, chargeTargets: ['fuel depot', 'munitions line'] as [string, string], cargoLabel: 'AMMUNITION', exfilLabel: 'flatbed', handoverLabel: 'truck' };
const clear = () => true;

function pockets(room = 1000): Pockets & { rounds: number; kits: number } {
  return {
    rounds: 0, kits: 0,
    reserveRoom() { return room - this.rounds; },
    addReserve(_c, r) { const t = Math.min(r, room - this.rounds); this.rounds += t; return t; },
    addMedkit() { if (this.kits >= 3) return false; this.kits++; return true; },
  };
}
/** Stand on a point, looking at the floor in front. */
const at = (p: [number, number]): ViewState => ({ x: p[0], z: p[1] + 0.5, eyeY: 1.6, yaw: 0, pitch: -1 });
function holdOn(f: FieldRuntime, p: [number, number], secs: number, pk: Pockets) {
  const ev: FieldEvent[] = [];
  for (let t = 0; t < secs; t += 0.1) ev.push(...f.update(0.1, at(p), true, pk, clear));
  return ev;
}

describe('field placement', () => {
  it('every object on both maps stands clear of walls and inside the bounds', () => {
    for (const l of Object.values(LEVELS)) {
      const solid = [...l.walls, ...l.cover];
      const spots = [...l.field.cases, l.field.seized, ...l.field.ammo, ...l.field.med, l.field.exfil.pos, l.field.handover.pos];
      for (const [x, z] of spots) {
        expect(x > l.bounds.minX && x < l.bounds.maxX && z > l.bounds.minZ && z < l.bounds.maxZ, `${l.id} ${x},${z} in bounds`).toBe(true);
        const inside = solid.some((c) => Math.abs(x - c.x) < c.w / 2 + 0.3 && Math.abs(z - c.z) < c.d / 2 + 0.3);
        expect(inside, `${l.id} ${x},${z} clear of geometry`).toBe(false);
      }
    }
    expect(slideMove).toBeTypeOf('function');
  });
});

describe('raid cargo', () => {
  const m = practiceManifest('raid', 60, 2);
  it('splits the manifest into cases', () => {
    expect(m.cases.map((c) => c.units)).toEqual([20, 20, 20]);
  });

  it('cases need a deliberate hold, slow you, and only count once extracted', () => {
    const f = new FieldRuntime(buildField('raid', lv.field, m, opts));
    const pk = pockets();
    const c1 = f.items.get('case-1')!;
    // a tap is not enough
    f.update(0.3, at(c1.pos), true, pk, clear);
    f.update(0.1, at(c1.pos), false, pk, clear);
    expect(f.carried).toEqual([]);
    const ev = holdOn(f, c1.pos, CASE_SECS + 0.2, pk);
    expect(ev.some((e) => e.kind === 'secured')).toBe(true);
    expect(f.speedMult).toBeLessThan(1);
    expect(f.record().secured).toEqual([]); // carried is not secured
    // extraction: call it, then hold the zone
    f.exfilAllowed = true;
    const z = f.spec.exfil!;
    holdOn(f, z.pos, 1.2, pk);
    expect(f.exfilPhase).toBe('counting');
    for (let t = 0; t < EXTRACT_SECS + 0.3; t += 0.1) f.update(0.1, at(z.pos), false, pk, clear);
    expect(f.exfilPhase).toBe('done');
    expect(f.record().secured).toEqual(['case-1']);
  });

  it('refuses extraction with nothing to extract', () => {
    const f = new FieldRuntime(buildField('raid', lv.field, m, opts));
    f.exfilAllowed = true;
    const ev = holdOn(f, f.spec.exfil!.pos, 1.5, pockets());
    expect(ev.some((e) => e.kind === 'refused')).toBe(true);
    expect(f.exfilPhase).toBe('ready');
  });

  it('leaving the zone pauses and bleeds the countdown; going down cancels it and drops the cargo', () => {
    const f = new FieldRuntime(buildField('raid', lv.field, m, opts));
    const pk = pockets();
    holdOn(f, f.items.get('case-2')!.pos, CASE_SECS + 0.2, pk);
    f.exfilAllowed = true;
    const z = f.spec.exfil!;
    holdOn(f, z.pos, 1.2, pk);
    for (let t = 0; t < 4; t += 0.1) f.update(0.1, at(z.pos), false, pk, clear);
    const p = f.exfilProgress;
    const out = f.update(0.1, at([z.pos[0] + z.radius + 3, z.pos[1]]), false, pk, clear);
    expect(out.some((e) => e.kind === 'extractLeft')).toBe(true);
    for (let t = 0; t < 2; t += 0.1) f.update(0.1, at([z.pos[0] + z.radius + 3, z.pos[1]]), false, pk, clear);
    expect(f.exfilProgress).toBeLessThan(p);
    const dropped = f.down(5, 5);
    expect(dropped[0]).toMatchObject({ kind: 'dropped', ids: ['case-2'] });
    expect(f.carried).toEqual([]);
    expect(f.exfilPhase).toBe('ready');
    expect(f.items.get('case-2')!.state).toBe('idle'); // can be picked up again
  });

  it('carries at most CARRY_MAX cases', () => {
    const big = practiceManifest('raid', 100, 2);
    const f = new FieldRuntime(buildField('raid', lv.field, big, opts));
    const pk = pockets();
    for (const c of f.cases) holdOn(f, c.pos, CASE_SECS + 0.2, pk);
    expect(f.carried.length).toBe(CARRY_MAX);
  });
});

describe('supplies', () => {
  it('a crate gives what fits and keeps the rest; a medical case fills dressings', () => {
    const f = new FieldRuntime(buildField('raid', lv.field, practiceManifest('raid', 30, 2), opts));
    const pk = pockets(50);
    const crate = f.items.get('ammo-1')!;
    const ev = holdOn(f, crate.pos, 1, pk);
    expect(ev.find((e) => e.kind === 'ammo')).toMatchObject({ rounds: 50, left: 40 });
    expect(crate.state).toBe('idle');
    f.update(0.1, at(crate.pos), false, pk, clear);
    expect(holdOn(f, crate.pos, 1, pk).some((e) => e.kind === 'full')).toBe(true);
    const med = f.items.get('med-1')!;
    holdOn(f, med.pos, 1, pk);
    expect(pk.kits).toBe(2);
    expect(med.state).toBe('empty');
    expect(f.record().looted.sort()).toEqual(['ammo-1', 'med-1']);
  });

  it('a wall between you and the crate blocks it', () => {
    const f = new FieldRuntime(buildField('raid', lv.field, practiceManifest('raid', 30, 2), opts));
    const crate = f.items.get('ammo-1')!;
    const v: ViewState = { x: crate.pos[0], z: crate.pos[1] + 1.8, eyeY: 1.6, yaw: 0, pitch: -0.5 };
    expect(f.pick(v, () => false)).toBeNull();
    expect(f.pick(v, () => true)?.id).toBe('ammo-1');
  });
});

describe('sabotage and recovery', () => {
  it('both charges start the fuse, and only then can you extract', () => {
    const f = new FieldRuntime(buildField('sabotage', lv.field, practiceManifest('sabotage', 40, 2), opts));
    const pk = pockets();
    holdOn(f, lv.points.charges[0], CHARGE_SECS + 0.2, pk);
    expect(f.canExtract()).toBe(false);
    holdOn(f, lv.points.charges[1], CHARGE_SECS + 0.2, pk);
    expect(f.canExtract()).toBe(true);
    let boom = false;
    for (let t = 0; t < FUSE_SECS + 1; t += 0.1) boom ||= f.update(0.1, at([0, 0]), false, pk, clear).some((e) => e.kind === 'detonation');
    expect(boom).toBe(true);
    expect(f.record().charges).toEqual(['charge-1', 'charge-2']);
  });

  it('a recovery delivers the seized case at the handover', () => {
    const f = new FieldRuntime(buildField('recovery', lv.field, practiceManifest('recovery', 30, 2), opts));
    const pk = pockets();
    holdOn(f, lv.field.seized, 3.3, pk);
    expect(f.speedMult).toBeCloseTo(0.8);
    f.exfilAllowed = true;
    const z = f.spec.exfil!;
    expect(z.mode).toBe('handover');
    holdOn(f, z.pos, 1.2, pk);
    for (let t = 0; t < EXTRACT_SECS + 0.3; t += 0.1) f.update(0.1, at(z.pos), false, pk, clear);
    expect(f.record().delivered).toBe('seized-case');
  });
});

describe('protocol events for the server', () => {
  it('a take is preceded by its hold start, at the player position, in game time', () => {
    const f = new FieldRuntime(buildField('raid', lv.field, practiceManifest('raid', 60, 2), opts));
    const c = f.items.get('case-1')!;
    holdOn(f, c.pos, CASE_SECS + 0.2, pockets());
    const kinds = f.log.map((e) => e.kind);
    expect(kinds).toEqual(['hold_start', 'collect']);
    const [h, col] = f.log as { t: number; pos: [number, number]; object?: string }[];
    expect(col.t - h.t).toBeGreaterThanOrEqual(CASE_SECS * 1000);
    expect(h.object).toBe('case-1');
    expect(Math.hypot(h.pos[0] - c.pos[0], h.pos[1] - c.pos[1])).toBeLessThan(1);
  });
});

describe('battlefield weapons', () => {
  function armed(loadout: ('smg' | 'sidearm' | 'assault_rifle')[]) {
    const p = pockets() as ReturnType<typeof pockets> & { loadout: string[]; takeWeapon: (id: never, m: number, r: number) => { id: never; mag: number; reserve: number } };
    p.loadout = [...loadout];
    p.takeWeapon = (id, mag, reserve) => { const old = { id: p.loadout[0] as never, mag: 30, reserve: 60 }; p.loadout[0] = id; void mag; void reserve; return old; };
    return p;
  }

  it('a different gun swaps; yours is left on the ground with its rounds; nothing enters the record', () => {
    const f = new FieldRuntime(buildField('raid', lv.field, practiceManifest('raid', 30, 2), opts));
    const p = armed(['smg', 'sidearm']);
    const w = f.dropWeapon(0, 0, 'assault_rifle', 17, 24, 'enemy');
    const ev = holdOn(f, w.pos, 1, p as never);
    expect(ev.find((e) => e.kind === 'weapon')).toMatchObject({ gun: 'assault_rifle', swapped: 'smg', ammoOnly: false });
    expect(p.loadout[0]).toBe('assault_rifle');
    const left = [...f.items.values()].find((i) => i.kind === 'weapon' && i.origin === 'player');
    expect(left).toMatchObject({ gun: 'smg', mag: 30, reserve: 60, state: 'idle' });
    expect(f.record()).toEqual({ secured: [], charges: [], delivered: null, looted: [] });
    expect(f.log.some((e) => (e as { object?: string }).object === w.id)).toBe(false);
  });

  it('the same gun gives its rounds and stays on the ground until empty', () => {
    const f = new FieldRuntime(buildField('raid', lv.field, practiceManifest('raid', 30, 2), opts));
    const p = armed(['assault_rifle', 'sidearm']);
    const w = f.dropWeapon(0, 0, 'assault_rifle', 10, 24, 'enemy');
    const ev = holdOn(f, w.pos, 1, p as never);
    expect(ev.find((e) => e.kind === 'weapon')).toMatchObject({ ammoOnly: true, reserve: 34 });
    expect(p.rounds).toBe(34);
    expect(f.items.get(w.id)!.state).toBe('empty');
  });
});
