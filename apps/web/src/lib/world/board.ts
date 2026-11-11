// Filtering and ordering for the Contract Board, on the fields the server really sends.
// Nothing is scored or invented: "pay" is the fee plus what the cargo sells for, "danger" is
// the number of guards the server says will be on the site, "size" is the manifest.

import type { BoardEntry } from '@/lib/api'

export type KindFilter = 'all' | 'raid' | 'sabotage' | 'recovery'
export type SortKey = 'pay' | 'danger' | 'size'
export const SORT_LABEL: Record<SortKey, string> = { pay: 'Best pay', danger: 'Fewest guards', size: 'Largest cargo' }

export const guardCount = (e: BoardEntry) => e.guards.hall.rifles + e.guards.hall.sidearms + e.guards.yard.rifles + e.guards.yard.sidearms
/** What the player can earn: the sponsor's fee, plus the cargo's resale value for a raid (the only kind that brings cargo home). */
export const pay = (e: BoardEntry) => (e.bounty?.amount ?? 0) + (e.kind === 'raid' ? e.market_value.bid : 0)

export function boardView(board: BoardEntry[], kind: KindFilter, sort: SortKey): BoardEntry[] {
  const rows = kind === 'all' ? [...board] : board.filter((e) => e.kind === kind)
  const key = { pay: (e: BoardEntry) => -pay(e), danger: guardCount, size: (e: BoardEntry) => -e.manifest }[sort]
  return rows.sort((a, b) => key(a) - key(b) || pay(b) - pay(a))
}

export const kindsPresent = (board: BoardEntry[]): KindFilter[] => ['all', ...(['raid', 'sabotage', 'recovery'] as const).filter((k) => board.some((e) => e.kind === k))]
