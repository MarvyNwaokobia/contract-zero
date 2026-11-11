import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ScreenTip } from '../ScreenTip'
import { AdvancedSwitch, ExchangeAdvanced, ValidationRecord } from '../AdvancedView'
import { TIPS, tipSeen } from '@/lib/tutorial'
import type { AgentEvent, MarketView } from '@/lib/api'

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('screen tips', () => {
  it('cover Intel, Exchange and the War Table as first-visit tips', () => {
    for (const t of ['intel', 'exchange', 'table']) expect(TIPS).toContain(t)
  })
  it('show once, are not modal, and are gone after Got it', async () => {
    render(<ScreenTip tip="exchange" title="How the Exchange works"><p>Body</p></ScreenTip>)
    const tip = await screen.findByTestId('tip-exchange')
    expect(tip.getAttribute('role')).toBe('note') // inline, not a dialog
    fireEvent.click(screen.getByTestId('tip-exchange-close'))
    expect(screen.queryByTestId('tip-exchange')).toBeNull()
    expect(tipSeen('exchange')).toBe(true)
  })
  it('a returning player who has seen it gets nothing', () => {
    localStorage.setItem('cz_tips_seen', JSON.stringify(['intel']))
    render(<ScreenTip tip="intel" title="Reading a contract"><p>Body</p></ScreenTip>)
    expect(screen.queryByTestId('tip-intel')).toBeNull()
  })
  it('turning tips off in Settings hides them', () => {
    localStorage.setItem('cz_settings', JSON.stringify({ interface: { tips: false } }))
    render(<ScreenTip tip="table" title="Reading the War Table"><p>Body</p></ScreenTip>)
    expect(screen.queryByTestId('tip-table')).toBeNull()
  })
})

const market = { tick: 3, tick_secs: 60, settlement: 'off_chain', controller: null, merchants: [], orders: [] } as MarketView
const decision = { seq: 9, tick: 4, source: 'vanguard', kind: 'decision', payload: { planner: 'rules', trigger: 'shortage', action: { kind: 'order' }, validation: 'rejected', error: 'over reserve' } } as AgentEvent

describe('advanced view', () => {
  it('is off by default: nothing about contracts, tokens or validation shows', () => {
    render(<><AdvancedSwitch /><ExchangeAdvanced m={market} /><ValidationRecord e={decision} /></>)
    expect(screen.queryByTestId('advanced-exchange')).toBeNull()
    expect(screen.queryByTestId('advanced-validation')).toBeNull()
  })
  it('turning it on shows the real plumbing, and says so plainly when there is none', async () => {
    render(<><AdvancedSwitch /><ExchangeAdvanced m={market} /><ValidationRecord e={decision} /></>)
    await act(async () => { fireEvent.click(screen.getByTestId('advanced-switch')) })
    expect(screen.getByTestId('advanced-exchange').textContent).toContain('Off-chain')
    expect(screen.getByTestId('advanced-exchange').textContent).toContain('orders are not escrowed on chain')
    const v = screen.getByTestId('advanced-validation').textContent!
    expect(v).toContain('rejected'); expect(v).toContain('over reserve'); expect(v).toContain('"kind":"order"')
  })
  it('is remembered, and one switch drives every screen', async () => {
    localStorage.setItem('cz_advanced', '1')
    render(<ValidationRecord e={decision} />)
    expect(await screen.findByTestId('advanced-validation')).toBeTruthy()
  })
})
