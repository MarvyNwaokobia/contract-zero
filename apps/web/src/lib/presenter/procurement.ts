// A supply order told as seven stages, from the records the server kept:
//
//   shortage → supply order → merchants bid → winning offer → settlement → supply arrives → readiness
//
// Every stage is `done`, `pending` (not yet happened, or in flight), `failed`, `skipped`
// (it did not happen and will not) or `none` (no record exists). Nothing is filled in:
// one offer is never called competition, a settlement is `done` only once every recorded
// step is confirmed on NEAR, and readiness reports the engine's plan now, not a guess at a change.

import type { OrderProposal, ProcurementChain, ResourceName } from '@/lib/api'
import { worldClock } from './consequence'

export type StageState = 'done' | 'pending' | 'failed' | 'skipped' | 'none'
export type StageKey = 'shortage' | 'order' | 'bids' | 'winner' | 'settlement' | 'arrival' | 'readiness'
export interface Evidence { label: string; value: string }
export interface TimelineStage { key: StageKey; title: string; state: StageState; tick: number | null; summary: string; evidence: Evidence[] }
export interface Timeline { headline: string; status: string; stages: TimelineStage[] }

const NAME: Record<ResourceName, string> = { ammo: 'ammunition', med: 'medical supplies', fuel: 'fuel' }
const n = (x: number) => x.toLocaleString('en-US')
const plural = (k: number, w: string) => `${n(k)} ${w}${k === 1 ? '' : 's'}`
const ctx = (c: ProcurementChain, key: string) => c.shortage?.context.find(([k]) => k === key)?.[1]

function shortage(c: ProcurementChain): TimelineStage {
  const buy = c.side === 'buy'
  const title = buy ? 'Shortage detected' : 'Surplus detected'
  if (!c.shortage) return { key: 'shortage', title, state: 'none', tick: null, summary: 'No commander decision is recorded behind this order.', evidence: [] }
  const have = ctx(c, 'have'), target = ctx(c, 'target')
  const figures = have != null && target != null
    ? `${c.requester_name} held ${n(have)} ${NAME[c.resource]} against a target of ${n(target)}${buy ? '' : ' (a surplus)'}.`
    : c.shortage.rationale
  return {
    key: 'shortage', title, state: 'done', tick: c.shortage.tick, summary: figures,
    evidence: [{ label: 'Trigger', value: c.shortage.trigger }, ...c.shortage.context.map(([k, v]) => ({ label: k, value: n(v) })), { label: 'Reasoning logged', value: c.shortage.rationale }, { label: 'Decided by', value: c.shortage.planner }],
  }
}

function order(c: ProcurementChain): TimelineStage {
  return {
    key: 'order', title: 'Supply order opened', state: 'done', tick: c.placed_at,
    summary: `${c.requester_name} ${c.side === 'buy' ? 'asks the merchants for' : 'offers'} ${n(c.qty)} ${NAME[c.resource]}, ${c.side === 'buy' ? 'paying at most' : 'wanting at least'} ${n(c.limit_total)} cr, open until ${worldClock(c.expires_at)}.`,
    evidence: [{ label: 'Order', value: `#${c.order}` }, { label: 'Urgency', value: String(c.urgency) }, { label: 'Purpose', value: c.purpose }, { label: 'Chain id', value: c.chain_id }],
  }
}

function bids(c: ProcurementChain, proposals: OrderProposal[] | undefined): TimelineStage {
  const offered = c.answers.filter((a) => a.proposed)
  const declined = c.answers.filter((a) => !a.proposed)
  const ev: Evidence[] = [
    ...(proposals ?? []).map((p) => ({ label: `Offer: ${p.merchant_name ?? p.merchant}`, value: `${n(p.qty)} for ${n(p.total)} cr (${(p.total / Math.max(1, p.qty)).toFixed(1)} cr/unit), ${p.status}` })),
    ...offered.map((a) => ({ label: `${a.merchant_name} answered`, value: a.rationale })),
    ...declined.map((a) => ({ label: `${a.merchant_name} declined`, value: a.rationale })),
  ]
  const open = c.status.status === 'open'
  if (c.answers.length === 0) {
    return { key: 'bids', title: 'Merchants bid', state: open ? 'pending' : 'skipped', tick: null, summary: open ? 'No merchant has answered yet.' : 'No merchant answered before the order closed.', evidence: ev }
  }
  const tick = Math.min(...c.answers.map((a) => a.tick))
  let summary: string
  if (offered.length === 0) summary = `Every merchant declined (${declined.map((a) => a.merchant_name).join(', ')}).`
  else if (offered.length === 1) summary = `${offered[0].merchant_name} made the only offer${declined.length ? `; ${plural(declined.length, 'other merchant')} declined` : ''}. With one offer there was no price competition.`
  else summary = `${offered.length} merchants made competing offers${declined.length ? `; ${plural(declined.length, 'other')} declined` : ''}.`
  return { key: 'bids', title: 'Merchants bid', state: 'done', tick, summary, evidence: ev }
}

function winner(c: ProcurementChain): TimelineStage {
  const title = 'Winning offer accepted'
  const chosen = c.choices.find((x) => x.validation === 'accepted')
  if (c.fills.length > 0) {
    const f = c.fills
    return {
      key: 'winner', title, state: 'done', tick: Math.min(...f.map((x) => x.tick)),
      summary: `${f.map((x) => `${x.merchant_name}: ${n(x.qty)} for ${n(x.total)} cr`).join(' + ')}.${chosen ? ` ${chosen.rationale}` : ''}`,
      evidence: [...f.map((x) => ({ label: `Filled by ${x.merchant_name}`, value: `${n(x.qty)} for ${n(x.total)} cr` })), ...c.choices.map((x) => ({ label: `Choice at ${worldClock(x.tick)} (${x.validation})`, value: x.rationale }))],
    }
  }
  const st = c.status.status
  if (st === 'open') return { key: 'winner', title, state: 'pending', tick: null, summary: 'The commander has not chosen an offer yet.', evidence: c.choices.map((x) => ({ label: `Choice at ${worldClock(x.tick)} (${x.validation})`, value: x.error ?? x.rationale })) }
  return { key: 'winner', title, state: 'skipped', tick: null, summary: st === 'expired' ? 'No acceptable offer arrived before the deadline; the escrow went back.' : `The order ${st} without an accepted offer.`, evidence: c.choices.map((x) => ({ label: `Choice at ${worldClock(x.tick)} (${x.validation})`, value: x.error ?? x.rationale })) }
}

function settlement(c: ProcurementChain): TimelineStage {
  const title = 'Settlement on NEAR'
  const s = c.settlement
  const ev = s.map((x) => ({ label: x.op_id, value: `${x.settled_on_chain ? 'confirmed' : x.status}${x.error ? ` (${x.error})` : ''}${x.tx_hashes.length ? ` · ${x.tx_hashes.map((h) => h.slice(0, 8)).join(', ')}` : ''}` }))
  if (s.length === 0) return { key: 'settlement', title, state: 'none', tick: null, summary: 'No on-chain step is recorded for this order (settlement is off, or nothing has been queued yet).', evidence: ev }
  const bad = s.filter((x) => x.status === 'failed' || x.status === 'compensated')
  if (bad.length) return { key: 'settlement', title, state: 'failed', tick: null, summary: `${plural(bad.length, 'step')} failed or had to be reversed. This is not settled.`, evidence: ev }
  const done = s.filter((x) => x.settled_on_chain).length
  if (done === s.length) return { key: 'settlement', title, state: 'done', tick: null, summary: `All ${plural(s.length, 'on-chain step')} confirmed on NEAR testnet.`, evidence: ev }
  return { key: 'settlement', title, state: 'pending', tick: null, summary: `${done} of ${s.length} on-chain steps confirmed. The rest are in flight, so this is not settled yet.`, evidence: ev }
}

function arrival(c: ProcurementChain): TimelineStage {
  const buy = c.side === 'buy'
  if (c.delivered > 0) {
    return { key: 'arrival', title: buy ? 'Supply arrives' : 'Surplus sold', state: 'done', tick: c.fills.length ? Math.min(...c.fills.map((x) => x.tick)) : null, summary: `${n(c.delivered)} ${NAME[c.resource]} ${buy ? 'delivered to' : 'sold by'} ${c.requester_name} for ${n(c.paid)} cr. The game world's inventory changed accordingly.`, evidence: [{ label: 'Delivered', value: n(c.delivered) }, { label: 'Paid', value: `${n(c.paid)} cr` }, ...(c.next_mission ? [{ label: 'Now holds', value: n(c.next_mission.stock_now) }] : [])] }
  }
  return { key: 'arrival', title: buy ? 'Supply arrives' : 'Surplus sold', state: c.status.status === 'open' ? 'pending' : 'skipped', tick: null, summary: c.status.status === 'open' ? 'Nothing delivered yet.' : 'Nothing was delivered.', evidence: [] }
}

function readiness(c: ProcurementChain): TimelineStage {
  const title = 'Military readiness'
  const m = c.next_mission
  if (c.delivered > 0 && m) {
    return {
      key: 'readiness', title, state: 'done', tick: null,
      summary: `After the delivery ${c.requester_name} holds ${n(m.stock_now)} ${NAME[c.resource]}. A raid on its ${m.depot} depot now faces ${n(m.guards)} of ${n(m.planned)} planned guards (${n(m.rifles)} rifles, ${n(m.sidearms)} sidearms) at defense level ${m.defense}. This is the engine's plan as of now.`,
      evidence: [{ label: 'Guards deployed / planned', value: `${m.guards} / ${m.planned}` }, { label: 'Rifles / sidearms', value: `${m.rifles} / ${m.sidearms}` }, { label: 'Defense level', value: String(m.defense) }],
    }
  }
  return { key: 'readiness', title, state: c.status.status === 'open' ? 'pending' : 'none', tick: null, summary: c.status.status === 'open' ? 'Unchanged until supplies arrive.' : 'No delivery, so no change to record.', evidence: [] }
}

export function describeProcurement(c: ProcurementChain, proposals?: OrderProposal[]): Timeline {
  const buy = c.side === 'buy'
  return {
    headline: `${c.requester_name} ${buy ? 'needs' : 'sells'} ${n(c.qty)} ${NAME[c.resource]}`,
    status: c.status.status,
    stages: [shortage(c), order(c), bids(c, proposals), winner(c), settlement(c), arrival(c), readiness(c)],
  }
}
