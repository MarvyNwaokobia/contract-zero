/**
 * @module fps/field
 * @description The physical side of an operation: things on the map you act on with
 * E, what you carry, and how you leave.
 *
 * Pure and frame-rate independent, so it is tested without a renderer. The scene
 * feeds it the player's position, view and the interact key each frame, and turns
 * the events it returns into sim calls (ammunition, dressings), radio and audio.
 *
 * Interactions are typed definitions, not per-mission code. Each one has a kind, a
 * position, a reach, a hold time and its contents:
 *
 * | Kind | Hold | Effect |
 * |---|---|---|
 * | `ammo_crate` | 0.8s | rounds into matching weapons, up to their cap; the rest stay |
 * | `med_case` | 0.8s | field dressings, up to the carry limit |
 * | `pouch` | 0.4s | a dead guard's spare magazine |
 * | `cargo_case` | 2s | one case of the depot's cargo, carried (slows you) |
 * | `seized_case` | 3s | the recovery's one case, carried |
 * | `charge` | 5s | a sabotage charge set on its target |
 * | `exfil` | 1s | calls extraction; then hold the zone for the countdown |
 *
 * Rules that decide what counts:
 *  - Cargo counts only once it leaves through a completed extraction. Going down
 *    drops what you carry where you fell (it can be picked up again); a run that
 *    ends in death secures nothing.
 *  - Extraction needs something to extract: a case for a raid, the seized case for
 *    a recovery, both charges for a sabotage.
 *  - Leaving the zone pauses the countdown and it bleeds back at half speed until
 *    you return. Going down cancels it.
 *  - The record the server receives names objects by id; the server owns the units.
 */

import { type AmmoClass } from './FpsSim';
import type { GunId } from '../combat/GunStats';
import type { FieldLayout, ExfilSpot } from './levels';

export type OpKind = 'raid' | 'sabotage' | 'recovery';

// Mirrors apps/api/crates/economy/src/mission.rs.
export const UNITS_PER_CASE = 25;
export const MAX_CASES = 4;
export const CASE_SECS = 2.0;
export const CHARGE_SECS = 5.0;
export const RETRIEVE_SECS = 3.0;
export const EXTRACT_SECS = 8.0;
/** Rounds in one "magazine" of loose ammunition in a crate. */
export const ROUNDS_PER_QTY = 30;
/** Cases one operator can carry at once. */
export const CARRY_MAX = 3;
/** Movement lost per carried case, and for the heavier seized case. */
export const CASE_SLOW = 0.1;
export const SEIZED_SLOW = 0.2;
/** Seconds between the second charge and the blast. */
export const FUSE_SECS = 12;
export const BLAST_RADIUS = 7;
/** Reach and view cone for interactions. */
export const REACH = 2.2;
export const VIEW_DOT = 0.72;

export interface CargoCase { id: string; units: number }
export interface FieldContainer { id: string; kind: 'ammo' | 'med' | string; qty: number }
/** The server's list of an operation's objects (`field_manifest`). */
export interface FieldManifest { cases: CargoCase[]; charges: string[]; containers: FieldContainer[] }

/** The same list for practice, computed locally the way the server would. */
export function practiceManifest(kind: OpKind, units: number, defense: number): FieldManifest {
  const split = (u: number, prefix: string): CargoCase[] => {
    const n = Math.min(MAX_CASES, Math.max(1, Math.ceil(u / UNITS_PER_CASE)));
    return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i + 1}`, units: Math.floor(u / n) + (i < u % n ? 1 : 0) }));
  };
  const ammo = 1 + Math.min(3, Math.max(0, 4 - Math.round(defense / 2)));
  return {
    cases: kind === 'raid' ? split(units, 'case') : kind === 'recovery' ? [{ id: 'seized-case', units }] : [],
    charges: kind === 'sabotage' ? ['charge-1', 'charge-2'] : [],
    containers: [
      ...Array.from({ length: ammo }, (_, i) => ({ id: `ammo-${i + 1}`, kind: 'ammo', qty: 3 })),
      ...Array.from({ length: 2 }, (_, i) => ({ id: `med-${i + 1}`, kind: 'med', qty: 2 })),
    ],
  };
}

export type InteractKind = 'ammo_crate' | 'med_case' | 'pouch' | 'cargo_case' | 'seized_case' | 'charge' | 'exfil' | 'weapon';

export interface Interactable {
  id: string;
  kind: InteractKind;
  pos: [number, number];
  /** Height of the thing, for the line-of-sight check and the prompt. */
  y: number;
  holdSecs: number;
  label: string;
  state: 'idle' | 'carried' | 'done' | 'empty';
  ammoClass?: AmmoClass;
  rounds?: number;
  medkits?: number;
  units?: number;
  /** A charge's target, shown in the prompt ("FUEL DEPOT"). */
  target?: string;
  /** A weapon on the ground: which, its rounds, and whose it was. Battlefield
   *  weapons are temporary: they exist only for this run and are never settled. */
  gun?: GunId;
  mag?: number;
  reserve?: number;
  origin?: 'enemy' | 'player';
  /** Where physics left it lying (height and orientation), for drawing. */
  pose?: { y: number; q: [number, number, number, number] };
}

export interface ExfilZone extends ExfilSpot {
  /** "extraction" or "handover". */
  mode: 'extract' | 'handover';
  label: string;
  secs: number;
}

export interface FieldSpec {
  kind: OpKind | 'training';
  items: Interactable[];
  exfil: ExfilZone | null;
  /** Resource label for the cargo HUD ("AMMUNITION"). */
  cargoLabel?: string;
  /** Sabotage charge targets in order (labels for objectives). */
  charges?: { id: string; pos: [number, number]; target: string }[];
}

/** Place a manifest on a level. Cases sit at the cargo point; supplies where the
 *  level keeps them; charges on the two named targets. */
export function buildField(kind: OpKind, layout: FieldLayout, m: FieldManifest, o: {
  charges: [[number, number], [number, number]]; chargeTargets: [string, string]; cargoLabel: string; exfilLabel: string; handoverLabel: string;
}): FieldSpec {
  const items: Interactable[] = [];
  m.cases.forEach((c, i) => {
    if (kind === 'recovery') {
      items.push({ id: c.id, kind: 'seized_case', pos: layout.seized, y: 0.5, holdSecs: RETRIEVE_SECS, label: `SEIZED ${o.cargoLabel}`, state: 'idle', units: c.units });
    } else {
      const slot = layout.cases[i % layout.cases.length];
      items.push({ id: c.id, kind: 'cargo_case', pos: slot, y: 0.4, holdSecs: CASE_SECS, label: `${o.cargoLabel} CASE · ${c.units} UNITS`, state: 'idle', units: c.units });
    }
  });
  const charges = m.charges.map((id, i) => ({ id, pos: o.charges[i % 2], target: o.chargeTargets[i % 2] }));
  for (const c of charges) items.push({ id: c.id, kind: 'charge', pos: c.pos, y: 1.0, holdSecs: CHARGE_SECS, label: `PLANT CHARGE · ${c.target.toUpperCase()}`, state: 'idle', target: c.target });
  let a = 0, md = 0;
  m.containers.forEach((c, i) => {
    if (c.kind === 'ammo') {
      const pos = layout.ammo[a++ % layout.ammo.length];
      // Alternate rifle and pistol crates so either weapon finds rounds.
      const cls: AmmoClass = i % 2 === 0 ? 'rifle' : 'pistol';
      items.push({ id: c.id, kind: 'ammo_crate', pos, y: 0.45, holdSecs: 0.8, label: cls === 'rifle' ? 'RIFLE AMMUNITION' : 'PISTOL AMMUNITION', state: 'idle', ammoClass: cls, rounds: c.qty * ROUNDS_PER_QTY });
    } else {
      const pos = layout.med[md++ % layout.med.length];
      items.push({ id: c.id, kind: 'med_case', pos, y: 0.45, holdSecs: 0.8, label: 'MEDICAL CASE', state: 'idle', medkits: c.qty });
    }
  });
  const spot = kind === 'recovery' ? layout.handover : layout.exfil;
  const exfil: ExfilZone = { ...spot, mode: kind === 'recovery' ? 'handover' : 'extract', label: kind === 'recovery' ? o.handoverLabel : o.exfilLabel, secs: EXTRACT_SECS };
  items.push({ id: 'exfil', kind: 'exfil', pos: spot.pos, y: 1.0, holdSecs: 1.0, label: kind === 'recovery' ? 'SIGNAL THE HANDOVER' : 'CALL EXTRACTION', state: 'idle' });
  return { kind, items, exfil, cargoLabel: o.cargoLabel, charges };
}

/** A training compound's field: its extract objective becomes a real zone. */
export function trainingField(extractAt: [number, number] | null): FieldSpec {
  if (!extractAt) return { kind: 'training', items: [], exfil: null };
  return {
    kind: 'training',
    items: [{ id: 'exfil', kind: 'exfil', pos: extractAt, y: 1.0, holdSecs: 0.6, label: 'CALL EXTRACTION', state: 'idle' }],
    exfil: { pos: extractAt, radius: 3.5, lz: true, mode: 'extract', label: 'extraction point', secs: 5 },
  };
}

// ── Runtime ───────────────────────────────────────────────────────────────────

export type FieldEvent =
  | { kind: 'ammo'; id: string; cls: AmmoClass; rounds: number; left: number }
  | { kind: 'med'; id: string; taken: number; left: number }
  | { kind: 'full'; id: string; what: 'ammo' | 'med' | 'cargo' }
  | { kind: 'secured'; id: string; carried: number }
  | { kind: 'planted'; id: string; planted: number; total: number }
  | { kind: 'detonation'; at: [number, number][] }
  | { kind: 'extractCalled' }
  | { kind: 'extractLeft' }
  | { kind: 'extracted'; carried: string[] }
  | { kind: 'dropped'; ids: string[] }
  | { kind: 'weapon'; id: string; gun: GunId; mag: number; reserve: number; swapped: GunId | null; ammoOnly: boolean }
  | { kind: 'refused'; why: string };

/** What the scene lends the runtime: the sim's inventory. */
export interface Pockets {
  reserveRoom(cls: AmmoClass): number;
  addReserve(cls: AmmoClass, rounds: number): number;
  addMedkit(): boolean;
  /** Battlefield weapons (optional: the scene's sim has them). */
  readonly loadout?: GunId[];
  takeWeapon?(id: GunId, mag: number, reserve: number): { id: GunId; mag: number; reserve: number };
}

/** Which rounds a gun takes (mirrors FpsSim.ammoClassOf, kept local to stay pure). */
const roundsFor = (g: GunId): AmmoClass => (g === 'sidearm' || g === 'smg' ? 'pistol' : 'rifle');

export interface ViewState { x: number; z: number; eyeY: number; yaw: number; pitch: number }

/** One event of the mission protocol the server checks (apps/api/src/services/protocol.rs).
 *  `t` is game time in ms; `seq` is added by whoever sends them. */
export type ProtoEvent =
  | { kind: 'pos'; t: number; pos: [number, number] }
  | { kind: 'reach'; t: number; pos: [number, number]; milestone: 'entry' | 'push' }
  | { kind: 'hold_start' | 'collect' | 'retrieve' | 'plant' | 'loot'; t: number; pos: [number, number]; object: string }
  | { kind: 'down' | 'extract_call' | 'extract_complete'; t: number; pos: [number, number] };

/** The record a completion reports: object ids only. */
export interface FieldRecord { secured: string[]; charges: string[]; delivered: string | null; looted: string[] }

export type ExfilPhase = 'locked' | 'ready' | 'counting' | 'done';

/** Interactions the server's mission protocol knows about. */
const REPORTED = new Set<InteractKind>(['cargo_case', 'seized_case', 'charge', 'ammo_crate', 'med_case']);

export class FieldRuntime {
  readonly spec: FieldSpec;
  readonly items: Map<string, Interactable>;
  carried: string[] = [];
  planted: string[] = [];
  looted = new Set<string>();
  delivered: string | null = null;
  secured: string[] = [];
  exfilPhase: ExfilPhase = 'locked';
  exfilProgress = 0;
  private wasInside = true;
  fuseAt = -1;
  detonated = false;
  /** Current interaction target and how long E has been held on it. */
  target: Interactable | null = null;
  hold = 0;
  private pouchSeq = 0;
  private time = 0;
  /** Set when the mission's objective flow allows extraction to be called. */
  exfilAllowed = false;
  /** Protocol events for the server, drained by the scene each frame. */
  log: ProtoEvent[] = [];
  private lastPos: [number, number] = [0, 0];

  /** Game time in ms, as the protocol reports it. */
  get ms(): number { return Math.round(this.time * 1000); }
  /** Note an event at the player's last known position (milestones, heartbeats). */
  note(kind: 'pos'): void;
  note(kind: 'reach', milestone: 'entry' | 'push'): void;
  note(kind: 'pos' | 'reach', milestone?: 'entry' | 'push'): void {
    if (kind === 'reach' && milestone) this.log.push({ kind, milestone, t: this.ms, pos: this.lastPos });
    else this.log.push({ kind: 'pos', t: this.ms, pos: this.lastPos });
  }

  constructor(spec: FieldSpec) {
    this.spec = spec;
    this.items = new Map(spec.items.map((i) => [i.id, { ...i }]));
  }

  /** Cases (and the seized case) in hand. */
  get carriedUnits(): number {
    return this.carried.reduce((n, id) => n + (this.items.get(id)?.units ?? 0), 0);
  }
  get cases(): Interactable[] {
    return [...this.items.values()].filter((i) => i.kind === 'cargo_case' || i.kind === 'seized_case');
  }
  get allChargesPlanted(): boolean {
    const n = this.spec.charges?.length ?? 0;
    return n > 0 && this.planted.length >= n;
  }
  /** Movement multiplier from what you carry. */
  get speedMult(): number {
    let m = 1;
    for (const id of this.carried) m -= this.items.get(id)?.kind === 'seized_case' ? SEIZED_SLOW : CASE_SLOW;
    return Math.max(0.6, m);
  }

  /** Whether extraction has something to extract. */
  canExtract(): boolean {
    switch (this.spec.kind) {
      case 'raid': return this.carried.length > 0;
      case 'recovery': return this.carried.some((id) => this.items.get(id)?.kind === 'seized_case');
      case 'sabotage': return this.allChargesPlanted;
      default: return true;
    }
  }
  private refusal(): string {
    switch (this.spec.kind) {
      case 'raid': return 'NOTHING TO EXTRACT · SECURE A CARGO CASE FIRST';
      case 'recovery': return 'BRING THE SEIZED CASE';
      case 'sabotage': return 'BOTH CHARGES FIRST';
      default: return '';
    }
  }

  private usable(i: Interactable): boolean {
    if (i.state !== 'idle') return false;
    if (i.kind === 'exfil') return this.exfilAllowed && this.exfilPhase === 'ready';
    return true;
  }

  /** The thing you're looking at within reach, with nothing solid in between. */
  pick(v: ViewState, losClear: (from: [number, number, number], to: [number, number, number]) => boolean): Interactable | null {
    const fx = -Math.sin(v.yaw) * Math.cos(v.pitch), fy = Math.sin(v.pitch), fz = -Math.cos(v.yaw) * Math.cos(v.pitch);
    let best: Interactable | null = null, bestScore = -Infinity;
    for (const i of this.items.values()) {
      if (!this.usable(i)) continue;
      const dx = i.pos[0] - v.x, dz = i.pos[1] - v.z, dy = i.y - v.eyeY;
      const flat = Math.hypot(dx, dz);
      const reach = i.kind === 'exfil' ? (this.spec.exfil?.radius ?? REACH) : REACH;
      if (flat > reach) continue;
      const d = Math.hypot(dx, dy, dz) || 1e-3;
      const dot = (dx * fx + dy * fy + dz * fz) / d;
      // Standing on top of it counts; otherwise it has to be in front of you.
      if (flat > 0.9 && dot < VIEW_DOT && i.kind !== 'exfil') continue;
      if (flat > 0.9 && i.kind !== 'exfil' && !losClear([v.x, v.eyeY, v.z], [i.pos[0], i.y, i.pos[1]])) continue;
      const score = dot - flat * 0.15;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  /** One frame. `interact` is the E key (or the touch button) held. */
  update(dt: number, v: ViewState, interact: boolean, pockets: Pockets, losClear: (a: [number, number, number], b: [number, number, number]) => boolean): FieldEvent[] {
    this.time += dt;
    this.lastPos = [+v.x.toFixed(2), +v.z.toFixed(2)];
    const out: FieldEvent[] = [];
    if (this.exfilPhase === 'locked' && this.exfilAllowed) this.exfilPhase = 'ready';

    const t = this.pick(v, losClear);
    if (t !== this.target) { this.target = t; this.hold = 0; }
    if (t && interact) {
      // Things that can't take anything refuse at once rather than after a hold.
      const pre = this.precheck(t, pockets);
      if (pre) { if (this.hold === 0) out.push(pre); this.hold = 1e-6; }
      else {
        // Only objects of the server's manifest are reported; battlefield weapons and
        // magazines are local, and an id the server doesn't know would taint the run.
        if (this.hold === 0 && REPORTED.has(t.kind)) this.log.push({ kind: 'hold_start', object: t.id, t: Math.round((this.time - dt) * 1000), pos: this.lastPos });
        this.hold += dt;
        if (this.hold >= t.holdSecs) { this.hold = 0; out.push(...this.complete(t, pockets)); }
      }
    } else if (!interact) {
      this.hold = 0;
    }

    // The fuse, once both charges are set.
    if (this.fuseAt > 0 && !this.detonated && this.time >= this.fuseAt) {
      this.detonated = true;
      out.push({ kind: 'detonation', at: (this.spec.charges ?? []).map((c) => c.pos) });
    }

    // Extraction countdown: hold the zone.
    const z = this.spec.exfil;
    if (z && this.exfilPhase === 'counting') {
      const inside = Math.hypot(v.x - z.pos[0], v.z - z.pos[1]) <= z.radius;
      if (inside) this.exfilProgress += dt;
      else this.exfilProgress = Math.max(0, this.exfilProgress - dt * 0.5);
      if (!inside && this.wasInside) out.push({ kind: 'extractLeft' });
      this.wasInside = inside;
      if (this.exfilProgress >= z.secs) {
        this.exfilPhase = 'done';
        this.log.push({ kind: 'extract_complete', t: this.ms, pos: this.lastPos });
        this.secured = this.carried.filter((id) => this.items.get(id)?.kind === 'cargo_case');
        const seized = this.carried.find((id) => this.items.get(id)?.kind === 'seized_case');
        if (seized) this.delivered = seized;
        out.push({ kind: 'extracted', carried: this.carried.slice() });
      }
    }
    return out;
  }

  private precheck(t: Interactable, p: Pockets): FieldEvent | null {
    if (t.kind === 'ammo_crate' && t.ammoClass && p.reserveRoom(t.ammoClass) <= 0) return { kind: 'full', id: t.id, what: 'ammo' };
    if ((t.kind === 'cargo_case' || t.kind === 'seized_case') && this.carried.length >= CARRY_MAX) return { kind: 'full', id: t.id, what: 'cargo' };
    if (t.kind === 'exfil' && !this.canExtract()) return { kind: 'refused', why: this.refusal() };
    if (t.kind === 'weapon' && t.gun && p.loadout?.includes(t.gun) && p.reserveRoom(roundsFor(t.gun)) <= 0) return { kind: 'full', id: t.id, what: 'ammo' };
    return null;
  }

  private complete(t: Interactable, p: Pockets): FieldEvent[] {
    switch (t.kind) {
      case 'ammo_crate':
      case 'pouch': {
        const cls = t.ammoClass ?? 'rifle';
        const taken = p.addReserve(cls, t.rounds ?? 0);
        if (taken <= 0) return [{ kind: 'full', id: t.id, what: 'ammo' }];
        t.rounds = (t.rounds ?? 0) - taken;
        if (t.kind === 'ammo_crate') { this.looted.add(t.id); this.log.push({ kind: 'loot', object: t.id, t: this.ms, pos: this.lastPos }); }
        if ((t.rounds ?? 0) <= 0) t.state = 'empty';
        return [{ kind: 'ammo', id: t.id, cls, rounds: taken, left: t.rounds ?? 0 }];
      }
      case 'med_case': {
        let taken = 0;
        while ((t.medkits ?? 0) > 0 && p.addMedkit()) { t.medkits = (t.medkits ?? 0) - 1; taken++; }
        if (taken === 0) return [{ kind: 'full', id: t.id, what: 'med' }];
        this.looted.add(t.id);
        this.log.push({ kind: 'loot', object: t.id, t: this.ms, pos: this.lastPos });
        if ((t.medkits ?? 0) <= 0) t.state = 'empty';
        return [{ kind: 'med', id: t.id, taken, left: t.medkits ?? 0 }];
      }
      case 'cargo_case':
      case 'seized_case':
        t.state = 'carried';
        this.carried.push(t.id);
        this.log.push({ kind: t.kind === 'seized_case' ? 'retrieve' : 'collect', object: t.id, t: this.ms, pos: this.lastPos });
        return [{ kind: 'secured', id: t.id, carried: this.carried.length }];
      case 'charge':
        t.state = 'done';
        this.planted.push(t.id);
        this.log.push({ kind: 'plant', object: t.id, t: this.ms, pos: this.lastPos });
        if (this.allChargesPlanted) this.fuseAt = this.time + FUSE_SECS;
        return [{ kind: 'planted', id: t.id, planted: this.planted.length, total: this.spec.charges?.length ?? 0 }];
      case 'weapon': {
        const gun = t.gun!;
        const rounds = (t.mag ?? 0) + (t.reserve ?? 0);
        // The same gun you carry: take its rounds, leave the empty weapon.
        if (p.loadout?.includes(gun) || !p.takeWeapon) {
          const took = p.addReserve(roundsFor(gun), rounds);
          if (took <= 0) return [{ kind: 'full', id: t.id, what: 'ammo' }];
          const left = rounds - took;
          t.mag = Math.min(t.mag ?? 0, left);
          t.reserve = left - (t.mag ?? 0);
          if (left <= 0) t.state = 'empty';
          return [{ kind: 'weapon', id: t.id, gun, mag: 0, reserve: took, swapped: null, ammoOnly: true }];
        }
        // Otherwise swap: yours goes down where you stand, with what it has left.
        const old = p.takeWeapon(gun, t.mag ?? 0, t.reserve ?? 0);
        t.state = 'done';
        this.dropWeapon(this.lastPos[0] + 0.5, this.lastPos[1] + 0.3, old.id, old.mag, Number.isFinite(old.reserve) ? old.reserve : 0, 'player');
        return [{ kind: 'weapon', id: t.id, gun, mag: t.mag ?? 0, reserve: t.reserve ?? 0, swapped: old.id, ammoOnly: false }];
      }
      case 'exfil':
        this.exfilPhase = 'counting';
        this.exfilProgress = 0;
        this.log.push({ kind: 'extract_call', t: this.ms, pos: this.lastPos });
        this.wasInside = true;
        return [{ kind: 'extractCalled' }];
    }
  }

  /** The player went down: drop what's carried where they fell, cancel extraction. */
  down(x: number, z: number): FieldEvent[] {
    this.log.push({ kind: 'down', t: this.ms, pos: [+x.toFixed(2), +z.toFixed(2)] });
    const ids = this.carried.splice(0);
    ids.forEach((id, k) => {
      const i = this.items.get(id);
      if (!i) return;
      i.state = 'idle';
      i.pos = [x + Math.cos(k * 2.1) * 0.7, z + Math.sin(k * 2.1) * 0.7];
    });
    if (this.exfilPhase === 'counting') { this.exfilPhase = 'ready'; this.exfilProgress = 0; }
    return ids.length ? [{ kind: 'dropped', ids }] : [];
  }

  /** A weapon on the ground: a dead guard's, or one you swapped away. Temporary
   *  battlefield equipment; never in the record. */
  dropWeapon(x: number, z: number, gun: GunId, mag: number, reserve: number, origin: 'enemy' | 'player'): Interactable {
    const w: Interactable = { id: `weapon-${++this.pouchSeq}`, kind: 'weapon', pos: [x, z], y: 0.1, holdSecs: 0.6, label: gun, state: 'idle', gun, mag, reserve, origin };
    this.items.set(w.id, w);
    return w;
  }

  /** A dead guard's spare magazine. Not economic, so not in the record. */
  dropPouch(x: number, z: number, cls: AmmoClass, rounds: number): Interactable {
    const p: Interactable = { id: `pouch-${++this.pouchSeq}`, kind: 'pouch', pos: [x, z], y: 0.15, holdSecs: 0.4, label: `${cls === 'rifle' ? 'RIFLE' : 'PISTOL'} MAGAZINE`, state: 'idle', ammoClass: cls, rounds };
    this.items.set(p.id, p);
    return p;
  }

  record(): FieldRecord {
    return { secured: this.secured.slice(), charges: this.planted.slice(), delivered: this.delivered, looted: [...this.looted] };
  }
}
