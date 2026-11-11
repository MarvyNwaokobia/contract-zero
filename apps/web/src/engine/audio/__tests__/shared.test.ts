import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireAudio, audioRefs, peekAudio, releaseAudio } from '../shared'
import { FakeAudioContext } from './fakeAudioContext'

beforeEach(() => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
  ;(window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext
  FakeAudioContext.created = 0
})
afterEach(() => { while (audioRefs() > 0) releaseAudio(); vi.unstubAllGlobals() })

describe('the one shared audio engine', () => {
  it('every screen gets the same instance, so there is one context however you navigate', () => {
    const a = acquireAudio(), b = acquireAudio()
    expect(a).toBe(b)
    a.unlock(); b.unlock()
    expect(FakeAudioContext.created).toBe(1)
  })
  it('it lives while anyone holds it and is disposed when the last holder lets go', () => {
    const a = acquireAudio(); acquireAudio()
    expect(audioRefs()).toBe(2)
    releaseAudio()
    expect(peekAudio()).toBe(a)
    releaseAudio()
    expect(peekAudio()).toBeNull()
    const next = acquireAudio()
    expect(next).not.toBe(a)           // a fresh engine, not a half-dead one
  })
  it('never counts below zero', () => {
    releaseAudio(); releaseAudio()
    expect(audioRefs()).toBe(0)
  })
})
