// A before-and-after table for one operation, from the two snapshots the server recorded
// around it and the engine's own plan for the next one. A value with no record is shown as
// "not recorded" (never interpolated, never zero), and a change is only marked when both
// sides exist.

import type { Consequence, GuardPlan } from '@/lib/api'
import { describeFaction, READINESS_LABEL } from './economy'
import { worldClock } from './consequence'

export type Change = 'up' | 'down' | 'same' | null
export interface Row { key: string; label: string; before: string | null; after: string | null; change: Change; note?: string }
export interface Comparison { settled: boolean; beforeAt: number; afterAt: number | null; rows: Row[] }

const n = (x: number) => x.toLocaleString('en-US')
const NOT_YET = null

function num(key: string, label: string, before: number | null, after: number | null, note?: string): Row {
  const change: Change = before != null && after != null ? (after > before ? 'up' : after < before ? 'down' : 'same') : null
  return { key, label, before: before == null ? null : n(before), after: after == null ? null : n(after), change, note }
}
function text(key: string, label: string, before: string | null, after: string | null, note?: string): Row {
  return { key, label, before, after, change: before != null && after != null ? (before === after ? 'same' : null) : null, note }
}
const guards = (g: GuardPlan | null | undefined) => (g ? g.hall.rifles + g.hall.sidearms + g.yard.rifles + g.yard.sidearms : null)
const rifles = (g: GuardPlan | null | undefined) => (g ? g.hall.rifles + g.yard.rifles : null)
const sidearms = (g: GuardPlan | null | undefined) => (g ? g.hall.sidearms + g.yard.sidearms : null)
const lines = (ds: { resource: string; until: number }[]) => (ds.length ? ds.map((d) => `${d.resource} down until ${worldClock(d.until)}`).join(', ') : 'all running')

export function compareConsequence(c: Consequence): Comparison {
  const a = c.after
  const nextGuards = c.next?.available ? c.next.guards : null
  const nextKnown = !!c.next
  const rows: Row[] = [
    num('ammo', 'Ammunition', c.before.holdings.ammo, a?.holdings.ammo ?? NOT_YET),
    num('med', 'Medicine', c.before.holdings.med, a?.holdings.med ?? NOT_YET),
    num('fuel', 'Fuel', c.before.holdings.fuel, a?.holdings.fuel ?? NOT_YET),
    num('credits', 'Credits', c.before.holdings.credits, a?.holdings.credits ?? NOT_YET),
    num('defense', 'Defense level', c.before.defense, a?.defense ?? NOT_YET),
    num('guards', 'Armed guards on the next raid', guards(c.faced.guards), nextKnown ? guards(nextGuards) : NOT_YET, nextKnown && !c.next!.available ? c.next!.reason ?? 'no operation on offer' : undefined),
    num('rifles', 'Rifles', rifles(c.faced.guards), nextKnown ? rifles(nextGuards) : NOT_YET),
    num('sidearms', 'Sidearms', sidearms(c.faced.guards), nextKnown ? sidearms(nextGuards) : NOT_YET),
    num('reinforce', 'Reinforcements per wave', c.faced.guards?.reinforce_per_drop ?? null, nextKnown ? nextGuards?.reinforce_per_drop ?? null : NOT_YET),
    num('manifest', 'Depot size (units)', c.faced.manifest, nextKnown ? (c.next!.available ? c.next!.manifest : null) : NOT_YET),
    text('lines', 'Production', lines(c.before.disrupted), a ? lines(a.disrupted) : NOT_YET),
  ]
  const rb = c.before.requirement ? READINESS_LABEL[describeFaction(c.before).readiness] : null
  const ra = a?.requirement ? READINESS_LABEL[describeFaction(a).readiness] : null
  rows.push(text('readiness', 'Readiness', rb, ra, rb == null ? 'requirement not recorded for this snapshot' : undefined))
  rows.push({ key: 'bounty', label: 'Bounty on offer', before: null, after: null, change: null, note: 'not part of the recorded snapshot' })
  rows.push(text('next', 'Operation on offer', 'available', nextKnown ? (c.next!.available ? 'available' : 'none on offer') : NOT_YET))
  return { settled: !!a, beforeAt: c.before.tick, afterAt: a?.tick ?? null, rows }
}
