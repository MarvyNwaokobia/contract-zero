// Tells the story of one operation from what the server recorded about it.
//
// Every line is a difference between two recorded snapshots, the engine's own plan for
// the next operation, or the target's own logged decision. Nothing is estimated: with no
// "after" the story says the operation has not settled, and with no snapshot at all it
// says none was recorded.

import type { Aftermath, Consequence, FactionSnapshot, GuardPlan, MissionResult, ResourceName } from '@/lib/api'
import { describeGuardPlan, describeFaction, READINESS_LABEL } from './economy'

export type StepState = 'done' | 'pending' | 'none'
export interface Step { key: 'accomplished' | 'moved' | 'lost' | 'decided' | 'next'; title: string; state: StepState; lines: string[] }
export interface ConsequenceStory { recorded: boolean; steps: Step[] }

const NAME: Record<ResourceName, string> = { ammo: 'ammunition', med: 'medical supplies', fuel: 'fuel' }
const RES: ResourceName[] = ['ammo', 'med', 'fuel']
const n = (x: number) => x.toLocaleString('en-US')
/** The same clock the War Room uses: 24 ticks to a day. */
export const worldClock = (tick: number) => `D${Math.floor(tick / 24)} ${String(tick % 24).padStart(2, '0')}:00`

function accomplished(r: Pick<MissionResult, 'outcome' | 'kind' | 'extracted_units' | 'resource' | 'bounty' | 'reason'>): Step {
  const what = NAME[r.resource]
  const lines: string[] = []
  if (r.outcome === 'extracted') {
    if (r.kind === 'sabotage') lines.push(`Destroyed ${n(r.extracted_units)} ${what} and got clear.`)
    else if (r.kind === 'recovery') lines.push(`Recovered ${n(r.extracted_units)} ${what} and handed them back.`)
    else lines.push(`Carried out ${n(r.extracted_units)} ${what}.`)
    if (r.bounty > 0) lines.push(`Paid a ${n(r.bounty)} credit ${r.kind === 'raid' ? 'bounty' : 'fee'}.`)
  } else if (r.outcome === 'killed') lines.push('Killed in action. Nothing was secured.')
  else lines.push(`The run was rejected${r.reason ? `: ${r.reason}` : ''}. Nothing was paid.`)
  return { key: 'accomplished', title: 'What you accomplished', state: 'done', lines }
}

function moved(c: Consequence, r: Pick<MissionResult, 'outcome' | 'kind' | 'extracted_units' | 'resource'>): Step {
  const what = NAME[c.resource]
  const lines: string[] = []
  if (r.outcome !== 'extracted' || r.extracted_units === 0) lines.push('Nothing moved.')
  else if (c.kind === 'raid') lines.push(`${n(r.extracted_units)} ${what} moved from ${c.before.name}'s depot to you.`)
  else if (c.kind === 'sabotage') lines.push(`${n(r.extracted_units)} ${what} destroyed. They are gone from the world, not taken.`)
  else lines.push(`${n(r.extracted_units)} ${what} returned to their owner's shelf.`)
  return { key: 'moved', title: 'What moved or was destroyed', state: 'done', lines }
}

function delta(b: FactionSnapshot, a: FactionSnapshot) {
  return (r: ResourceName) => a.holdings[r] - b.holdings[r]
}

function lost(c: Consequence): Step {
  if (!c.after) return { key: 'lost', title: `What ${c.before.name} lost`, state: 'pending', lines: ['The operation has not settled yet.'] }
  const d = delta(c.before, c.after)
  const lines: string[] = []
  for (const r of RES) if (d(r) !== 0) lines.push(`${NAME[r][0].toUpperCase()}${NAME[r].slice(1)}: ${n(c.before.holdings[r])} → ${n(c.after.holdings[r])} (${d(r) > 0 ? '+' : '−'}${n(Math.abs(d(r)))}).`)
  const credits = c.after.holdings.credits - c.before.holdings.credits
  if (credits !== 0) lines.push(`Credits: ${n(c.before.holdings.credits)} → ${n(c.after.holdings.credits)}.`)
  for (const x of c.after.disrupted) {
    const was = c.before.disrupted.find((y) => y.resource === x.resource)
    if (!was || was.until !== x.until) {
      const hours = c.settled_tick != null ? x.until - c.settled_tick : null
      lines.push(`Its ${x.resource} production line is down until ${worldClock(x.until)}${hours && hours > 0 ? ` (${hours} in-game hours)` : ''}.`)
    }
  }
  if (c.after.defense !== c.before.defense) lines.push(`Defense level ${c.before.defense} → ${c.after.defense}.`)
  const rb = describeFaction(c.before).readiness, ra = describeFaction(c.after).readiness
  lines.push(rb === ra ? `Readiness: ${READINESS_LABEL[ra]}, unchanged.` : `Readiness: ${READINESS_LABEL[rb]} → ${READINESS_LABEL[ra]}.`)
  if (lines.length === 1 && rb === ra) lines.unshift('Its stock did not change.')
  return { key: 'lost', title: `What ${c.before.name} lost`, state: 'done', lines }
}

function decided(c: Consequence, a: Aftermath | undefined): Step {
  const title = `What ${c.before.name} decided next`
  if (!c.after) return { key: 'decided', title, state: 'pending', lines: ['Waiting for the operation to settle.'] }
  const ds = a?.decisions ?? []
  if (!a || ds.length === 0) return { key: 'decided', title, state: 'pending', lines: ['Its commander has not acted yet. It reviews supplies every in-game hour; this updates when it does.'] }
  const acted = ds.filter((d) => d.payload.action || d.payload.validation === 'rejected')
  if (acted.length === 0) return { key: 'decided', title, state: 'done', lines: [`Reviewed its position at ${worldClock(ds[0].tick)} and took no action.`] }
  return {
    key: 'decided', title, state: 'done',
    lines: acted.slice(0, 4).map((d) => `${worldClock(d.tick)}: ${d.payload.rationale ?? d.payload.trigger ?? 'acted'}${d.payload.validation === 'rejected' ? ' (rejected by the engine)' : ''}`),
  }
}

/** "7 rifles, 2 sidearms": the squad without the leading head-count. */
function squad(g: GuardPlan): string {
  const rifles = g.hall.rifles + g.yard.rifles, sidearms = g.hall.sidearms + g.yard.sidearms
  const r = `${rifles} ${rifles === 1 ? 'rifle' : 'rifles'}`
  return sidearms > 0 ? `${r}, ${sidearms} ${sidearms === 1 ? 'sidearm' : 'sidearms'}` : r
}

function guardCount(g: GuardPlan | null) {
  return g ? g.hall.rifles + g.hall.sidearms + g.yard.rifles + g.yard.sidearms : 0
}

function next(c: Consequence): Step {
  const title = 'What changed for the next operation'
  if (!c.next) return { key: 'next', title, state: 'pending', lines: ['Known once the operation settles.'] }
  const lines: string[] = []
  const name = c.before.name
  if (!c.next.available) {
    lines.push(`None is on offer now: ${c.next.reason ?? 'the engine offers no plan'}.`)
    return { key: 'next', title, state: 'done', lines }
  }
  const was = c.faced.guards ? describeGuardPlan(c.faced.guards, name) : null
  const now = c.next.guards ? describeGuardPlan(c.next.guards, name) : null
  if (was && now && c.faced.guards && c.next.guards) {
    const a = squad(c.faced.guards), b = squad(c.next.guards)
    lines.push(a === b ? `Guards: ${guardCount(c.next.guards)} (${b}), unchanged.` : `Guards: ${guardCount(c.faced.guards)} (${a}) → ${guardCount(c.next.guards)} (${b}).`)
    lines.push(was.medical === now.medical ? `Reinforcements: ${now.medical}.` : `Reinforcements: ${was.medical} → ${now.medical}.`)
  }
  if (c.next.manifest !== c.faced.manifest) lines.push(`Depot size: ${n(c.faced.manifest)} → ${n(c.next.manifest)} units.`)
  if (c.next.defense !== c.faced.defense) lines.push(`Defense level ${c.faced.defense} → ${c.next.defense}.`)
  if (guardCount(c.next.guards) < guardCount(c.faced.guards)) lines.push('Fewer guards are armed than you faced.')
  lines.push('This is the engine’s plan for right now; the commander can change it on its next turn.')
  return { key: 'next', title, state: 'done', lines }
}

export function describeConsequence(
  r: Pick<MissionResult, 'outcome' | 'kind' | 'extracted_units' | 'resource' | 'bounty' | 'reason'>,
  c: Consequence | null | undefined,
  aftermath?: Aftermath,
): ConsequenceStory {
  const first = accomplished(r)
  if (!c) {
    return {
      recorded: false,
      steps: [first, { key: 'moved', title: 'What the world recorded', state: 'none', lines: ['No before-and-after snapshot was recorded for this operation (it began before recording was added).'] }],
    }
  }
  return { recorded: true, steps: [first, moved(c, r), lost(c), decided(c, aftermath), next(c)] }
}
