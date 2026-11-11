import { describe, expect, it } from 'vitest'
import type { MarketMerchant, WarActor } from '@/lib/api'
import { describeFaction } from '../economy'
import { describeMerchant } from '../merchant'
import { factionRemark, merchantRemark } from '../remarks'

const actor = (over: Partial<WarActor> = {}): WarActor => ({
  id: 'vanguard', name: 'Vanguard', kind: 'faction', holdings: { credits: 2000, ammo: 200, med: 100, fuel: 100 }, production: { ammo: 0, med: 0, fuel: 0 },
  requirement: { ammo: 100, med: 50, fuel: 50 }, credit_reserve: 500, income_per_day: 100, defense: 2, doctrine: { base_defense: 2, max_price_mult: 2, aggression: 10 },
  disrupted: [], recent_raids: 0, grudges: [], rivals: [], ...over,
})
const shelf = (stock: number, target: number) => ({ stock, target, reserved: 0, ask: 12, bid: 10 })
const merchant = (over: Partial<MarketMerchant> = {}): MarketMerchant => ({
  id: 'vex', name: 'Vex Exchange', account: null, credits: 5000, credit_reserve: 500, margin_bp: 1000, spread_bp: 500, min_margin_bp: 1000, max_commit_bp: 8000, instant_market: true,
  record: { proposals: 0, wins: 0, losses: 0, declined: 0, streak: 0, units_sold: 0, units_bought: 0, revenue: 0 },
  shelves: { ammo: shelf(100, 100), med: shelf(50, 50), fuel: shelf(100, 100) }, ...over,
})
// Words that would turn an explanation into a decision or a promise: the economy decides, not the voice.
const DECISION = /\b(i|we)('ll| will| shall| decided| have decided| choose| chose| intend| plan to| are going to)\b|\bi'm going to\b/i

describe('faction remarks', () => {
  const short = describeFaction(actor({ holdings: { credits: 2000, ammo: 44, med: 100, fuel: 100 } }))
  it('restate the real numbers behind the state, each in its own manner', () => {
    const v = factionRemark('vanguard', short, false), a = factionRemark('ashen', short, false)
    expect(v).toContain('5 rifle guards and 2 sidearm guards')
    expect(a).toContain('5 rifle guards and 2 sidearm guards')
    expect(v).toMatch(/^Logged\./)
    expect(a).not.toBe(v)
  })
  it('a healthy faction says so, and nothing about a problem it does not have', () => {
    const ok = describeFaction(actor())
    expect(factionRemark('vanguard', ok, false)).toBe('All guards armed. Stocks logged and within need.')
    expect(factionRemark('ashen', ok, false)).toBe('Stocked and armed. The yard is running.')
  })
  it('says resupply is under way only when a real order or convoy is', () => {
    expect(factionRemark('vanguard', short, false)).not.toContain('Resupply')
    expect(factionRemark('vanguard', short, true)).toContain('Resupply is under way.')
  })
  it('never announces a decision or an intention', () => {
    for (const r of [factionRemark('vanguard', short, true), factionRemark('ashen', short, true), factionRemark('ashen', describeFaction(actor({ holdings: { credits: 100, ammo: 0, med: 0, fuel: 0 } })), false)]) expect(r).not.toMatch(DECISION)
  })
})

describe('merchant remarks', () => {
  it('Vex and Halcyon speak differently about the same real shelf', () => {
    const p = describeMerchant(merchant({ shelves: { ammo: shelf(50, 100), med: shelf(50, 50), fuel: shelf(100, 100) } }))
    const vex = merchantRemark('vex', p), hal = merchantRemark('halcyon', p)
    expect(vex).toContain('×2.00')
    expect(hal).toContain('×2.00')
    expect(vex).toContain('That is the market.')
    expect(hal).toMatch(/^Note: /)
  })
  it('a stocked merchant says it is stocked', () => {
    const p = describeMerchant(merchant())
    expect(merchantRemark('vex', p)).toBe('Shelves are stocked, and prices follow them.')
    expect(merchantRemark('halcyon', p)).toBe('We can fill orders in both directions.')
  })
  it('an insolvent one says what the rule really is, and never promises to recover', () => {
    const p = describeMerchant(merchant({ credits: 300 }))
    const r = merchantRemark('vex', p)
    expect(r).toContain('not buying or restocking')
    expect(r).not.toMatch(DECISION)
    expect(r).not.toMatch(/\b(soon|shortly|tomorrow|by tonight|will be back)\b/i) // no invented outlook
  })
  it('never announces a decision or an intention', () => {
    for (const m of [merchant(), merchant({ credits: 300 }), merchant({ shelves: { ammo: shelf(0, 100), med: shelf(0, 50), fuel: shelf(0, 100) } }), merchant({ id: 'halcyon', instant_market: false, credits: 100 })])
      for (const id of ['vex', 'halcyon']) expect(merchantRemark(id, describeMerchant(m))).not.toMatch(DECISION)
  })
})
