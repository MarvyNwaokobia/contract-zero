// Player settings: graphics, audio, subtitles, controls, interface and
// accessibility. One versioned object in this browser; older stores (v2, v1,
// cz_quality, cz_look_sens) are migrated on first read and every value is clamped,
// so a corrupt store can't break the game. Changes apply live: the game listens for
// `cz-settings` (this tab) and `storage` (other tabs).
//
// The portable part (controls, interface, accessibility, audio, subtitles) can also
// follow a signed-in player to another device (lib/preferencesSync). Graphics never
// leaves the device: what suits a desktop GPU is wrong for a laptop.
'use client'

import { useEffect, useState } from 'react'
import { DEFAULT_BINDS, normalizeBinds, type Binds } from './keybinds'

export type Quality = 'auto' | 'low' | 'medium' | 'high'
export type SubtitleSize = 's' | 'm' | 'l'
/** Follow the quality preset, or force a feature on or off. */
export type Override = 'preset' | 'on' | 'off'
export type PostFx = 'preset' | 'off' | 'light' | 'full'
export type HoldOrToggle = 'hold' | 'toggle'
export type CrosshairStyle = 'cross' | 'dot' | 'circle' | 'cross-dot'
export type Palette = 'standard' | 'redgreen' | 'tritan'
export type AimAssist = 'touch' | 'always' | 'off'

export interface AudioMix { master: number; music: number; effects: number; voice: number; ambience: number; ui: number }

export interface Graphics {
  /** Share of the preset's resolution actually rendered (lower = faster, softer). */
  renderScale: number
  /** Frames per second ceiling; 0 = follow the display. */
  fpsCap: number
  shadows: Override
  postFx: PostFx
  /** Set dressing: clutter props (their collision is kept, so play is identical). */
  dressing: Override
  /** Ambient dust and impact debris. */
  particles: Override
}

export interface Controls {
  /** Extra multiplier on look speed while aiming down sights. */
  adsSens: number
  invertY: boolean
  aim: HoldOrToggle
  crouch: HoldOrToggle
  binds: Binds
}

export interface Interface {
  crosshair: { style: CrosshairStyle; color: string; size: number; opacity: number; dynamic: boolean }
  hudScale: number
  /** The off-screen arrow pointing at the objective or extraction. */
  objectiveArrow: boolean
  hitMarkers: boolean
  /** The red arc showing where damage came from. */
  damageDirection: boolean
  /** Edge arrows for enemies you can't see. */
  threatArrows: boolean
  /** The secondary hints under an interaction prompt ("I · INSPECT"). */
  promptHints: boolean
  /** The frame-rate readout in the corner. */
  perfOverlay: boolean
  /** First-time tips (controls, pickups, cargo, extraction, consequences). */
  tips: boolean
}

export interface Settings {
  version: 3
  /** auto adapts to the machine during play; the rest are fixed tiers. */
  quality: Quality
  /** Field of view at the hip, degrees (aiming narrows from here). */
  fov: number
  graphics: Graphics
  audio: AudioMix
  /** Silence the game when the tab is in the background. */
  muteInBackground: boolean
  subtitles: { on: boolean; size: SubtitleSize; background: number; speakerColors: boolean }
  /** Look sensitivity multiplier over the tuned default. */
  lookSens: number
  controls: Controls
  interface: Interface
  access: {
    /** No camera shake, head bob or weapon sway; gentler hit reactions. */
    reduceMotion: boolean
    /** No full-screen hit flashes, blast flashes or flickering lights. */
    reduceFlashes: boolean
    /** The interact key toggles an interaction instead of being held for it. */
    toggleInteract: boolean
    /** Colours for hostile, objective, success and health that stay distinct. */
    palette: Palette
    /** Interaction prompts on a solid panel with a heavier key cap. */
    highContrastPrompts: boolean
    /** Gentle aim pull toward a visible enemy while firing or aiming. */
    aimAssist: AimAssist
    /** The target-lock key snaps onto the nearest visible enemy. */
    targetLock: boolean
  }
}

const KEY = 'cz_settings'
export const VERSION = 3
export const FOV_RANGE: [number, number] = [50, 80]
export const SENS_RANGE: [number, number] = [0.3, 2.5]
export const ADS_SENS_RANGE: [number, number] = [0.3, 1.5]
export const RENDER_SCALE_RANGE: [number, number] = [0.5, 1]
export const HUD_SCALE_RANGE: [number, number] = [0.75, 1.4]
export const CROSSHAIR_SIZE_RANGE: [number, number] = [0.6, 2]
export const FPS_CAPS = [0, 30, 60, 120] as const
export const CROSSHAIR_COLORS = ['#e9edf2', '#5fe0a8', '#f0e442', '#37d0e0', '#ff6ad5', '#ffb454'] as const

export function defaultQuality(): Exclude<Quality, 'auto'> {
  if (typeof navigator === 'undefined') return 'medium'
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  const cores = navigator.hardwareConcurrency ?? 4
  if ((mem !== undefined && mem < 4) || cores <= 2) return 'low'
  return cores >= 8 ? 'high' : 'medium'
}

export const DEFAULT_GRAPHICS: Graphics = { renderScale: 1, fpsCap: 0, shadows: 'preset', postFx: 'preset', dressing: 'preset', particles: 'preset' }
export const DEFAULT_CONTROLS: Controls = { adsSens: 1, invertY: false, aim: 'hold', crouch: 'hold', binds: DEFAULT_BINDS }
export const DEFAULT_INTERFACE: Interface = {
  crosshair: { style: 'cross', color: '#e9edf2', size: 1, opacity: 0.9, dynamic: true },
  hudScale: 1, objectiveArrow: true, hitMarkers: true, damageDirection: true, threatArrows: true, promptHints: true, perfOverlay: false, tips: true,
}
export const DEFAULT_ACCESS: Settings['access'] = {
  reduceMotion: false, reduceFlashes: false, toggleInteract: false, palette: 'standard', highContrastPrompts: false, aimAssist: 'touch', targetLock: true,
}

export const DEFAULTS: Settings = {
  version: 3,
  quality: 'auto',
  fov: 55,
  graphics: DEFAULT_GRAPHICS,
  audio: { master: 0.9, music: 0.5, effects: 1, voice: 1, ambience: 0.8, ui: 0.8 },
  muteInBackground: true,
  subtitles: { on: true, size: 'm', background: 0.45, speakerColors: true },
  lookSens: 1,
  controls: DEFAULT_CONTROLS,
  interface: DEFAULT_INTERFACE,
  access: DEFAULT_ACCESS,
}

const clamp = (v: unknown, [lo, hi]: [number, number], d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)
const unit = (v: unknown, d: number) => clamp(v, [0, 1], d)
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
function pick<T extends string>(v: unknown, allowed: readonly T[], d: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : d
}
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

/** Read whatever is stored (any version, partial or corrupt) into a valid Settings. */
export function normalize(raw: unknown, legacy: { quality?: string | null; sens?: string | null } = {}): Settings {
  const s = obj(raw)
  const q = (s.quality ?? legacy.quality) as unknown
  const a = obj(s.audio), sub = obj(s.subtitles), acc = obj(s.access), g = obj(s.graphics), c = obj(s.controls), ui = obj(s.interface), ch = obj(ui.crosshair)
  const fpsCap = typeof g.fpsCap === 'number' && (FPS_CAPS as readonly number[]).includes(g.fpsCap) ? g.fpsCap : 0
  return {
    version: 3,
    quality: pick(q, ['auto', 'low', 'medium', 'high'] as const, DEFAULTS.quality),
    fov: clamp(s.fov, FOV_RANGE, DEFAULTS.fov),
    graphics: {
      renderScale: clamp(g.renderScale, RENDER_SCALE_RANGE, 1),
      fpsCap,
      shadows: pick(g.shadows, ['preset', 'on', 'off'] as const, 'preset'),
      postFx: pick(g.postFx, ['preset', 'off', 'light', 'full'] as const, 'preset'),
      dressing: pick(g.dressing, ['preset', 'on', 'off'] as const, 'preset'),
      particles: pick(g.particles, ['preset', 'on', 'off'] as const, 'preset'),
    },
    audio: {
      master: unit(a.master, DEFAULTS.audio.master), music: unit(a.music, DEFAULTS.audio.music), effects: unit(a.effects, DEFAULTS.audio.effects),
      voice: unit(a.voice, DEFAULTS.audio.voice), ambience: unit(a.ambience, DEFAULTS.audio.ambience), ui: unit(a.ui, DEFAULTS.audio.ui),
    },
    muteInBackground: bool(s.muteInBackground, DEFAULTS.muteInBackground),
    subtitles: {
      on: bool(sub.on, true),
      size: pick(sub.size, ['s', 'm', 'l'] as const, 'm'),
      background: unit(sub.background, DEFAULTS.subtitles.background),
      speakerColors: bool(sub.speakerColors, true),
    },
    lookSens: clamp(s.lookSens ?? (legacy.sens ? Number(legacy.sens) : undefined), SENS_RANGE, 1),
    controls: {
      adsSens: clamp(c.adsSens, ADS_SENS_RANGE, 1),
      invertY: bool(c.invertY, false),
      aim: pick(c.aim, ['hold', 'toggle'] as const, 'hold'),
      crouch: pick(c.crouch, ['hold', 'toggle'] as const, 'hold'),
      binds: normalizeBinds(c.binds),
    },
    interface: {
      crosshair: {
        style: pick(ch.style, ['cross', 'dot', 'circle', 'cross-dot'] as const, 'cross'),
        color: pick(ch.color, CROSSHAIR_COLORS, DEFAULT_INTERFACE.crosshair.color),
        size: clamp(ch.size, CROSSHAIR_SIZE_RANGE, 1),
        opacity: clamp(ch.opacity, [0.2, 1], 0.9),
        dynamic: bool(ch.dynamic, true),
      },
      hudScale: clamp(ui.hudScale, HUD_SCALE_RANGE, 1),
      objectiveArrow: bool(ui.objectiveArrow, true),
      hitMarkers: bool(ui.hitMarkers, true),
      damageDirection: bool(ui.damageDirection, true),
      threatArrows: bool(ui.threatArrows, true),
      promptHints: bool(ui.promptHints, true),
      perfOverlay: bool(ui.perfOverlay, false),
      tips: bool(ui.tips, true),
    },
    access: {
      reduceMotion: bool(acc.reduceMotion, false),
      reduceFlashes: bool(acc.reduceFlashes, false),
      toggleInteract: bool(acc.toggleInteract, false),
      palette: pick(acc.palette, ['standard', 'redgreen', 'tritan'] as const, 'standard'),
      highContrastPrompts: bool(acc.highContrastPrompts, false),
      aimAssist: pick(acc.aimAssist, ['touch', 'always', 'off'] as const, 'touch'),
      targetLock: bool(acc.targetLock, true),
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
    return normalize(null)
  }
}

export function saveSettings(s: Settings, opts: { source?: 'local' | 'account' } = {}) {
  const n = normalize(s)
  try {
    const before = localStorage.getItem(KEY)
    localStorage.setItem(KEY, JSON.stringify(n))
    // When the portable part last changed on this device, for account sync. A graphics
    // change doesn't count: it never leaves the device.
    const changed = !before || JSON.stringify(portable(normalize(JSON.parse(before)))) !== JSON.stringify(portable(n))
    if (opts.source !== 'account' && changed) localStorage.setItem('cz_settings_at', String(Date.now()))
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

// ── Account-portable part ─────────────────────────────────────────────────────


export function portable(s: Settings): Record<string, unknown> {
  // lookSens lives at the top level for compatibility; it travels inside controls.
  return { controls: { ...s.controls, lookSens: s.lookSens }, interface: s.interface, access: s.access, audio: s.audio, subtitles: s.subtitles }
}

/** Overlay an account's stored preferences onto this device's settings. Graphics,
 *  quality and FOV stay as this device has them. */
export function withPortable(local: Settings, remote: unknown): Settings {
  const r = obj(remote)
  const rc = obj(r.controls)
  return normalize({
    ...local,
    controls: r.controls ? { ...local.controls, ...rc } : local.controls,
    lookSens: typeof rc.lookSens === 'number' ? rc.lookSens : local.lookSens,
    interface: r.interface ? { ...local.interface, ...obj(r.interface), crosshair: { ...local.interface.crosshair, ...obj(obj(r.interface).crosshair) } } : local.interface,
    access: r.access ? { ...local.access, ...obj(r.access) } : local.access,
    audio: r.audio ? { ...local.audio, ...obj(r.audio) } : local.audio,
    subtitles: r.subtitles ? { ...local.subtitles, ...obj(r.subtitles) } : local.subtitles,
  })
}

// ── Quality ──────────────────────────────────────────────────────────────────

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

/** What the fight renders, from the tier in force plus the player's overrides. */
export interface RenderPlan { shadows: boolean; post: 'off' | 'light' | 'full'; dressing: boolean; particles: boolean; dprMax: number; dprMin: number }

export function renderPlan(tier: Exclude<Quality, 'auto'>, g: Graphics, touch: boolean): RenderPlan {
  const low = tier === 'low'
  const ov = (o: Override, preset: boolean) => (o === 'preset' ? preset : o === 'on')
  const presetPost: RenderPlan['post'] = low ? 'off' : (touch || tier === 'medium') ? 'light' : 'full'
  const base = low ? 1 : (touch || tier === 'medium') ? 1.5 : 2
  const dprMax = Math.max(0.5, Math.round(base * g.renderScale * 100) / 100)
  return {
    shadows: ov(g.shadows, !low),
    post: g.postFx === 'preset' ? presetPost : g.postFx,
    dressing: ov(g.dressing, !low),
    particles: ov(g.particles, !low),
    dprMax,
    dprMin: Math.min(dprMax, low ? dprMax : 1 * g.renderScale),
  }
}

// ── Colour palettes ──────────────────────────────────────────────────────────

export interface PaletteColors { hostile: string; objective: string; success: string; healthHi: string; healthLo: string }

/** Standard, plus two built on the Okabe–Ito set: red–green safe (protanopia and
 *  deuteranopia) and blue–yellow safe (tritanopia). Each keeps hostile, objective and
 *  success apart by hue and brightness, and every one is also labelled in text. */
export const PALETTES: Record<Palette, PaletteColors> = {
  standard: { hostile: '#ff5a3a', objective: '#37d0e0', success: '#5fe0a8', healthHi: '#5fd08a', healthLo: '#ff4a3a' },
  redgreen: { hostile: '#e69f00', objective: '#56b4e9', success: '#f0e442', healthHi: '#56b4e9', healthLo: '#e69f00' },
  tritan: { hostile: '#ff4d6d', objective: '#cc79a7', success: '#2ec4b6', healthHi: '#2ec4b6', healthLo: '#ff4d6d' },
}
