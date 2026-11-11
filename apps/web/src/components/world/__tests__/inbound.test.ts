import { describe, expect, it } from 'vitest'
import type { MarketOrder, WarConvoy } from '@/lib/api'
import { inboundFor } from '../Readiness'

const convoy = (status: WarConvoy['status'], owner = 'ashen'): WarConvoy => ({ id: 1, owner, owner_name: owner, resource: 'fuel', units: 60, defense: 1, dispatched_at: 1, arrives_at: 9, progress: 0.4, status })

// "Rebuilding" depends on this. It silently never fired while the type said {state: ...}
// but the server sends a bare string.
describe('resupply under way', () => {
  it('counts a convoy the server reports as "in_transit"', () => {
    expect(inboundFor('ashen', [], [convoy('in_transit')])).toEqual([{ resource: 'fuel', kind: 'convoy' }])
  })
  it('does not count a delivered or seized convoy, or someone else’s', () => {
    expect(inboundFor('ashen', [], [convoy('arrived'), convoy({ seized: { by: 'vanguard' } }), convoy('in_transit', 'vanguard')])).toEqual([])
  })
  it('still counts a real open buy order', () => {
    const o = { requester: 'ashen', side: 'buy', resource: 'ammo', status: { status: 'open' } } as unknown as MarketOrder
    expect(inboundFor('ashen', [o], [])).toEqual([{ resource: 'ammo', kind: 'order' }])
  })
})
