// Turns economic numbers into gameplay language.
//
// Rule: a sentence appears here only if the engine really does it (see rules.ts for the
// source of each threshold). Nothing is a UI-only threshold. Every statement carries the
// exact `factors` it was computed from, so the advanced view can show the numbers.

import type { GuardPlan, ResourceName, WarActor } from '@/lib/api'
import { LOGISTICS_FUEL, STAGING_FUEL, DEFENSE_COST, armGuards, plannedGuards, reinforcements, spendable } from './rules'

export type Severity = 'ok' | 'warn' | 'critical'
export type Readiness = 'operational' | 'under_pressure' | 'supply_critical' | 'rebuilding'

export interface Factor { label: string; value: string }
export interface Statement {
  /** Which pillar this belongs to: the four relationships players learn. */
  topic: 'ammo' | 'med' | 'fuel' | 'credits'
  severity: Severity
  /** Short caps headline, e.g. "LOW AMMUNITION". */
  headline: string
  /** What it means in the field. */
  effect: string
  /** The exact figures behind it. */
  factors: Factor[]
}

export const READINESS_LABEL: Record<Readiness, string> = {
  operational: 'Operational',
  under_pressure: 'Under Pressure',
  supply_critical: 'Supply Critical',
  rebuilding: 'Rebuilding',
}

const n = (x: number) => x.toLocaleString('en-US')
const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`

/** Ammunition → armed guards. `ammo` is what is available to arm them. */
export function ammoStatement(defense: number, ammo: number, note?: string): Statement {
  const planned = plannedGuards(defense)
  const { rifles, sidearms } = armGuards(planned, ammo)
  const deployed = rifles + sidearms
  const factors: Factor[] = [
    { label: 'Ammunition available', value: n(ammo) },
    { label: 'Guards the defense level calls for', value: String(planned) },
    { label: 'Armed with rifles / sidearms', value: `${rifles} / ${sidearms}` },
    ...(note ? [{ label: 'Note', value: note }] : []),
  ]
  if (deployed === 0) return { topic: 'ammo', severity: 'critical', headline: 'AMMUNITION EXHAUSTED', effect: 'No guard can be armed, so none deploy.', factors }
  const home = planned - deployed
  if (sidearms > 0 || home > 0) {
    const bits = [`${plural(rifles, 'rifle guard')}`, sidearms > 0 ? plural(sidearms, 'sidearm guard') : ''].filter(Boolean).join(' and ')
    return { topic: 'ammo', severity: 'warn', headline: 'LOW AMMUNITION', effect: `Patrols under-equipped: ${bits}${home > 0 ? `; ${plural(home, 'guard')} stay home unarmed` : ''}.`, factors }
  }
  return { topic: 'ammo', severity: 'ok', headline: 'AMMUNITION SUFFICIENT', effect: `All ${planned} guards carry rifles.`, factors }
}

/** Medicine → reinforcements during a raid. */
export function medStatement(defense: number, med: number, requirement: number): Statement {
  const drop = reinforcements(med, requirement, defense)
  const factors: Factor[] = [{ label: 'Medicine held', value: n(med) }, { label: 'Two days of need', value: n(requirement) }]
  if (drop === 0) return { topic: 'med', severity: 'critical', headline: 'MEDICAL STOCK EMPTY', effect: 'No reinforcements. Wounded guards are not patched up and sent back.', factors }
  if (drop === 1) return { topic: 'med', severity: 'warn', headline: 'MEDICAL STOCK LOW', effect: 'Limited reinforcements: one guard per wave.', factors }
  return { topic: 'med', severity: 'ok', headline: 'MEDICAL STOCK HOLDS', effect: `Full reinforcement waves of ${drop} guards.`, factors }
}

/** Fuel → depot staging and supply shipments. Only the two thresholds the engine has. */
export function fuelStatement(fuel: number): Statement {
  const factors: Factor[] = [{ label: 'Fuel held', value: n(fuel) }, { label: 'Needed to stage a depot', value: String(STAGING_FUEL) }, { label: 'Needed to run a shipment', value: String(LOGISTICS_FUEL) }]
  if (fuel < LOGISTICS_FUEL) return { topic: 'fuel', severity: 'critical', headline: 'FUEL SHORTAGE', effect: 'Supply shipments grounded, and no forward depot can be staged, so there is nothing to raid.', factors }
  if (fuel < STAGING_FUEL) return { topic: 'fuel', severity: 'warn', headline: 'FUEL LOW', effect: 'Cannot stage a forward depot, so there is nothing to raid. Shipments still run.', factors }
  return { topic: 'fuel', severity: 'ok', headline: 'FUEL SUFFICIENT', effect: 'Depots can be staged and shipments run.', factors }
}

/** Credits → ability to buy its way out of a shortage and to pay for escorts. */
export function treasuryStatement(credits: number, reserve: number, defense: number, anyShort: boolean): Statement {
  const free = spendable(credits, reserve)
  const factors: Factor[] = [{ label: 'Credits', value: n(credits) }, { label: 'Reserve it will not spend', value: n(reserve) }, { label: 'Spendable', value: n(free) }]
  if (free === 0 && anyShort) return { topic: 'credits', severity: 'critical', headline: 'TREASURY STRAINED', effect: 'Emergency resupply unaffordable: it is at its reserve and will not buy stock.', factors }
  if (credits < reserve + DEFENSE_COST[Math.min(5, Math.max(0, defense))]) return { topic: 'credits', severity: 'warn', headline: 'TREASURY TIGHT', effect: 'Cannot comfortably pay for its current escort level; the defense review cuts escorts to the minimum.', factors }
  return { topic: 'credits', severity: 'ok', headline: 'TREASURY HEALTHY', effect: `${n(free)} credits free to spend on resupply.`, factors }
}

export interface FactionPicture {
  readiness: Readiness
  /** One line saying why. */
  summary: string
  statements: Statement[]
  /** Sabotaged production lines (the engine's own `disrupted` list). */
  disrupted: { resource: ResourceName; until: number }[]
}

/** Resupply the faction already has in motion, taken from real orders and convoys. */
export interface Inbound { resource: ResourceName; kind: 'order' | 'convoy' }

/**
 * Faction readiness, computed only from the statements above:
 *  - Supply Critical: any statement is critical.
 *  - Rebuilding: something is short, but a real supply order or convoy for it is under way.
 *  - Under Pressure: something is short (or a line is sabotaged) with nothing inbound.
 *  - Operational: nothing short.
 */
export function describeFaction(a: WarActor, inbound: Inbound[] = []): FactionPicture {
  const { holdings: h, requirement: req } = a
  const anyShort = (['ammo', 'med', 'fuel'] as const).some((r) => h[r] < req[r])
  const statements = [
    ammoStatement(a.defense, h.ammo),
    medStatement(a.defense, h.med, req.med),
    fuelStatement(h.fuel),
    treasuryStatement(h.credits, a.credit_reserve, a.defense, anyShort),
  ]
  const short = statements.filter((s) => s.severity !== 'ok')
  const covered = (s: Statement) => s.topic !== 'credits' && inbound.some((i) => i.resource === s.topic)
  let readiness: Readiness
  let summary: string
  if (short.some((s) => s.severity === 'critical' && !covered(s))) {
    readiness = 'supply_critical'
    summary = short.find((s) => s.severity === 'critical')!.effect
  } else if (short.length > 0 && short.every(covered)) {
    readiness = 'rebuilding'
    summary = 'Resupply is on its way for what it is short of.'
  } else if (short.length > 0 || a.disrupted.length > 0) {
    readiness = 'under_pressure'
    summary = short[0]?.effect ?? 'A production line is sabotaged.'
  } else {
    readiness = 'operational'
    summary = 'Fully supplied: guards armed, reinforcements flowing, depots staged.'
  }
  return { readiness, summary, statements, disrupted: a.disrupted }
}

/** The server's own guard plan for a mission (exact; no recomputation), in plain words. */
export function describeGuardPlan(g: GuardPlan, targetName: string): { arms: string; medical: string; stayedHome: number } {
  const rifles = g.hall.rifles + g.yard.rifles
  const sidearms = g.hall.sidearms + g.yard.sidearms
  const stayedHome = Math.max(0, g.planned - rifles - sidearms)
  return {
    arms: `${plural(rifles + sidearms, 'guard')}: ${plural(rifles, 'rifle')}${sidearms > 0 ? `, ${plural(sidearms, 'sidearm')}` : ''}`,
    medical: g.reinforce_per_drop === 0 ? `No reinforcements: ${targetName} is out of medicine` : `${plural(g.reinforce_per_drop, 'reinforcement')} per wave while you load`,
    stayedHome,
  }
}
