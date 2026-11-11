import { describe, expect, it } from 'vitest'
import type { OrderProposal, ProcurementChain } from '@/lib/api'
import { describeProcurement } from '../procurement'

const chain = (over: Partial<ProcurementChain> = {}): ProcurementChain => ({
  order: 7, chain_id: 'cz-7', requester: 'vanguard', requester_name: 'Vanguard', side: 'buy', resource: 'ammo', qty: 40, limit_total: 600, urgency: 2, placed_at: 100, expires_at: 112,
  status: { status: 'filled' }, purpose: 'restock', raid: null,
  shortage: { tick: 100, trigger: 'ammo below target', context: [['have', 40], ['target', 152], ['urgency', 2]], rationale: 'Ammo 40/152: ordering 40.', planner: 'fallback' },
  answers: [{ tick: 101, merchant: 'vex', merchant_name: 'Vex Exchange', proposed: true, validation: 'accepted', rationale: 'Offer 40 ammo for 520 cr', planner: 'fallback' }],
  choices: [{ tick: 102, action: { action: 'accept' }, rationale: 'Best offer per unit.', validation: 'accepted', error: null }],
  fills: [{ merchant: 'vex', merchant_name: 'Vex Exchange', qty: 40, total: 520, tick: 102 }],
  settlement: [{ op_id: 'order:cz-7', kind: 'order_place', status: 'confirmed', settled_on_chain: true, tx_hashes: ['abcdef123456'], explorer: [], error: null }],
  delivered: 40, paid: 520,
  next_mission: { depot: 'fuel', guards: 7, planned: 9, rifles: 5, sidearms: 2, defense: 2, stock_now: 80 },
  execution_path: { kind: 'native', label: 'x', official_near_intents: false },
  ...over,
})
const stage = (c: ProcurementChain, key: string, p?: OrderProposal[]) => describeProcurement(c, p).stages.find((s) => s.key === key)!

describe('supply order timeline', () => {
  it('tells a finished order in seven stages, each done', () => {
    const t = describeProcurement(chain())
    expect(t.stages.map((s) => s.key)).toEqual(['shortage', 'order', 'bids', 'winner', 'settlement', 'arrival', 'readiness'])
    expect(t.stages.every((s) => s.state === 'done')).toBe(true)
    expect(t.stages[0].summary).toBe('Vanguard held 40 ammunition against a target of 152.')
  })
  it('one offer is never called competition', () => {
    const s = stage(chain(), 'bids')
    expect(s.summary).toContain('only offer')
    expect(s.summary).toContain('no price competition')
    expect(s.summary).not.toContain('competing')
  })
  it('two offers are competing offers, with the real numbers when the order is joined in', () => {
    const c = chain({ answers: [
      { tick: 101, merchant: 'vex', merchant_name: 'Vex Exchange', proposed: true, validation: 'accepted', rationale: 'Offer 40', planner: 'fallback' },
      { tick: 101, merchant: 'halcyon', merchant_name: 'Halcyon Logistics', proposed: true, validation: 'accepted', rationale: 'Offer 40', planner: 'fallback' },
    ] })
    const props = [{ id: 1, merchant: 'vex', merchant_name: 'Vex Exchange', qty: 40, total: 520, status: 'accepted' }, { id: 2, merchant: 'halcyon', merchant_name: 'Halcyon Logistics', qty: 40, total: 560, status: 'released' }] as OrderProposal[]
    const s = stage(c, 'bids', props)
    expect(s.summary).toContain('2 merchants made competing offers')
    expect(s.evidence[0].value).toBe('40 for 520 cr (13.0 cr/unit), accepted')
  })
  it('all-declined is stated as such', () => {
    const c = chain({ answers: [{ tick: 101, merchant: 'vex', merchant_name: 'Vex Exchange', proposed: false, validation: 'accepted', rationale: 'No ammo to spare', planner: 'fallback' }], fills: [], choices: [], status: { status: 'expired' }, delivered: 0, paid: 0 })
    expect(stage(c, 'bids').summary).toContain('Every merchant declined')
    expect(stage(c, 'winner').state).toBe('skipped')
    expect(stage(c, 'winner').summary).toContain('escrow went back')
  })
  it('a pending settlement is never called settled', () => {
    const c = chain({ settlement: [
      { op_id: 'a', kind: 'order_place', status: 'confirmed', settled_on_chain: true, tx_hashes: [], explorer: [], error: null },
      { op_id: 'b', kind: 'order_fill', status: 'submitted', settled_on_chain: false, tx_hashes: [], explorer: [], error: null },
    ] })
    const s = stage(c, 'settlement')
    expect(s.state).toBe('pending')
    expect(s.summary).toContain('1 of 2')
    expect(s.summary).toContain('not settled yet')
  })
  it('a failed step fails the stage', () => {
    const c = chain({ settlement: [{ op_id: 'a', kind: 'order_fill', status: 'failed', settled_on_chain: false, tx_hashes: [], explorer: [], error: 'gas' }] })
    expect(stage(c, 'settlement').state).toBe('failed')
  })
  it('no settlement rows is "none", not "pending"', () => {
    expect(stage(chain({ settlement: [] }), 'settlement').state).toBe('none')
  })
  it('an open order with no answers is waiting, not done', () => {
    const c = chain({ status: { status: 'open' }, answers: [], choices: [], fills: [], settlement: [], delivered: 0, paid: 0, next_mission: null })
    const t = describeProcurement(c)
    expect(t.stages.find((s) => s.key === 'bids')!.state).toBe('pending')
    expect(t.stages.find((s) => s.key === 'winner')!.state).toBe('pending')
    expect(t.stages.find((s) => s.key === 'arrival')!.state).toBe('pending')
    expect(t.stages.find((s) => s.key === 'readiness')!.summary).toContain('Unchanged until supplies arrive')
  })
  it('readiness reports the engine’s plan now and does not claim a change', () => {
    const s = stage(chain(), 'readiness')
    expect(s.summary).toContain('7 of 9 planned guards')
    expect(s.summary).toContain('engine\'s plan as of now')
  })
  it('a sell-side order reads as a surplus', () => {
    const c = chain({ side: 'sell' })
    expect(stage(c, 'shortage').title).toBe('Surplus detected')
    expect(stage(c, 'arrival').title).toBe('Surplus sold')
    expect(describeProcurement(c).headline).toContain('sells')
  })
  it('a missing shortage record is "none", not invented', () => {
    expect(stage(chain({ shortage: null }), 'shortage').state).toBe('none')
  })
})
