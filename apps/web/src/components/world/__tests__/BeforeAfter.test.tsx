import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Consequence } from '@/lib/api'
import { BeforeAfter } from '../BeforeAfter'

const snap = (ammo: number, tick: number) => ({ tick, id: 'vanguard', name: 'Vanguard', holdings: { credits: 1000, ammo, med: 30, fuel: 100 }, requirement: { ammo: 100, med: 24, fuel: 96 }, defense: 2, credit_reserve: 300, disrupted: [] })
const guards = { planned: 9, ammo_available: 0, hall: { rifles: 5, sidearms: 0 }, yard: { rifles: 4, sidearms: 0 }, guard_hp: 100, sidearm_damage_bp: 4500, reinforce_per_drop: 2, reinforce_every_secs_x100: 400 }
const base = { kind: 'raid', target: 'vanguard', resource: 'ammo', before: snap(100, 10), faced: { available: true, reason: null, manifest: 60, defense: 2, guards } } as const

describe('before/after table', () => {
  it('shows recorded values and the direction of change as text', () => {
    const c = { ...base, after: snap(40, 13), next: { available: true, reason: null, manifest: 24, defense: 2, guards }, settled_tick: 13 } as unknown as Consequence
    render(<BeforeAfter c={c} />)
    const r = screen.getByTestId('cmp-ammo')
    expect(r.textContent).toContain('100')
    expect(r.textContent).toContain('40')
    expect(r.textContent).toContain('down')
  })
  it('an unsettled operation shows "pending" for after and never a made-up value', () => {
    const c = { ...base, after: null, next: null, settled_tick: null } as unknown as Consequence
    render(<BeforeAfter c={c} />)
    expect(screen.getByTestId('cmp-ammo').textContent).toContain('pending')
    expect(screen.getByTestId('cmp-ammo').textContent).not.toContain('down')
    expect(screen.getAllByText('not settled').length).toBeGreaterThan(0)
  })
  it('bounty is stated as not recorded', () => {
    const c = { ...base, after: null, next: null, settled_tick: null } as unknown as Consequence
    render(<BeforeAfter c={c} />)
    expect(screen.getByTestId('cmp-bounty').textContent).toContain('not part of the recorded snapshot')
  })
})
