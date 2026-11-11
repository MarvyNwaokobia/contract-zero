import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { MissionResult, WorldView } from '@/lib/api'
import fixture from '@/app/dev/results/fixture.json'

vi.mock('@/components/ui/Shell', async () => {
  const React = await import('react')
  return {
    Shell: ({ title, children }: { title: string; children: React.ReactNode }) => React.createElement('main', null, React.createElement('h1', null, title), children),
    Panel: ({ title, children }: { title?: string; children: React.ReactNode }) => React.createElement('section', null, title && React.createElement('h2', null, title), children),
    Stat: ({ label, value }: { label: string; value: string | number }) => React.createElement('div', null, `${label}: ${value}`),
  }
})
const { MissionResults, headline } = await import('../MissionResults')

const base = fixture.result as unknown as MissionResult
const before = fixture.before as unknown as WorldView, after = fixture.after as unknown as WorldView
const show = (r: MissionResult) => render(<QueryClientProvider client={new QueryClient()}><MissionResults result={r} before={before} after={after} session="s1" /></QueryClientProvider>)
afterEach(cleanup)

describe('headline', () => {
  it('names each outcome and kind', () => {
    expect(headline({ ...base, outcome: 'extracted', kind: 'raid' })).toBe('CARGO EXTRACTED')
    expect(headline({ ...base, outcome: 'extracted', kind: 'sabotage' })).toBe('LINE DESTROYED')
    expect(headline({ ...base, outcome: 'extracted', kind: 'recovery' })).toBe('CARGO HANDED OVER')
    expect(headline({ ...base, outcome: 'killed' })).toBe('KILLED IN ACTION · NOTHING SECURED')
    expect(headline({ ...base, outcome: 'rejected' })).toBe('RUN REJECTED')
  })
})

describe('results screen', () => {
  it('shows an extracted raid with the real figures and next steps that fit what you hold', () => {
    show({ ...base, settlement: null })
    expect(screen.getByTestId('results-headline').textContent).toBe('CARGO EXTRACTED')
    expect(screen.getByText(new RegExp(`Extracted: ${base.extracted_units} ${base.resource}`))).toBeTruthy()
    expect(screen.getByTestId('results-sell')).toBeTruthy()
    expect(screen.getByText('Watch the reaction')).toBeTruthy()
  })
  it('offers no sale and no reaction link after a death, and says nothing was secured', () => {
    show({ ...base, outcome: 'killed', extracted_units: 0, settlement: null, consequence: null, debrief: [], player_holdings: { credits: 0, cargo: 0 } })
    expect(screen.getByTestId('results-hero').getAttribute('data-outcome')).toBe('killed')
    expect(screen.queryByTestId('results-sell')).toBeNull()
    expect(screen.queryByText('Watch the reaction')).toBeNull()
  })
  it('a rejected run shows the server\'s reason', () => {
    show({ ...base, outcome: 'rejected', reason: 'too fast', settlement: null, consequence: null })
    expect(screen.getByText(/The server rejected the run: too fast/)).toBeTruthy()
  })
  it('never calls a queued settlement settled', () => {
    show({ ...base, settlement: { op_id: 'op-1', status: 'queued' } })
    expect(screen.queryByText(/Settled on NEAR testnet/)).toBeNull()
    expect(screen.getByText(/Settling on NEAR/)).toBeTruthy()
  })
})
