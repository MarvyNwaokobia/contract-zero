import { describe, it, expect } from 'vitest'
import { normalize, DEFAULTS, fixedTier, portable, renderPlan, withPortable, DEFAULT_GRAPHICS } from '../settings'

describe('settings', () => {
  it('fills a missing or corrupt store with defaults', () => {
    expect(normalize(null)).toEqual(DEFAULTS)
    expect(normalize('garbage')).toEqual(DEFAULTS)
    expect(normalize([1, 2, 3])).toEqual(DEFAULTS)
    expect(normalize({ audio: { master: 'loud' }, fov: NaN, graphics: 7, controls: 'x', interface: null })).toEqual(DEFAULTS)
  })
  it('clamps out-of-range values instead of trusting them', () => {
    const s = normalize({ fov: 400, lookSens: 99, audio: { master: -3, voice: 7, music: 9 }, subtitles: { background: 5, size: 'xl' } })
    expect(s.fov).toBe(80)
    expect(s.lookSens).toBe(2.5)
    expect([s.audio.master, s.audio.voice, s.audio.music]).toEqual([0, 1, 1])
    expect(s.subtitles).toMatchObject({ background: 1, size: 'm' })
  })
  it('refuses invalid graphics, control and interface values', () => {
    const s = normalize({
      graphics: { renderScale: 0.1, fpsCap: 47, shadows: 'maybe', postFx: 'ultra', dressing: 'on', particles: 'off' },
      controls: { adsSens: 40, invertY: 'yes', aim: 'press', crouch: 'toggle' },
      interface: { hudScale: 9, crosshair: { style: 'star', color: 'red', size: -1, opacity: 3, dynamic: 0 } },
      access: { palette: 'neon', aimAssist: 'aimbot', targetLock: false },
    })
    expect(s.graphics).toEqual({ renderScale: 0.5, fpsCap: 0, shadows: 'preset', postFx: 'preset', dressing: 'on', particles: 'off' })
    expect(s.controls).toMatchObject({ adsSens: 1.5, invertY: false, aim: 'hold', crouch: 'toggle' })
    expect(s.interface.hudScale).toBe(1.4)
    expect(s.interface.crosshair).toEqual({ style: 'cross', color: '#e9edf2', size: 0.6, opacity: 1, dynamic: true })
    expect(s.access).toMatchObject({ palette: 'standard', aimAssist: 'touch', targetLock: false })
  })
  it('migrates v2 stores without losing anything', () => {
    const v2 = { version: 2, quality: 'medium', fov: 70, audio: { master: 0.5, effects: 0.4, voice: 0.3, ambience: 0.2, ui: 0.1 }, muteInBackground: false, subtitles: { on: false, size: 'l', background: 0.2, speakerColors: false }, lookSens: 1.8, access: { reduceMotion: true, reduceFlashes: true, toggleInteract: true } }
    const s = normalize(v2)
    expect(s.version).toBe(3)
    expect(s).toMatchObject({ quality: 'medium', fov: 70, muteInBackground: false, lookSens: 1.8 })
    expect(s.audio).toEqual({ master: 0.5, music: DEFAULTS.audio.music, effects: 0.4, voice: 0.3, ambience: 0.2, ui: 0.1 })
    expect(s.access).toMatchObject({ reduceMotion: true, reduceFlashes: true, toggleInteract: true, palette: 'standard' })
    expect(s.controls).toEqual(DEFAULTS.controls)
  })
  it('migrates the older keys', () => {
    expect(normalize({ quality: 'low' }).quality).toBe('low') // cz_settings v1
    expect(normalize(null, { quality: 'high', sens: '1.7' })).toMatchObject({ quality: 'high', lookSens: 1.7 }) // cz_quality + cz_look_sens
  })
  it('auto maps to a fixed tier where a scene cannot adapt', () => {
    expect(['low', 'medium', 'high']).toContain(fixedTier('auto'))
    expect(fixedTier('medium')).toBe('medium')
  })
})

describe('render plan', () => {
  it('follows the preset by default', () => {
    expect(renderPlan('high', DEFAULT_GRAPHICS, false)).toEqual({ shadows: true, post: 'full', dressing: true, particles: true, dprMax: 2, dprMin: 1 })
    expect(renderPlan('medium', DEFAULT_GRAPHICS, false)).toMatchObject({ shadows: true, post: 'light', dprMax: 1.5 })
    expect(renderPlan('low', DEFAULT_GRAPHICS, false)).toEqual({ shadows: false, post: 'off', dressing: false, particles: false, dprMax: 1, dprMin: 1 })
    expect(renderPlan('high', DEFAULT_GRAPHICS, true)).toMatchObject({ post: 'light', dprMax: 1.5 })
  })
  it('applies overrides and the resolution scale', () => {
    const p = renderPlan('low', { ...DEFAULT_GRAPHICS, shadows: 'on', postFx: 'full', particles: 'on', renderScale: 0.5 }, false)
    expect(p).toMatchObject({ shadows: true, post: 'full', dressing: false, particles: true, dprMax: 0.5, dprMin: 0.5 })
    expect(renderPlan('high', { ...DEFAULT_GRAPHICS, shadows: 'off', renderScale: 0.75 }, false)).toMatchObject({ shadows: false, dprMax: 1.5, dprMin: 0.75 })
  })
})

describe('account-portable part', () => {
  it('carries controls, interface, access, audio and subtitles, never graphics', () => {
    const p = portable(normalize({ quality: 'low', fov: 77, lookSens: 2, controls: { invertY: true } }))
    expect(Object.keys(p).sort()).toEqual(['access', 'audio', 'controls', 'interface', 'subtitles'])
    expect(p.controls).toMatchObject({ invertY: true, lookSens: 2 })
    expect(JSON.stringify(p)).not.toContain('renderScale')
  })
  it('overlays remote preferences but keeps this device’s graphics', () => {
    const local = normalize({ quality: 'high', fov: 60, graphics: { shadows: 'off' } })
    const merged = withPortable(local, { controls: { invertY: true, lookSens: 1.5 }, interface: { crosshair: { style: 'dot' } }, graphics: { shadows: 'on' }, quality: 'low' })
    expect(merged).toMatchObject({ quality: 'high', fov: 60, lookSens: 1.5 })
    expect(merged.graphics.shadows).toBe('off')
    expect(merged.controls.invertY).toBe(true)
    expect(merged.interface.crosshair).toMatchObject({ style: 'dot', color: '#e9edf2' })
  })
  it('a corrupt remote document cannot break local settings', () => {
    const local = normalize({ lookSens: 1.2 })
    expect(withPortable(local, 'nonsense')).toEqual(local)
    expect(withPortable(local, { controls: { binds: { fire: ['Escape', 'F5'] }, adsSens: 'x' } }).controls.binds.fire).toEqual([null, null])
  })
})
