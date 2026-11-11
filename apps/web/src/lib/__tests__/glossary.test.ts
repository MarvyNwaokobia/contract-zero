import { describe, expect, it } from 'vitest'
import { describeFaction, READINESS_LABEL } from '../presenter/economy'
import { describeMerchant, MERCHANT_LABEL } from '../presenter/merchant'
import { GLOSSARY } from '../glossary'
import type { MarketMerchant, WarActor } from '@/lib/api'

const terms = Object.fromEntries(GLOSSARY.flatMap((g) => g.terms.map((t) => [t.term, t.means])))

describe('glossary', () => {
  it('defines every readiness and merchant word the screens use', () => {
    for (const l of [...Object.values(READINESS_LABEL), ...Object.values(MERCHANT_LABEL)]) expect(terms[l], l).toBeTruthy()
  })
  it('states the fuel thresholds the presenter really applies', () => {
    const fac = (fuel: number): WarActor => ({ id: 'vanguard', name: 'V', kind: 'faction', holdings: { credits: 2000, ammo: 500, med: 100, fuel }, production: { ammo: 0, med: 0, fuel: 0 }, requirement: { ammo: 10, med: 10, fuel: 10 }, credit_reserve: 100, income_per_day: 0, defense: 1, doctrine: { base_defense: 1, max_price_mult: 2, aggression: 0 }, disrupted: [], recent_raids: 0, grudges: [], rivals: [] } as WarActor)
    expect(terms.Fuel).toContain('Below 20')
    expect(terms.Fuel).toContain('Below 10')
    expect(describeFaction(fac(19)).statements.find((s) => s.topic === 'fuel')!.severity).toBe('warn') // <20: cannot stage
    expect(describeFaction(fac(9)).statements.find((s) => s.topic === 'fuel')!.severity).toBe('critical') // <10: shipments grounded
    expect(describeFaction(fac(20)).statements.find((s) => s.topic === 'fuel')!.severity).toBe('ok')
  })
  it('describes the merchant states as the presenter classifies them', () => {
    const shelf = { stock: 100, target: 100, reserved: 0, ask: 1, bid: 1 }
    const m = { id: 'vex', name: 'Vex', credits: 100, credit_reserve: 500, margin_bp: 1, spread_bp: 1, min_margin_bp: 1, max_commit_bp: 8000, instant_market: true, shelves: { ammo: shelf, med: shelf, fuel: shelf } } as unknown as MarketMerchant
    expect(describeMerchant(m).state).toBe('insolvent')
    expect(terms[MERCHANT_LABEL.insolvent]).toContain('credit reserve')
  })
})
