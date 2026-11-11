import { describe, expect, it } from 'vitest'
import type { MarketOrder } from '@/lib/api'
import { countOrders, defaultFilter, filterOrders, orderGroup } from '../orders'

const o = (status: MarketOrder['status']['status'], filled = 0) => ({ id: Math.random(), status: { status }, filled } as unknown as MarketOrder)

describe('order groups', () => {
  const list = [o('open'), o('filled', 5), o('expired', 3), o('cancelled'), o('expired')]
  it('groups by the recorded status, so a partly filled expired order is closed, not filled', () => {
    expect(list.map(orderGroup)).toEqual(['open', 'filled', 'closed', 'closed', 'closed'])
  })
  it('counts and filters', () => {
    expect(countOrders(list)).toEqual({ open: 1, filled: 1, closed: 3, all: 5 })
    expect(filterOrders(list, 'closed')).toHaveLength(3)
    expect(filterOrders(list, 'all')).toHaveLength(5)
  })
  it('opens on open orders when there are any, otherwise on everything', () => {
    expect(defaultFilter(list)).toBe('open')
    expect(defaultFilter([o('filled'), o('expired')])).toBe('all')
    expect(defaultFilter([])).toBe('all')
  })
})
