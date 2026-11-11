// Radio from the strategic layer: what the factions and merchants are doing, spoken in their own
// voices as it happens. Every line is a template filled from a record the server already
// holds (a logged decision, a filled order), so the radio can only say what really occurred,
// with the real numbers. Dialogue explains a decision; it never makes one.
//
//   shortage      a faction's accepted order for a resource it is short of
//   retaliation   a faction's accepted bounty on a rival (a response, or a pre-emptive strike)
//   procurement   a merchant filling a supply order
//
// A line fires once per event, never for history (the first look at a source only learns what
// was already there), at most one every `gapMs`, and the queue is short: a busy world is not a
// wall of chatter.

import type { AgentEvent, ProcurementChain, ResourceName } from '@/lib/api'
import type { Speaker } from './presence'

export interface RadioEvent {
  /** Stable per event (`decision:<seq>`, `order:<id>`), for dedupe. */
  key: string
  speaker: Speaker
  text: string
  tick: number
  /** The record it was made from, for the advanced view. */
  evidence: string
}

const NAME: Record<ResourceName, string> = { ammo: 'ammunition', med: 'medicine', fuel: 'fuel' }
const isRes = (x: unknown): x is ResourceName => x === 'ammo' || x === 'med' || x === 'fuel'
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const n = (x: number) => x.toLocaleString('en-US')
const FACTION_NAME: Record<string, string> = { vanguard: 'Vanguard', ashen: 'Ashen Compact' }
const factionName = (id: string) => FACTION_NAME[id] ?? cap(id)
const ctx = (e: AgentEvent, key: string) => e.payload.context?.find(([k]) => k === key)?.[1]
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Faction decisions the engine accepted, as radio. Anything else (rejected, no action, merchants' pricing) is silent. */
export function radioFromDecisions(events: readonly AgentEvent[]): RadioEvent[] {
  const out: RadioEvent[] = []
  for (const e of events) {
    if (e.payload.validation !== 'accepted') continue
    const who = e.source.replace(/^agent:/, '')
    if (who !== 'vanguard' && who !== 'ashen') continue
    const a = e.payload.action as Record<string, unknown> | null | undefined
    const trigger = e.payload.trigger ?? ''
    const base = { key: `decision:${e.seq}`, tick: e.tick, speaker: who as Speaker, evidence: `${who}: ${trigger}${e.payload.rationale ? ` · ${e.payload.rationale}` : ''}` }
    // a shortage: it placed an order to buy what it is short of
    const m = trigger.match(/^(ammo|med|fuel) (below target|critical)/)
    if (m && a?.action === 'place_order' && (a.side === undefined || a.side === 'buy')) {
      const have = ctx(e, 'have'), target = ctx(e, 'target'), res = m[1] as ResourceName
      if (have === undefined || target === undefined) continue
      const r = cap(NAME[res])
      out.push({ ...base, text: who === 'vanguard' ? `${r} at ${n(have)} of ${n(target)}. Logged. Resupply is ordered.` : `${r} at ${n(have)} of ${n(target)}. We burn without it. We are buying.` })
      continue
    }
    // a response to a rival: it posted a bounty
    if ((trigger === 'retaliation' || trigger === 'pre-emptive strike') && (a?.action === 'post_bounty' || a?.action === 'post_contract')) {
      const target = str(a.target), res = a.resource, amount = num(a.amount)
      if (!target || !isRes(res) || amount === undefined) continue
      const where = `${factionName(target)}'s ${NAME[res]} depot`
      out.push({ ...base, text: who === 'vanguard' ? `${n(amount)} credits on ${where}. We keep count.` : `${n(amount)} credits to whoever raids ${where}. We pay for the fire.` })
    }
  }
  return out
}

/** Merchants filling supply orders, as radio. Only an order that really filled; the speaker is the merchant that filled it. */
export function radioFromProcurement(chains: readonly ProcurementChain[]): RadioEvent[] {
  const out: RadioEvent[] = []
  for (const c of chains) {
    if (c.status.status !== 'filled' || c.fills.length === 0) continue
    const merchant = c.fills[0].merchant
    if (merchant !== 'vex' && merchant !== 'halcyon') continue
    const qty = c.fills.reduce((s, f) => s + f.qty, 0), total = c.fills.reduce((s, f) => s + f.total, 0)
    if (qty <= 0) continue
    const res = NAME[c.resource]
    const text = merchant === 'vex'
      ? `Lovely. ${n(qty)} ${res} to ${c.requester_name} for ${n(total)} credits. As agreed.`
      : `Halcyon filled ${n(qty)} ${res} for ${c.requester_name} at ${(total / qty).toFixed(1)} credits a unit.`
    out.push({ key: `order:${c.order}`, speaker: merchant, text, tick: Math.max(...c.fills.map((f) => f.tick)), evidence: `order #${c.order}: ${c.fills.map((f) => `${f.merchant_name} ${f.qty} for ${f.total} cr`).join(', ')}` })
  }
  return out
}

export interface QueueOptions { gapMs?: number; max?: number }

/** What is waiting to be said. Pure: time is passed in. */
export class RadioQueue {
  private seen = new Set<string>()
  private primed = new Set<string>()
  private queue: RadioEvent[] = []
  private lastAt = -Infinity
  private gapMs: number
  private max: number

  constructor(opts: QueueOptions = {}) { this.gapMs = opts.gapMs ?? 20_000; this.max = opts.max ?? 3 }

  /** Offer a source's current events. The first offer from a source is history and is only remembered. */
  ingest(source: string, events: readonly RadioEvent[]): void {
    if (!this.primed.has(source)) {
      this.primed.add(source)
      for (const e of events) this.seen.add(e.key)
      return
    }
    // oldest first, so the queue speaks in the order things happened
    for (const e of [...events].sort((a, b) => a.tick - b.tick)) {
      if (this.seen.has(e.key)) continue
      this.seen.add(e.key)
      this.queue.push(e)
    }
    while (this.queue.length > this.max) this.queue.shift()   // a busy world drops its oldest unspoken line, not the newest
  }

  /** The next line, if one is waiting and enough time has passed since the last. */
  next(nowMs: number): RadioEvent | null {
    if (!this.queue.length || nowMs - this.lastAt < this.gapMs) return null
    this.lastAt = nowMs
    return this.queue.shift() ?? null
  }

  pending(): number { return this.queue.length }
}

/** The app's one queue: it outlives any screen, so moving between the Hub and the War Room does not replay anything. */
export const strategicQueue = new RadioQueue()
