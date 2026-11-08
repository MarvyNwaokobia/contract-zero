/**
 * @module fps/convoy
 * @description Builds a convoy-raid Mission from a contract's parameters.
 *
 * The economy decides WHAT the convoy is (cargo, how well the owning faction
 * defends it, where); this file turns that into playable mission data for the
 * existing FPS engine. It is pure and seeded: the same contract always produces
 * the same mission, so the server can recompute exactly what the player faced.
 *
 * The level comes from the contract's zone (fps/levels): DUSTLINE and REDYARD play
 * the Dustline depot, BLACKSITE the night facility. Flow on either:
 *   1. BREACH                reach the entry point, wakes the outer guard (room 1)
 *   2. CLEAR                 kill the outer guard
 *   3. PUSH IN               reach the inner threshold, wakes the inner guard (room 2)
 *   4. LOAD THE CARGO        hold the cargo point while reinforcements come
 *   5. EXTRACT WITH CARGO    walk the cargo back out
 */

import type { CoverBox, EnemySpec } from './index';
import type { GunId } from '../combat/GunStats';
import type { Mission } from './campaign';
import { mulberry32 } from './endless';
import { LEVELS, levelForZone, type LevelDef, type Rect } from './levels';

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

export function buildConvoyMission(c: ConvoyContract, gun: GunId = 'assault_rifle' as GunId): Mission {
  const esc = escortsFor(c);
  const rng = mulberry32(c.seed >>> 0);
  const label = RESOURCE_LABEL[c.cargo.resource];
  const zone = c.zone ?? 'DUSTLINE';
  const lv: LevelDef = LEVELS[levelForZone(zone)];
  const p = lv.points;
  const geometry = [...lv.walls, ...lv.cover];
  const night = lv.id === 'blacksite';

  return {
    id: `contract-${c.id}`,
    zone,
    level: lv.id,
    op: c.issuer ? `CONTRACT · ${c.issuer.toUpperCase()}` : `RAID · ${c.target.toUpperCase()}`,
    name: night ? `${label} · BLACKSITE` : `${label} · DUSTLINE DEPOT`,
    brief: `raid ${c.target}'s ${night ? 'facility' : 'depot'} · load ${c.cargo.units} ${label.toLowerCase()} · extract`,
    story: night
      ? `${c.target} moved ${c.cargo.units} units of ${label.toLowerCase()} into the blacksite vault. ${esc.hall.length} guards hold the courtyard, ${esc.yard.length} the facility.${c.issuer ? ` ${c.issuer} is paying a bounty on it.` : ''} Get in, load it, walk it out.`
      : `${c.target} has ${c.cargo.units} units of ${label.toLowerCase()} staged in the depot warehouse. ${esc.hall.length} guards on the motor pool, ${esc.yard.length} in the yard.${c.issuer ? ` ${c.issuer} is paying a bounty on it.` : ''} Load it and drive it out the gate.`,
    gun,
    start: lv.start,
    walls: [...lv.walls],
    cover: [...lv.cover],
    enemies: [
      ...placeEscorts(1, lv.rooms[1], esc.hall, esc.hp, geometry, rng),
      ...placeEscorts(2, lv.rooms[2], esc.yard, esc.hp, geometry, rng),
    ],
    objectives: [
      { text: night ? 'BREACH THE COURTYARD' : 'HIT THE MOTOR POOL', kind: 'reach', pos: p.entry, activateRoom: 1 },
      { text: night ? 'CLEAR THE COURTYARD' : 'CLEAR THE MOTOR POOL', kind: 'clear', room: 1, pos: p.entry },
      { text: night ? 'ENTER THE FACILITY' : 'CROSS INTO THE YARD', kind: 'reach', pos: p.push, activateRoom: 2 },
      {
        text: `LOAD THE ${label}`, kind: 'defend', pos: p.cargo, holdSecs: loadSeconds(c.cargo.units),
        reinforceRoom: 2, reinforceEvery: esc.reinforceEvery, reinforceCount: esc.reinforceCount,
      },
      { text: 'EXTRACT WITH THE CARGO', kind: 'reach', pos: p.extract },
    ],
    attachments: night ? ['nvg'] : undefined,
  };
}

/** Seconds to plant one charge. Matches PLANT_SECS on the server. */
export const PLANT_SECS = 5;

/**
 * SABOTAGE: knock out the faction's production line. Two charges in two parts of the
 * site, no need to clear anyone (stealth pays), then get clear. The server destroys
 * the stock and halts that production for 36 hours on success.
 */
export function buildSabotageMission(c: ConvoyContract, gun: GunId = 'assault_rifle' as GunId): Mission {
  const base = buildConvoyMission(c, gun);
  const lv = LEVELS[base.level!];
  const p = lv.points;
  const night = lv.id === 'blacksite';
  const label = RESOURCE_LABEL[c.cargo.resource].toLowerCase();
  const esc = escortsFor(c);
  return {
    ...base,
    id: `sabotage-${c.id}`,
    name: night ? 'SABOTAGE · BLACKSITE' : 'SABOTAGE · DUSTLINE DEPOT',
    brief: `plant two charges · knock out ${c.target}'s ${label} production · get clear`,
    story: `${c.issuer ?? 'A sponsor'} wants ${c.target}'s ${label} line down. Plant one charge ${night ? 'on the APC motor bay' : 'at the fuel depot'} and one ${night ? 'in the server room' : 'on the munitions line inside the warehouse'}. You don't have to fight them all, just get out before they work out what you did.`,
    objectives: [
      { text: night ? 'BREACH THE COURTYARD' : 'HIT THE MOTOR POOL', kind: 'reach', pos: p.entry, activateRoom: 1 },
      { text: night ? 'PLANT CHARGE · MOTOR BAY' : 'PLANT CHARGE · FUEL DEPOT', kind: 'defend', pos: p.charges[0], holdSecs: PLANT_SECS },
      { text: night ? 'GET INSIDE' : 'CROSS INTO THE YARD', kind: 'reach', pos: p.push, activateRoom: 2 },
      { text: night ? 'PLANT CHARGE · SERVER ROOM' : 'PLANT CHARGE · MUNITIONS LINE', kind: 'defend', pos: p.charges[1], holdSecs: PLANT_SECS, reinforceRoom: 2, reinforceEvery: esc.reinforceEvery, reinforceCount: esc.reinforceCount },
      { text: 'GET CLEAR', kind: 'reach', pos: p.extract },
    ],
  };
}

/**
 * RECOVERY: a faction seized a merchant caravan; bring the cargo back to its owner.
 * The cargo sits somewhere else on the site, has to be secured under fire, and is
 * handed over to the owner's people, not walked out the way you came.
 */
export function buildRecoveryMission(c: ConvoyContract, gun: GunId = 'assault_rifle' as GunId): Mission {
  const base = buildConvoyMission(c, gun);
  const lv = LEVELS[base.level!];
  const p = lv.points;
  const night = lv.id === 'blacksite';
  const label = RESOURCE_LABEL[c.cargo.resource];
  const esc = escortsFor(c);
  const owner = c.issuer ?? 'the owner';
  return {
    ...base,
    id: `recovery-${c.id}`,
    name: night ? 'RECOVERY · BLACKSITE' : 'RECOVERY · DUSTLINE DEPOT',
    brief: `find ${owner}'s seized ${label.toLowerCase()} · secure it · hand it over`,
    story: `${c.target} took ${owner}'s caravan on the road: ${c.cargo.units} units of ${label.toLowerCase()}, now held ${night ? 'in the control room' : 'in the container yard'}. ${owner} pays when it is back in their hands${night ? ' at the gate' : ', at their truck by the east fence'}.`,
    objectives: [
      { text: night ? 'BREACH THE COURTYARD' : 'HIT THE MOTOR POOL', kind: 'reach', pos: p.entry, activateRoom: 1 },
      { text: night ? 'GET INSIDE' : 'CROSS INTO THE YARD', kind: 'reach', pos: p.push, activateRoom: 2 },
      { text: `SECURE THE ${label}`, kind: 'defend', pos: p.cache, holdSecs: loadSeconds(c.cargo.units), reinforceRoom: 2, reinforceEvery: esc.reinforceEvery, reinforceCount: esc.reinforceCount },
      { text: `DELIVER TO ${owner.toUpperCase()}`, kind: 'reach', pos: p.handover },
    ],
  };
}

/** The mission for any operation kind. */
export function buildOperationMission(c: ConvoyContract, gun?: GunId): Mission {
  return c.kind === 'sabotage' ? buildSabotageMission(c, gun) : c.kind === 'recovery' ? buildRecoveryMission(c, gun) : buildConvoyMission(c, gun);
}
