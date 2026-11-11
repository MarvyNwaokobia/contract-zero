import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { usePageVisible } from '../usePageVisible'

const setHidden = (v: boolean) => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => v }); document.dispatchEvent(new Event('visibilitychange')) }
afterEach(() => { cleanup(); setHidden(false) })

describe('usePageVisible', () => {
  it('is true while the page is on screen, false when it is hidden, and true again on return', () => {
    const { result } = renderHook(() => usePageVisible())
    expect(result.current).toBe(true)
    act(() => setHidden(true)); expect(result.current).toBe(false)
    act(() => setHidden(false)); expect(result.current).toBe(true)
  })
  it('starts false if the page is already hidden when it mounts', () => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    const { result } = renderHook(() => usePageVisible())
    expect(result.current).toBe(false)
  })
})
