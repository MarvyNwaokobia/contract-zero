import { describe, expect, it } from 'vitest'
import type { Consequence, FactionSnapshot, GuardPlan } from '@/lib/api'
import { compareConsequence } from '../compare'

const snap = (ammo: number, over: Partial<FactionSnapshot> = {}): FactionSnapshot => ({
  tick: 10, id: 'vanguard', name: 'Vanguard', holdings: { credits: 1000, ammo, med: 30, fuel: 100 }, requirement: { ammo: 100, med: 24, fuel: 96 }, defense: 2, credit_reserve: 300, disrupted: [], ...over,
})
const g = (r: number, s: number, drop: number): GuardPlan => ({ planned: 9, ammo_available: 0, hall: { rifles: r, sidearms: 0 }, yard: { rifles: 0, sidearms: s }, guard_hp: 100, sidearm_damage_bp: 4500, reinforce_per_drop: drop, reinforce_every_secs_x100: 400 })
const cons = (over: Partial<Consequence> = {}): Consequence => ({
  kind: 'raid', target: 'vanguard', resource: 'ammo', before: snap(100), faced: { available: true, reason: null, manifest: 60, defense: 2, guards: g(9, 0, 2) },
  after: snap(40, { tick: 13 }), next: { available: true, reason: null, manifest: 24, defense: 2, guards: g(5, 2, 1) }, settled_tick: 13, ...over,
})
const row = (c: Consequence, key: string) => compareConsequence(c).rows.find((r) => r.key === key)!

describe('before and after', () => {
  it('reads inventory, guards and reinforcements from the recorded snapshots', () => {
    const c = cons()
    expect(row(c, 'ammo')).toMatchObject({ before: '100', after: '40', change: 'down' })
    expect(row(c, 'guards')).toMatchObject({ before: '9', after: '7', change: 'down' })
    expect(row(c, 'sidearms')).toMatchObject({ before: '0', after: '2', change: 'up' })
    expect(row(c, 'reinforce')).toMatchObject({ before: '2', after: '1', change: 'down' })
    expect(row(c, 'manifest')).toMatchObject({ before: '60', after: '24' })
  })
  it('never interpolates: with no after, every "after" is not recorded and nothing is marked changed', () => {
    const c = cons({ after: null, next: null, settled_tick: null })
    const cmp = compareConsequence(c)
    expect(cmp.settled).toBe(false)
    for (const key of ['ammo', 'med', 'fuel', 'credits', 'defense', 'guards', 'rifles', 'reinforce', 'manifest', 'lines', 'readiness', 'next']) {
      expect(cmp.rows.find((r) => r.key === key)!.after).toBeNull()
      expect(cmp.rows.find((r) => r.key === key)!.change).toBeNull()
    }
    expect(cmp.rows.find((r) => r.key === 'ammo')!.before).toBe('100')
  })
  it('an unavailable next operation gives its reason and no invented guard numbers', () => {
    const c = cons({ next: { available: false, reason: 'Vanguard holds less than 20 fuel, so it cannot stage a depot', manifest: 0, defense: 2, guards: null } })
    expect(row(c, 'guards').after).toBeNull()
    expect(row(c, 'guards').note).toContain('cannot stage a depot')
    expect(row(c, 'next').after).toBe('none on offer')
  })
  it('shows a sabotaged line with its real end tick', () => {
    const c = cons({ after: snap(60, { tick: 13, disrupted: [{ resource: 'ammo', until: 49 }] }) })
    expect(row(c, 'lines')).toMatchObject({ before: 'all running' })
    expect(row(c, 'lines').after).toContain('ammo down until D2 01:00')
  })
  it('marks the operation on offer as unchanged when it stays available', () => {
    expect(row(cons(), 'next')).toMatchObject({ before: 'available', after: 'available', change: 'same' })
  })
  it('says bounty is not recorded rather than inventing it', () => {
    const b = row(cons(), 'bounty')
    expect(b.before).toBeNull()
    expect(b.after).toBeNull()
    expect(b.note).toContain('not part of the recorded snapshot')
  })
  it('readiness compares only when the snapshots carry a requirement', () => {
    expect(row(cons(), 'readiness').before).toBeTruthy()
    const old = (s: FactionSnapshot) => ({ ...s, requirement: undefined }) as unknown as FactionSnapshot
    const r = row(cons({ before: old(snap(100)), after: old(snap(40)) }), 'readiness')
    expect(r.before).toBeNull()
    expect(r.after).toBeNull()
  })
})
