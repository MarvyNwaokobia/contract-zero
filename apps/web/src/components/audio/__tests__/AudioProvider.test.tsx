import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { AudioProvider, useMusicState } from '../AudioProvider'
import { audioRefs, peekAudio, releaseAudio } from '@/engine/audio/shared'
import { FakeAudioContext } from '@/engine/audio/__tests__/fakeAudioContext'
import type { MusicState } from '@/engine/audio/musicState'

beforeEach(() => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
  ;(window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext
  FakeAudioContext.created = 0
})
afterEach(() => { while (audioRefs() > 0) releaseAudio(); vi.unstubAllGlobals() })

const Screen = ({ state }: { state: MusicState | null }) => { useMusicState(state); return null }
const base = () => (peekAudio() as unknown as { musicBase: string }).musicBase

describe('AudioProvider and useMusicState', () => {
  it('holds the engine for the life of the app and releases it when the app goes', () => {
    const { unmount } = render(<AudioProvider><div /></AudioProvider>)
    expect(peekAudio()).toBeTruthy()
    unmount()
    expect(peekAudio()).toBeNull()
  })
  it('does not unlock sound before a gesture, and unlocks once on the first', () => {
    render(<AudioProvider><div /></AudioProvider>)
    expect(FakeAudioContext.created).toBe(0)
    act(() => { window.dispatchEvent(new Event('pointerdown')) })
    act(() => { window.dispatchEvent(new Event('keydown')) })
    expect(FakeAudioContext.created).toBe(1)
  })
  it('a screen sets its music, and leaving it returns the score to silence', () => {
    const app = render(<AudioProvider><Screen state="hub" /></AudioProvider>)
    expect(base()).toBe('hub')
    app.rerender(<AudioProvider><Screen state="table" /></AudioProvider>)
    expect(base()).toBe('table')
    app.rerender(<AudioProvider><div /></AudioProvider>)
    expect(base()).toBe('silent')
  })
  it('a screen that passes null leaves the score to someone else, such as the fight', () => {
    render(<AudioProvider><Screen state="prep" /></AudioProvider>)
    const a = peekAudio()!
    const app = render(<AudioProvider><Screen state={null} /></AudioProvider>)
    a.setMusicIntensity(2)
    expect(base()).toBe('combat')
    app.unmount()
  })
})
