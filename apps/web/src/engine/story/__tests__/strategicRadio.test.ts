import { describe, expect, it } from 'vitest'
import type { AgentEvent, ProcurementChain } from '@/lib/api'
import { RadioQueue, radioFromDecisions, radioFromProcurement, type RadioEvent } from '../strategicRadio'

// Shapes copied from real events the live API returned.
const ev = (seq: number, source: string, trigger: string, context: [string, number][], action: Record<string, unknown> | null, validation = 'accepted', rationale = ''): AgentEvent =>
  ({ seq, tick: seq, source, kind: 'agent_decision', payload: { trigger, context, action, validation: validation as 'accepted', rationale } })

const shortage = ev(10, 'vanguard', 'med below target', [['have', 17], ['target', 24], ['inbound', 0], ['budget', 4691], ['urgency', 1], ['order_qty', 7], ['limit_total', 420]], { action: 'place_order', allow_partial: true, limit_total: 420, qty: 7, resource: 'med', side: 'buy' })
const bounty = ev(11, 'ashen', 'retaliation', [['paid_raids_on_me', 1], ['bounty', 2044]], { action: 'post_bounty', target: 'vanguard', resource: 'fuel', amount: 2044 })

describe('radio from faction decisions', () => {
  it('a shortage is spoken in the faction’s voice with the real numbers from its own record', () => {
    const [e] = radioFromDecisions([shortage])
    expect(e.speaker).toBe('vanguard')
    expect(e.text).toBe('Medicine at 17 of 24. Logged. Resupply is ordered.')
    expect(e.key).toBe('decision:10')
    expect(e.evidence).toContain('med below target')
  })
  it('the same shortage sounds different from the Ashen Compact, with the same numbers', () => {
    const [e] = radioFromDecisions([{ ...shortage, seq: 12, source: 'ashen' }])
    expect(e.speaker).toBe('ashen')
    expect(e.text).toContain('Medicine at 17 of 24')
    expect(e.text).not.toBe('Medicine at 17 of 24. Logged. Resupply is ordered.')
  })
  it('a retaliation names the real target, resource and amount', () => {
    const [e] = radioFromDecisions([bounty])
    expect(e.speaker).toBe('ashen')
    expect(e.text).toBe("2,044 credits to whoever raids Vanguard's fuel depot. We pay for the fire.")
  })
  it('a pre-emptive strike is a strategic response too', () => {
    const [e] = radioFromDecisions([ev(13, 'vanguard', 'pre-emptive strike', [], { action: 'post_bounty', target: 'ashen', resource: 'ammo', amount: 500 })])
    expect(e.text).toBe("500 credits on Ashen Compact's ammunition depot. We keep count.")
  })
  it('says nothing for what the engine rejected, did not act on, or that is not a faction’s speech', () => {
    const rejected = { ...shortage, seq: 20, payload: { ...shortage.payload, validation: 'rejected' as const } }
    const noAction = ev(21, 'vanguard', 'med below target', [['have', 1], ['target', 2]], null, 'no_action')
    const merchant = ev(22, 'vex', 'pricing review', [], { action: 'set_strategy' })
    const defense = ev(23, 'vanguard', 'defense review', [], { action: 'configure_defense', level: 3 })
    expect(radioFromDecisions([rejected, noAction, merchant, defense])).toEqual([])
  })
  it('does not invent a number the record lacks', () => {
    const noFigures = ev(30, 'vanguard', 'ammo below target', [['inbound', 0]], { action: 'place_order', resource: 'ammo', side: 'buy' })
    expect(radioFromDecisions([noFigures])).toEqual([])
    const noAmount = ev(31, 'ashen', 'retaliation', [], { action: 'post_bounty', target: 'vanguard', resource: 'fuel' })
    expect(radioFromDecisions([noAmount])).toEqual([])
  })
  it('a faction selling a surplus is not a shortage', () => {
    expect(radioFromDecisions([ev(40, 'ashen', 'fuel surplus', [['have', 237], ['keep', 96]], { action: 'place_order', side: 'sell', resource: 'fuel' })])).toEqual([])
  })
})

const chain = (over: Partial<ProcurementChain> = {}): ProcurementChain => ({
  order: 74, chain_id: 'c', requester: 'vanguard', requester_name: 'Vanguard', side: 'buy', resource: 'med', qty: 7, limit_total: 420, urgency: 1, placed_at: 5, expires_at: 11,
  status: { status: 'filled' }, purpose: 'x', raid: null, shortage: null, answers: [], choices: [],
  fills: [{ merchant: 'vex', merchant_name: 'Vex Exchange', qty: 7, total: 358, tick: 6 }], settlement: [], delivered: 7, paid: 358, next_mission: null,
  execution_path: { kind: 'native', label: '', official_near_intents: false }, ...over,
})

describe('radio from filled orders', () => {
  it('Vex and Halcyon each speak their own way about the same kind of fill', () => {
    const [vex] = radioFromProcurement([chain()])
    expect(vex.speaker).toBe('vex')
    expect(vex.text).toBe('Lovely. 7 medicine to Vanguard for 358 credits. As agreed.')
    const [hal] = radioFromProcurement([chain({ order: 75, fills: [{ merchant: 'halcyon', merchant_name: 'Halcyon Logistics', qty: 7, total: 325, tick: 7 }] })])
    expect(hal.speaker).toBe('halcyon')
    expect(hal.text).toBe('Halcyon filled 7 medicine for Vanguard at 46.4 credits a unit.')
  })
  it('sums partial fills; never speaks for an unfilled, expired or unknown-merchant order', () => {
    const [e] = radioFromProcurement([chain({ fills: [{ merchant: 'vex', merchant_name: 'Vex', qty: 3, total: 100, tick: 6 }, { merchant: 'halcyon', merchant_name: 'Halcyon', qty: 4, total: 200, tick: 7 }] })])
    expect(e.text).toContain('7 medicine')
    expect(e.text).toContain('300 credits')
    expect(radioFromProcurement([chain({ status: { status: 'expired' }, fills: [] }), chain({ status: { status: 'open' } }), chain({ fills: [{ merchant: 'mystery', merchant_name: '?', qty: 1, total: 1, tick: 1 }] })])).toEqual([])
  })
})

const radio = (key: string, tick: number): RadioEvent => ({ key, speaker: 'vanguard', text: key, tick, evidence: '' })

describe('the queue never broadcasts history and never floods', () => {
  it('the first look at a source is history: remembered, not said', () => {
    const q = new RadioQueue()
    q.ingest('decisions', [radio('a', 1), radio('b', 2)])
    expect(q.pending()).toBe(0)
    q.ingest('decisions', [radio('a', 1), radio('b', 2), radio('c', 3)])
    expect(q.pending()).toBe(1)
    expect(q.next(1000)?.key).toBe('c')
  })
  it('each source is primed on its own, so a late source does not dump its history', () => {
    const q = new RadioQueue()
    q.ingest('decisions', [radio('a', 1)])
    q.ingest('orders', [radio('o1', 1), radio('o2', 2)])      // the orders arrive later: still history
    expect(q.pending()).toBe(0)
    q.ingest('orders', [radio('o1', 1), radio('o2', 2), radio('o3', 3)])
    expect(q.pending()).toBe(1)
  })
  it('one line at a time, spaced out', () => {
    const q = new RadioQueue({ gapMs: 20_000 })
    q.ingest('d', [])
    q.ingest('d', [radio('a', 1), radio('b', 2)])
    expect(q.next(0)?.key).toBe('a')
    expect(q.next(5_000)).toBeNull()
    expect(q.next(20_000)?.key).toBe('b')
    expect(q.next(60_000)).toBeNull()
  })
  it('an event is said once however many times it is offered', () => {
    const q = new RadioQueue({ gapMs: 0 })
    q.ingest('d', [])
    for (let i = 0; i < 5; i++) q.ingest('d', [radio('a', 1)])
    expect(q.pending()).toBe(1)
    q.next(0)
    q.ingest('d', [radio('a', 1)])
    expect(q.pending()).toBe(0)
  })
  it('a short queue: a busy world drops its oldest unspoken line and keeps the newest', () => {
    const q = new RadioQueue({ gapMs: 0, max: 3 })
    q.ingest('d', [])
    q.ingest('d', [1, 2, 3, 4, 5].map((i) => radio(`e${i}`, i)))
    expect(q.pending()).toBe(3)
    expect([q.next(0)?.key, q.next(1)?.key, q.next(2)?.key]).toEqual(['e3', 'e4', 'e5'])
  })
  it('speaks in the order things happened', () => {
    const q = new RadioQueue({ gapMs: 0 })
    q.ingest('d', [])
    q.ingest('d', [radio('late', 9), radio('early', 2)])
    expect([q.next(0)?.key, q.next(1)?.key]).toEqual(['early', 'late'])
  })
})
