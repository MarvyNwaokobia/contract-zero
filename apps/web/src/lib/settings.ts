// Player settings kept in this browser: graphics, audio, subtitles, controls and
// accessibility. One versioned object; older keys (cz_settings v1, cz_quality,
// cz_look_sens) are migrated on first read. Changes apply live: the game listens
// for `cz-settings` (this tab) and `storage` (other tabs).
'use client'

import { useEffect, useState } from 'react'

export type Quality = 'auto' | 'low' | 'medium' | 'high'
export type SubtitleSize = 's' | 'm' | 'l'

export interface AudioMix { master: number; effects: number; voice: number; ambience: number; ui: number }

export interface Settings {
  version: 2
  /** auto adapts to the machine during play; the rest are fixed tiers. */
  quality: Quality
  /** Horizontal-ish field of view at the hip, degrees (aim-down-sights narrows from here). */
  fov: number
  audio: AudioMix
  /** Silence the game when the tab is in the background. */
  muteInBackground: boolean
  subtitles: { on: boolean; size: SubtitleSize; background: number; speakerColors: boolean }
  /** Look sensitivity multiplier over the tuned default. */
  lookSens: number
  access: {
    /** No camera shake, head bob or weapon sway; gentler hit reactions. */
    reduceMotion: boolean
    /** No full-screen hit flashes, blast flashes or flickering lights. */
    reduceFlashes: boolean
    /** E toggles an interaction instead of being held for it. */
    toggleInteract: boolean
  }
}

const KEY = 'cz_settings'
export const FOV_RANGE: [number, number] = [50, 80]
export const SENS_RANGE: [number, number] = [0.3, 2.5]

export function defaultQuality(): Exclude<Quality, 'auto'> {
  if (typeof navigator === 'undefined') return 'medium'
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  const cores = navigator.hardwareConcurrency ?? 4
  if ((mem !== undefined && mem < 4) || cores <= 2) return 'low'
  return cores >= 8 ? 'high' : 'medium'
}

export const DEFAULTS: Settings = {
  version: 2,
  quality: 'auto',
  fov: 55,
  audio: { master: 0.9, effects: 1, voice: 1, ambience: 0.8, ui: 0.8 },
  muteInBackground: true,
  subtitles: { on: true, size: 'm', background: 0.45, speakerColors: true },
  lookSens: 1,
  access: { reduceMotion: false, reduceFlashes: false, toggleInteract: false },
}

const clamp = (v: unknown, [lo, hi]: [number, number], d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)
const unit = (v: unknown, d: number) => clamp(v, [0, 1], d)

/** Read whatever is stored (any version, partial or corrupt) into a valid Settings. */
export function normalize(raw: unknown, legacy: { quality?: string | null; sens?: string | null } = {}): Settings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings> & { quality?: string }
  const q = (s.quality ?? legacy.quality) as string | undefined
  const quality: Quality = q === 'auto' || q === 'low' || q === 'medium' || q === 'high' ? q : DEFAULTS.quality
  const a = (s.audio ?? {}) as Partial<AudioMix>
  const sub = (s.subtitles ?? {}) as Partial<Settings['subtitles']>
  const acc = (s.access ?? {}) as Partial<Settings['access']>
  return {
    version: 2,
    quality,
    fov: clamp(s.fov, FOV_RANGE, DEFAULTS.fov),
    audio: {
      master: unit(a.master, DEFAULTS.audio.master), effects: unit(a.effects, DEFAULTS.audio.effects),
      voice: unit(a.voice, DEFAULTS.audio.voice), ambience: unit(a.ambience, DEFAULTS.audio.ambience), ui: unit(a.ui, DEFAULTS.audio.ui),
    },
    muteInBackground: typeof s.muteInBackground === 'boolean' ? s.muteInBackground : DEFAULTS.muteInBackground,
    subtitles: {
      on: typeof sub.on === 'boolean' ? sub.on : true,
      size: sub.size === 's' || sub.size === 'm' || sub.size === 'l' ? sub.size : 'm',
      background: unit(sub.background, DEFAULTS.subtitles.background),
      speakerColors: typeof sub.speakerColors === 'boolean' ? sub.speakerColors : true,
    },
    lookSens: clamp(s.lookSens ?? (legacy.sens ? Number(legacy.sens) : undefined), SENS_RANGE, 1),
    access: {
      reduceMotion: !!acc.reduceMotion,
      reduceFlashes: !!acc.reduceFlashes,
      toggleInteract: !!acc.toggleInteract,
    },
  }
}

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    const s = normalize(raw, { quality: localStorage.getItem('cz_quality'), sens: localStorage.getItem('cz_look_sens') })
    // The system's own preference is the default for players who haven't chosen.
    if (!raw?.access && typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) s.access.reduceMotion = true
    return s
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(s: Settings) {
  const n = normalize(s)
  try {
    localStorage.setItem(KEY, JSON.stringify(n))
    // Keep the scene's legacy keys in step for any older reader.
    localStorage.setItem('cz_look_sens', String(n.lookSens))
    localStorage.setItem('cz_quality', n.quality === 'medium' ? 'auto' : n.quality)
  } catch { /* private mode */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<Settings>('cz-settings', { detail: n }))
}

export function updateSettings(patch: (s: Settings) => Settings): Settings {
  const next = normalize(patch(loadSettings()))
  saveSettings(next)
  return next
}

/** The live settings: re-renders when they change in this tab or another. */
export function useSettings(): Settings {
  const [s, setS] = useState<Settings>(DEFAULTS)
  useEffect(() => {
    setS(loadSettings())
    const onLocal = (e: Event) => setS((e as CustomEvent<Settings>).detail)
    const onOther = (e: StorageEvent) => { if (e.key === KEY) setS(loadSettings()) }
    window.addEventListener('cz-settings', onLocal)
    window.addEventListener('storage', onOther)
    return () => { window.removeEventListener('cz-settings', onLocal); window.removeEventListener('storage', onOther) }
  }, [])
  return s
}

/** What each fixed tier costs in the hangar scene: pixel ratio cap, shadows, particles, lights. */
export const QUALITY: Record<Exclude<Quality, 'auto'>, { dpr: [number, number]; shadows: boolean; dust: number; lamps: number }> = {
  low: { dpr: [0.75, 1], shadows: false, dust: 120, lamps: 1 },
  medium: { dpr: [1, 1.5], shadows: false, dust: 320, lamps: 3 },
  high: { dpr: [1, 2], shadows: true, dust: 700, lamps: 4 },
}

/** The fixed tier to use where a scene can't adapt live (auto → this machine's guess). */
export function fixedTier(q: Quality): Exclude<Quality, 'auto'> {
  return q === 'auto' ? defaultQuality() : q
}
