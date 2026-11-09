/**
 * @module fps/convoy
 * @description Builds a convoy-raid Mission from a contract's parameters.
 *
 * The economy decides WHAT the convoy is (cargo, how well the owning faction
 * defends it, where); this file turns that into playable mission data for the
 * existing FPS engine. It is pure and seeded: the same contract always produces
 * the same mission, so the server can recompute exactly what the player faced.
 *
 * The map comes from the contract's SITE (a place in the world the target holds:
 * Dustline Depot, Blacksite, Cinder Yard). The hour sets the CONDITIONS there:
 * lighting, how far guards see and how well they shoot, how fast relief arrives,
 * and whether night vision is issued. The clock never moves the objective.
 *
 *   RAID      breach → clear → push in → SECURE the cargo cases (E) → EXTRACT
 *   SABOTAGE  breach → PLANT charge one (E) → push in → PLANT charge two → EXTRACT
 *   RECOVERY  breach → push in → RETRIEVE the seized case (E) → HANDOVER
 *
 * Contracts from before sites were bound play where their old zone said.
 */

import type { CoverBox, EnemySpec } from './index';
import type { GunId } from '../combat/GunStats';
import type { Mission } from './campaign';
import { mulberry32 } from './endless';
import { LEVELS, levelForZone, type LevelDef, type LevelId, type Rect } from './levels';
import { buildField, practiceManifest, type FieldManifest } from './field';

export type Resource = 'ammo' | 'med' | 'fuel';
export type ConvoyZone = 'DUSTLINE' | 'REDYARD' | 'BLACKSITE';

/** A squad as the economy armed it: rifle guards and cheaper sidearm guards. */
export interface Squad { rifles: number; sidearms: number }

/** The server's guard plan for a raid (apps/api/crates/economy/src/mission.rs). */
export interface GuardPlan {
  hall: Squad;
  yard: Squad;
  guard_hp: number;
  /** A sidearm guard's damage relative to a rifle guard, in basis points. */
  sidearm_damage_bp: number;
  /** Guards per reinforcement drop during the hold (0 when the faction has no medicine). */
  reinforce_per_drop: number;
  reinforce_every_secs_x100: number;
}

export type OpKind = 'raid' | 'sabotage' | 'recovery';

export interface ConvoyContract {
  /** What the operation is (default raid). */
  kind?: OpKind;
  /** Stable raid id; also the default seed source. */
  id: string;
  /** Who is paying a bounty on this depot, if anyone. */
  issuer?: string;
  /** Faction whose depot is being raided. */
  target: string;
  cargo: { resource: Resource; units: number };
  /** The target's defense posture, 1 (light) … 5 (fortified). Set by its commander. */
  defense: number;
  /** Seed for escort placement. */
  seed: number;
  /** Time of day / theme. Defaults to DUSTLINE. */
  zone?: ConvoyZone;
  /** The guards the faction could actually arm. When absent (training), escorts come
   *  from `defense` alone via `convoyDifficulty`. */
  guards?: GuardPlan;
  /** Where it happens (the server's `site_json`). Absent: the old zone rule. */
  site?: SiteRef;
  /** What the hour does there (the server's `conditions`). */
  conditions?: SiteConditions;
  /** The physical objects (the server's `field_manifest`). Absent: built locally. */
  field?: FieldManifest;
}

export interface SiteRef {
  id: string; name: string; region?: string; environment?: string; owner?: string;
  layout: LevelId; shared_layout?: boolean; facility: string; exfil: string;
}

export type Phase = 'day' | 'dusk' | 'night';
export interface SiteConditions {
  phase: Phase; hour?: number; lighting?: string; sight_m: number; accuracy_bp: number; reinforce_bp: number; nvg: boolean;
  patrol?: string; next_phase?: Phase; next_change_hour?: number; ticks_to_change?: number;
}

/** The lighting theme each phase uses (campaign ZONE_THEMES). */
export const PHASE_THEME: Record<Phase, string> = { day: 'DUSTLINE', dusk: 'REDYARD', night: 'BLACKSITE' };
export const ZONE_PHASE: Record<string, Phase> = { DUSTLINE: 'day', REDYARD: 'dusk', BLACKSITE: 'night' };

/** Conditions for practice, mirroring the server's `site::conditions`. */
export function conditionsFor(phase: Phase): SiteConditions {
  return phase === 'day' ? { phase, sight_m: 30, accuracy_bp: 10_000, reinforce_bp: 10_000, nvg: false, lighting: 'Full daylight', patrol: 'Day shift: full patrols, long sight lines' }
    : phase === 'dusk' ? { phase, sight_m: 26, accuracy_bp: 9_200, reinforce_bp: 8_000, nvg: false, lighting: 'Low sun, long shadows', patrol: 'Shift change: relief squads arrive faster' }
    : { phase, sight_m: 20, accuracy_bp: 8_000, reinforce_bp: 11_000, nvg: true, lighting: 'Dark: floodlights and lamps only', patrol: 'Night watch: short sight lines, slower to reinforce; NVG issued' };
}

/** Practice sites: the same places the server binds contracts to. */
export const PRACTICE_SITES: SiteRef[] = [
  { id: 'dustline-depot', name: 'Dustline Depot', owner: 'vanguard', layout: 'dustline_depot', facility: 'munitions warehouse', exfil: "Vex's flatbed at the south gate", environment: 'Outdoor logistics yard' },
  { id: 'blacksite', name: 'Blacksite', owner: 'vanguard', layout: 'blacksite', facility: 'armoury vault', exfil: 'landing zone outside the gate', environment: 'Fortified research facility' },
];

/** Names of the two charge targets on each map, by site. */
function chargeTargets(site: SiteRef | undefined, layout: LevelId): [string, string] {
  if (site?.id === 'cinder-yard') return ['refinery tanks', 'pump house'];
  return layout === 'blacksite' ? ['APC motor bay', 'server room'] : ['fuel depot', 'munitions line'];
}

export const RESOURCE_LABEL: Record<Resource, string> = {
  ammo: 'AMMUNITION',
  med: 'MEDICAL SUPPLIES',
  fuel: 'FUEL',
};

/** The depot cargo point (kept for callers that predate levels). */
export const CARGO_POINT: [number, number] = LEVELS.dustline_depot.points.cargo;

export const clampDefense = (d: number): number => Math.min(5, Math.max(1, Math.round(d)));

/** Escorts per room, escort HP, and hold pressure for a defense level. */
export function convoyDifficulty(defense: number) {
  const d = clampDefense(defense);
  return {
    hallEscorts: 2 + d,                      // 3 … 7
    yardEscorts: 3 + d,                      // 4 … 8
    escortHp: Math.round(100 * (1 + 0.12 * (d - 1))), // 100 … 148
    reinforceEvery: +(4.5 - 0.4 * d).toFixed(2),     // 4.1s … 2.5s
    reinforceCount: d >= 4 ? 3 : 2,
  };
}

/** Seconds to load: bigger cargo takes longer to load under fire. */
export function loadSeconds(units: number): number {
  return Math.min(20, Math.max(8, Math.round(8 + units / 25)));
}

function overlapsCover(x: number, z: number, cover: readonly CoverBox[], margin: number): boolean {
  return cover.some((c) => Math.abs(x - c.x) < c.w / 2 + margin && Math.abs(z - c.z) < c.d / 2 + margin);
}

/** Seeded guard placement in a room's zones, clear of all geometry and of each
 *  other. Each entry of `loadouts` is one guard's damage multiplier (1 = rifle). */
function placeEscorts(room: 1 | 2, zones: readonly Rect[], loadouts: number[], hp: number, geometry: readonly CoverBox[], rng: () => number): EnemySpec[] {
  const out: EnemySpec[] = [];
  for (let tries = 0; out.length < loadouts.length && tries < 800; tries++) {
    const b = zones[Math.floor(rng() * zones.length)];
    const x = b.x[0] + rng() * (b.x[1] - b.x[0]);
    const z = b.z[0] + rng() * (b.z[1] - b.z[0]);
    if (overlapsCover(x, z, geometry, 1.0)) continue;
    if (out.some((e) => Math.hypot(e.pos[0] - x, e.pos[1] - z) < 2.4)) continue;
    const dmgMult = loadouts[out.length];
    out.push({ pos: [+x.toFixed(2), +z.toFixed(2)], room, hp, ...(dmgMult !== 1 ? { dmgMult } : {}) });
  }
  return out;
}

const squadLoadouts = (s: Squad, sidearmMult: number): number[] =>
  [...Array(s.rifles).fill(1), ...Array(s.sidearms).fill(sidearmMult)];

/** Escorts and hold pressure: from the server's guard plan, or from defense alone. */
export function escortsFor(c: ConvoyContract) {
  if (c.guards) {
    const g = c.guards;
    const side = g.sidearm_damage_bp / 10_000;
    return {
      hall: squadLoadouts(g.hall, side),
      yard: squadLoadouts(g.yard, side),
      hp: g.guard_hp,
      reinforceEvery: g.reinforce_every_secs_x100 / 100,
      reinforceCount: g.reinforce_per_drop,
    };
  }
  const d = convoyDifficulty(c.defense);
  return {
    hall: Array(d.hallEscorts).fill(1),
    yard: Array(d.yardEscorts).fill(1),
    hp: d.escortHp,
    reinforceEvery: d.reinforceEvery,
    reinforceCount: d.reinforceCount,
  };
}

interface Setting {
  lv: LevelDef;
  night: boolean;
  theme: string;
  site?: SiteRef;
  cond: SiteConditions;
  place: string;
  label: string;
  esc: ReturnType<typeof escortsFor>;
  reinforceEvery: number;
}

function setting(c: ConvoyContract): Setting {
  const layout: LevelId = c.site?.layout ?? levelForZone(c.zone ?? 'DUSTLINE');
  const lv = LEVELS[layout];
  const cond = c.conditions ?? conditionsFor(ZONE_PHASE[c.zone ?? 'DUSTLINE'] ?? 'day');
  const esc = escortsFor(c);
  return {
    lv, cond, site: c.site, esc,
    night: cond.phase === 'night',
    theme: PHASE_THEME[cond.phase],
    place: c.site?.name ?? (layout === 'blacksite' ? 'Blacksite' : 'Dustline Depot'),
    label: RESOURCE_LABEL[c.cargo.resource],
    reinforceEvery: +(esc.reinforceEvery * cond.reinforce_bp / 10_000).toFixed(2),
  };
}

function fieldFor(c: ConvoyContract, kind: OpKind, st: Setting) {
  const m = c.field ?? practiceManifest(kind, c.cargo.units, c.defense);
  return buildField(kind, st.lv.field, m, {
    charges: st.lv.points.charges,
    chargeTargets: chargeTargets(st.site, st.lv.id),
    cargoLabel: st.label,
    exfilLabel: st.site?.exfil ?? (st.lv.id === 'blacksite' ? 'landing zone outside the gate' : 'the flatbed at the south gate'),
    handoverLabel: kind === 'recovery' && st.site ? st.site.exfil : `${c.issuer ?? 'the owner'}'s truck`,
  });
}

function shell(c: ConvoyContract, st: Setting, gun: GunId, kind: OpKind) {
  const geometry = [...st.lv.walls, ...st.lv.cover];
  const rng = mulberry32(c.seed >>> 0);
  return {
    zone: st.theme,
    level: st.lv.id,
    gun,
    start: st.lv.start,
    walls: [...st.lv.walls],
    cover: [...st.lv.cover],
    enemies: [
      ...placeEscorts(1, st.lv.rooms[1], st.esc.hall, st.esc.hp, geometry, rng),
      ...placeEscorts(2, st.lv.rooms[2], st.esc.yard, st.esc.hp, geometry, rng),
    ],
    attachments: st.cond.nvg ? (['nvg'] as Mission['attachments']) : undefined,
    field: fieldFor(c, kind, st),
    reserveMags: 3,
    medkits: 1,
    conditions: { phase: st.cond.phase, engageRange: st.cond.sight_m, enemyAccuracy: st.cond.accuracy_bp / 10_000 },
    site: { id: st.site?.id ?? st.lv.id, name: st.place, facility: st.site?.facility ?? '', exfil: st.site?.exfil ?? '' },
  };
}

const cinder = (st: Setting) => st.site?.id === 'cinder-yard';
const entryObj = (st: Setting) => (cinder(st) ? 'HIT THE YARD GATE' : st.lv.id === 'blacksite' ? 'BREACH THE COURTYARD' : 'HIT THE MOTOR POOL');
const clearObj = (st: Setting) => (cinder(st) ? 'CLEAR THE GATE YARD' : st.lv.id === 'blacksite' ? 'CLEAR THE COURTYARD' : 'CLEAR THE MOTOR POOL');
const pushObj = (st: Setting) => (cinder(st) ? 'CROSS INTO THE TANK FARM' : st.lv.id === 'blacksite' ? 'ENTER THE FACILITY' : 'CROSS INTO THE YARD');

export function buildConvoyMission(c: ConvoyContract, gun: GunId = 'assault_rifle' as GunId): Mission {
  const st = setting(c);
  const p = st.lv.points;
  const base = shell(c, st, gun, 'raid');
  const cases = base.field.items.filter((i) => i.kind === 'cargo_case').length;
  const where = st.site?.facility ? `the ${st.site.facility}` : st.lv.id === 'blacksite' ? 'the vault' : 'the depot warehouse';
  return {
    ...base,
    id: `contract-${c.id}`,
    op: c.issuer ? `CONTRACT · ${c.issuer.toUpperCase()}` : `RAID · ${c.target.toUpperCase()}`,
    name: `${st.label} · ${st.place.toUpperCase()}`,
    brief: `raid ${c.target} at ${st.place} · secure ${c.cargo.units} ${st.label.toLowerCase()} in ${cases} case${cases === 1 ? '' : 's'} · extract`,
    story: `${c.target} has ${c.cargo.units} units of ${st.label.toLowerCase()} in ${where} at ${st.place}, packed in ${cases} case${cases === 1 ? '' : 's'}. ${st.esc.hall.length} guards on the outer zone, ${st.esc.yard.length} inside.${c.issuer ? ` ${c.issuer} is paying a bounty on it.` : ''} Carry out what you can; only what reaches the extraction counts.`,
    objectives: [
      { text: entryObj(st), kind: 'reach', pos: p.entry, activateRoom: 1, beats: ['opBreach'] },
      { text: clearObj(st), kind: 'clear', room: 1, pos: p.entry, beats: ['troopsCleared', 'rivalFirstWord'] },
      { text: pushObj(st), kind: 'reach', pos: p.push, activateRoom: 2, beats: ['opPushIn'] },
      {
        text: `SECURE THE ${st.label}`, kind: 'secure', pos: p.cargo, holdSecs: loadSeconds(c.cargo.units),
        reinforceRoom: 2, reinforceEvery: st.reinforceEvery, reinforceCount: st.esc.reinforceCount,
      },
      { text: 'EXTRACT WITH THE CARGO', kind: 'extract', pos: base.field.exfil!.pos, reinforceRoom: 2, reinforceEvery: st.reinforceEvery * 1.6, reinforceCount: st.esc.reinforceCount },
    ],
  };
}

/** Seconds to plant one charge. Matches CHARGE_SECS on the server. */
export const PLANT_SECS = 5;

/**
 * SABOTAGE: knock out the faction's production line. Two charges on two real targets,
 * no need to clear anyone (stealth pays), then get clear before the fuse runs out.
 * The server destroys the stock and halts that production for 36 hours on success.
 */
export function buildSabotageMission(c: ConvoyContract, gun: GunId = 'assault_rifle' as GunId): Mission {
  const st = setting(c);
  const p = st.lv.points;
  const base = shell(c, st, gun, 'sabotage');
  const [a, b] = chargeTargets(st.site, st.lv.id);
  const label = st.label.toLowerCase();
  return {
    ...base,
    id: `sabotage-${c.id}`,
    op: c.issuer ? `CONTRACT · ${c.issuer.toUpperCase()}` : `SABOTAGE · ${c.target.toUpperCase()}`,
    name: `SABOTAGE · ${st.place.toUpperCase()}`,
    brief: `plant charges on the ${a} and the ${b} · knock out ${c.target}'s ${label} production · get clear`,
    story: `${c.issuer ?? 'A sponsor'} wants ${c.target}'s ${label} line at ${st.place} down. Set one charge on the ${a} and one on the ${b}. The fuse is short once the second is set. You don't have to fight them all, just get out before they work out what you did.`,
    objectives: [
      { text: entryObj(st), kind: 'reach', pos: p.entry, activateRoom: 1, beats: ['opBreach'] },
      { text: `PLANT CHARGE · ${a.toUpperCase()}`, kind: 'plant', item: 'charge-1', pos: p.charges[0], beats: ['rivalFirstWord'] },
      { text: pushObj(st), kind: 'reach', pos: p.push, activateRoom: 2, beats: ['opPushIn'] },
      { text: `PLANT CHARGE · ${b.toUpperCase()}`, kind: 'plant', item: 'charge-2', pos: p.charges[1], reinforceRoom: 2, reinforceEvery: st.reinforceEvery, reinforceCount: st.esc.reinforceCount },
      { text: 'GET CLEAR · EXTRACT', kind: 'extract', pos: base.field.exfil!.pos, reinforceRoom: 2, reinforceEvery: st.reinforceEvery * 1.4, reinforceCount: st.esc.reinforceCount },
    ],
  };
}

/**
 * RECOVERY: a faction seized a merchant caravan; bring the cargo back to its owner.
 * The one seized case sits where the faction holds such things, has to be freed
 * under fire, and is handed over to the owner's people at their vehicle.
 */
export function buildRecoveryMission(c: ConvoyContract, gun: GunId = 'assault_rifle' as GunId): Mission {
  const st = setting(c);
  const p = st.lv.points;
  const base = shell(c, st, gun, 'recovery');
  const owner = c.issuer ?? 'the owner';
  const held = st.site?.facility ?? (st.lv.id === 'blacksite' ? 'control room' : 'container yard');
  return {
    ...base,
    id: `recovery-${c.id}`,
    op: c.issuer ? `CONTRACT · ${c.issuer.toUpperCase()}` : `RECOVERY · ${c.target.toUpperCase()}`,
    name: `RECOVERY · ${st.place.toUpperCase()}`,
    brief: `find ${owner}'s seized ${st.label.toLowerCase()} in the ${held} · carry it out · hand it over`,
    story: `${c.target} took ${owner}'s caravan on the road: ${c.cargo.units} units of ${st.label.toLowerCase()}, sealed in one case and held in the ${held} at ${st.place}. It's heavy. ${owner} pays when it is back in their hands at ${base.field.exfil!.label}.`,
    objectives: [
      { text: entryObj(st), kind: 'reach', pos: p.entry, activateRoom: 1, beats: ['opBreach'] },
      { text: pushObj(st), kind: 'reach', pos: p.push, activateRoom: 2, beats: ['rivalFirstWord', 'opPushIn'] },
      { text: `RETRIEVE THE SEIZED ${st.label}`, kind: 'retrieve', item: 'seized-case', pos: st.lv.field.seized, reinforceRoom: 2, reinforceEvery: st.reinforceEvery, reinforceCount: st.esc.reinforceCount },
      { text: `DELIVER TO ${owner.toUpperCase()}`, kind: 'extract', pos: base.field.exfil!.pos, reinforceRoom: 2, reinforceEvery: st.reinforceEvery * 1.6, reinforceCount: st.esc.reinforceCount },
    ],
  };
}

/** The mission for any operation kind. */
export function buildOperationMission(c: ConvoyContract, gun?: GunId): Mission {
  return c.kind === 'sabotage' ? buildSabotageMission(c, gun) : c.kind === 'recovery' ? buildRecoveryMission(c, gun) : buildConvoyMission(c, gun);
}
