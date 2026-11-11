// Grouping supply orders for the Exchange, from each order's real status. "Filled" means the
// server recorded fills for it; a partly filled order that expired is closed, not filled.

import type { MarketOrder } from '@/lib/api'

export type OrderFilter = 'open' | 'filled' | 'closed' | 'all'
export const FILTER_LABEL: Record<OrderFilter, string> = { open: 'Open', filled: 'Filled', closed: 'Expired or cancelled', all: 'All' }

export function orderGroup(o: MarketOrder): Exclude<OrderFilter, 'all'> {
  const s = o.status.status
  return s === 'open' ? 'open' : s === 'filled' ? 'filled' : 'closed'
}

export const countOrders = (orders: MarketOrder[]): Record<OrderFilter, number> => ({
  open: orders.filter((o) => orderGroup(o) === 'open').length,
  filled: orders.filter((o) => orderGroup(o) === 'filled').length,
  closed: orders.filter((o) => orderGroup(o) === 'closed').length,
  all: orders.length,
})

export const filterOrders = (orders: MarketOrder[], f: OrderFilter): MarketOrder[] => (f === 'all' ? orders : orders.filter((o) => orderGroup(o) === f))

/** Open orders are what can still change, so they lead; otherwise the full list. */
export const defaultFilter = (orders: MarketOrder[]): OrderFilter => (orders.some((o) => orderGroup(o) === 'open') ? 'open' : 'all')
