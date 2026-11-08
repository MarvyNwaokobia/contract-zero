// Player settings kept in this browser (graphics now; audio and subtitles join in M8).
'use client'

export type Quality = 'low' | 'medium' | 'high'

export interface Settings {
  quality: Quality
}

const KEY = 'cz_settings'

export function defaultQuality(): Quality {
  if (typeof navigator === 'undefined') return 'medium'
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  const cores = navigator.hardwareConcurrency ?? 4
  if ((mem !== undefined && mem < 4) || cores <= 2) return 'low'
  return cores >= 8 ? 'high' : 'medium'
}

export function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Settings> | null
    return { quality: s?.quality ?? defaultQuality() }
  } catch {
    return { quality: defaultQuality() }
  }
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* private mode */ }
}

/** What each preset costs: pixel ratio cap, shadows, particle count, light count. */
export const QUALITY: Record<Quality, { dpr: [number, number]; shadows: boolean; dust: number; lamps: number }> = {
  low: { dpr: [0.75, 1], shadows: false, dust: 120, lamps: 1 },
  medium: { dpr: [1, 1.5], shadows: false, dust: 320, lamps: 3 },
  high: { dpr: [1, 2], shadows: true, dust: 700, lamps: 4 },
}
