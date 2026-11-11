import { describe, expect, it } from 'vitest'
import type { BoardEntry } from '@/lib/api'
import { boardView, guardCount, kindsPresent, pay } from '../board'

const entry = (o: Partial<BoardEntry> & { rifles?: number; manifest?: number }): BoardEntry => ({
  kind: 'raid', target: 'vanguard', resource: 'ammo', manifest: o.manifest ?? 50, defense: 2, bounty: o.bounty ?? null, market_value: o.market_value ?? { bid: 100, unit_bid: 2 },
  guards: { planned: 4, ammo_available: 40, hall: { rifles: o.rifles ?? 2, sidearms: 0 }, yard: { rifles: 2, sidearms: 1 }, guard_hp: 100, sidearm_damage_bp: 4500, reinforce_per_drop: 1, reinforce_every_secs_x100: 370 },
  ...o,
} as unknown as BoardEntry)

describe('contract board view', () => {
  const a = entry({ resource: 'ammo', rifles: 1, manifest: 50, market_value: { bid: 100, unit_bid: 2 } })
  const b = entry({ resource: 'fuel', rifles: 6, manifest: 300, market_value: { bid: 900, unit_bid: 3 }, bounty: { id: 1, sponsor: 'x', sponsor_name: 'X', amount: 100, expires_at: 9 } as never })
  const s = entry({ kind: 'sabotage', resource: 'med', rifles: 0, manifest: 20, market_value: { bid: 500, unit_bid: 1 }, bounty: { id: 2, sponsor: 'y', sponsor_name: 'Y', amount: 400, expires_at: 9 } as never })
  it('counts the guards the server planned and what a contract can pay', () => {
    expect(guardCount(a)).toBe(1 + 0 + 2 + 1)
    expect(pay(b)).toBe(1000)
    expect(pay(s)).toBe(400) // sabotage brings no cargo home: only the fee counts
  })
  it('sorts by pay, danger and size; ties go to the better paying contract', () => {
    expect(boardView([a, b, s], 'all', 'pay')).toEqual([b, s, a])
    expect(boardView([a, b, s], 'all', 'danger')[0]).toBe(s)
    expect(boardView([a, b, s], 'all', 'size')[0]).toBe(b)
  })
  it('filters by kind and only offers kinds that are on the board', () => {
    expect(boardView([a, b, s], 'sabotage', 'pay')).toEqual([s])
    expect(kindsPresent([a, b])).toEqual(['all', 'raid'])
    expect(kindsPresent([])).toEqual(['all'])
  })
  it('does not change the list it was given', () => {
    const list = [a, b, s]; boardView(list, 'all', 'pay'); expect(list).toEqual([a, b, s])
  })
})
