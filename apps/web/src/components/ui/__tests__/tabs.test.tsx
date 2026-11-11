import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Tabs } from '../Tabs'

const tabs = [{ id: 'a', label: 'Alpha', panel: <p>A body</p> }, { id: 'b', label: 'Beta', badge: 3, panel: <p>B body</p> }, { id: 'c', label: 'Gamma', panel: <p>C body</p> }]
beforeEach(() => { window.location.hash = '' })
afterEach(cleanup)

describe('tabs', () => {
  it('shows the first panel and keeps the others mounted but hidden', () => {
    render(<Tabs tabs={tabs} label="Sections" />)
    expect(screen.getByRole('tab', { name: /Alpha/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('A body').closest('[role=tabpanel]')!.hasAttribute('hidden')).toBe(false)
    expect(screen.getByText('B body', { selector: 'p' }).closest('[role=tabpanel]')!.hasAttribute('hidden')).toBe(true)
  })
  it('moves with the arrow keys, Home and End, with roving tab stops', () => {
    render(<Tabs tabs={tabs} label="Sections" />)
    const a = screen.getByTestId('tab-a')
    fireEvent.keyDown(a, { key: 'ArrowRight' })
    expect(screen.getByTestId('tab-b').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('tab-a').getAttribute('tabindex')).toBe('-1')
    fireEvent.keyDown(screen.getByTestId('tab-b'), { key: 'End' })
    expect(screen.getByTestId('tab-c').getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByTestId('tab-c'), { key: 'ArrowRight' })
    expect(screen.getByTestId('tab-a').getAttribute('aria-selected')).toBe('true') // wraps
  })
  it('remembers the tab in the URL hash and honours it on load', () => {
    window.location.hash = '#c'
    render(<Tabs tabs={tabs} label="Sections" />)
    expect(screen.getByTestId('tab-c').getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByTestId('tab-b'))
    expect(window.location.hash).toBe('#b')
  })
  it('shows a badge count', () => {
    render(<Tabs tabs={tabs} label="Sections" />)
    expect(screen.getByTestId('tab-b').textContent).toContain('3')
  })
})
