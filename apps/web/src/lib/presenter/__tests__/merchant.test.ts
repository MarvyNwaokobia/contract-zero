import { describe, expect, it } from 'vitest'
import type { MarketMerchant } from '@/lib/api'
import { describeMerchant } from '../merchant'

const shelf = (stock: number, target: number) => ({ stock, target, reserved: 0, ask: 12, bid: 10 })
const merchant = (over: Partial<MarketMerchant> = {}): MarketMerchant => ({
  id: 'vex', name: 'Vex Exchange', account: null, credits: 5000, credit_reserve: 500, margin_bp: 1000, spread_bp: 500, min_margin_bp: 1000, max_commit_bp: 8000, instant_market: true,
  record: { proposals: 0, wins: 0, losses: 0, declined: 0, streak: 0, units_sold: 0, units_bought: 0, revenue: 0 },
  shelves: { ammo: shelf(100, 100), med: shelf(50, 50), fuel: shelf(100, 100) }, ...over,
})

describe('merchant readiness', () => {
  it('trading when stocked and solvent', () => {
    const p = describeMerchant(merchant())
    expect(p.state).toBe('trading')
    expect(p.statements).toEqual([])
  })
  it('an empty shelf means it cannot answer supply orders for that resource', () => {
    const p = describeMerchant(merchant({ shelves: { ammo: shelf(0, 100), med: shelf(50, 50), fuel: shelf(100, 100) } }))
    expect(p.state).toBe('constrained')
    expect(p.statements[0].headline).toBe('AMMUNITION SHELF EMPTY')
  })
  it('a shelf under target is stretched and reports the real price multiplier', () => {
    const p = describeMerchant(merchant({ shelves: { ammo: shelf(50, 100), med: shelf(50, 50), fuel: shelf(100, 100) } }))
    expect(p.state).toBe('stretched')
    expect(p.statements[0].effect).toContain('×2.00')
    expect(p.statements[0].factors.some((f) => f.value === '×2.00')).toBe(true)
  })
  it('a full shelf stops it bidding on orders that sell to it', () => {
    const p = describeMerchant(merchant({ shelves: { ammo: shelf(200, 100), med: shelf(50, 50), fuel: shelf(100, 100) } }))
    expect(p.statements[0].effect).toContain('Will not bid')
  })
  it('only the instant-market merchant is called insolvent', () => {
    const broke = { credits: 300 }
    expect(describeMerchant(merchant(broke)).state).toBe('insolvent')
    const halcyon = describeMerchant(merchant({ ...broke, instant_market: false, id: 'halcyon' }))
    expect(halcyon.state).toBe('constrained')
    expect(halcyon.statements[0].headline).toBe('CANNOT BID')
  })
  it('does not claim insolvency for a merchant with spare credits', () => {
    expect(describeMerchant(merchant({ credits: 600 })).state).toBe('trading')
  })
})
