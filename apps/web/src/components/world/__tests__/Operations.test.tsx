import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { OperationRecord } from '@/lib/api'

const snap = (ammo: number) => ({ tick: 100, id: 'vanguard', name: 'Vanguard', holdings: { credits: 1000, ammo, med: 30, fuel: 100 }, requirement: { ammo: 100, med: 24, fuel: 96 }, defense: 2, credit_reserve: 300, disrupted: [] })
const guards = { planned: 9, ammo_available: 0, hall: { rifles: 5, sidearms: 0 }, yard: { rifles: 4, sidearms: 0 }, guard_hp: 100, sidearm_damage_bp: 4500, reinforce_per_drop: 2, reinforce_every_secs_x100: 400 }
const op = (status: string, confirmed: boolean): OperationRecord => ({
  player: 'wraith.testnet', completed_at: '2026-11-11T00:00:00Z', outcome: 'extracted', reason: null, kind: 'raid', resource: 'ammo', target: 'vanguard', extracted_units: 60, bounty: 0,
  consequence: { kind: 'raid', target: 'vanguard', resource: 'ammo', before: snap(100), faced: { available: true, reason: null, manifest: 60, defense: 2, guards }, after: snap(40), next: { available: true, reason: null, manifest: 24, defense: 2, guards }, settled_tick: 100 },
  decisions: [],
  settlement: { op_id: 'raid:1', kind: 'raid', status, settled_on_chain: confirmed, tx_hashes: confirmed ? ['abcdef1234'] : [], explorer: confirmed ? ['https://x/abcdef1234'] : [], error: null },
})

const warOperations = vi.fn()
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api: { warOperations: (...a: unknown[]) => warOperations(...a) } }))
import { Operations } from '../Operations'

const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Operations /></QueryClientProvider>)

describe('War Room operations record', () => {
  it('lists an operation with its recorded before and after', async () => {
    warOperations.mockResolvedValue([op('confirmed', true)])
    mount()
    await waitFor(() => expect(screen.getByTestId('operation-row')).toBeTruthy())
    expect(screen.getByText(/100 → 40 \(−60\)/)).toBeTruthy()
    expect(screen.getByText('settled')).toBeTruthy()
  })
  it('never calls an unconfirmed payout settled', async () => {
    warOperations.mockResolvedValue([op('submitted', false)])
    mount()
    await waitFor(() => expect(screen.getByTestId('operation-row')).toBeTruthy())
    expect(screen.getByText('submitted')).toBeTruthy()
    expect(screen.queryByText('settled')).toBeNull()
  })
  it('says so when nothing is recorded', async () => {
    warOperations.mockResolvedValue([])
    mount()
    await waitFor(() => expect(screen.getByText(/No operation has been recorded yet/)).toBeTruthy())
  })
})
