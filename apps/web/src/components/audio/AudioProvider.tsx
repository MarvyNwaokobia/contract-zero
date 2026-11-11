'use client'

// Holds the app's audio engine for its lifetime, unlocks it on the first gesture (browsers
// refuse sound before one), keeps it in step with Settings, and lets each screen choose what
// the score does through `useMusicState`.

import { useEffect } from 'react'
import { acquireAudio, peekAudio, releaseAudio } from '@/engine/audio/shared'
import type { MusicState } from '@/engine/audio/musicState'
import { useSettings } from '@/lib/settings'

const GESTURES = ['pointerdown', 'keydown', 'touchstart'] as const

export function AudioProvider({ children }: { children: React.ReactNode }) {
  const settings = useSettings()
  // The app's own reference: the engine lives as long as the app does.
  useEffect(() => {
    const audio = acquireAudio()
    const unlock = () => audio.unlock()
    for (const g of GESTURES) window.addEventListener(g, unlock, { passive: true })
    if (process.env.NODE_ENV !== 'production' || process.env.NEXT_PUBLIC_CZ_DEV_HOOKS === '1') (window as unknown as { __czAudioShared?: unknown }).__czAudioShared = audio
    return () => {
      for (const g of GESTURES) window.removeEventListener(g, unlock)
      delete (window as unknown as { __czAudioShared?: unknown }).__czAudioShared
      releaseAudio()
    }
  }, [])
  // The provider holds exactly one reference (above); these effects only look the engine up.
  useEffect(() => { peekAudio()?.setMix(settings.audio) }, [settings.audio])
  useEffect(() => {
    const apply = () => peekAudio()?.setBackgroundMuted(settings.muteInBackground && document.hidden)
    apply()
    document.addEventListener('visibilitychange', apply)
    return () => document.removeEventListener('visibilitychange', apply)
  }, [settings.muteInBackground])
  return <>{children}</>
}

/** What the score does while this screen is up. `null` leaves it to someone else (the fight drives
 *  its own); leaving the screen returns the score to silence unless the next screen sets one. */
export function useMusicState(state: MusicState | null): void {
  useEffect(() => {
    const audio = acquireAudio()
    if (state) audio.setMusicState(state)
    return () => { if (state) audio.setMusicState('silent'); releaseAudio() }
  }, [state])
}
