import { describe, it, expect } from 'vitest'
import { normalize, DEFAULTS, fixedTier } from '../settings'

describe('settings', () => {
  it('fills a missing or corrupt store with defaults', () => {
    expect(normalize(null)).toEqual(DEFAULTS)
    expect(normalize('garbage')).toEqual(DEFAULTS)
    expect(normalize({ audio: { master: 'loud' }, fov: NaN })).toEqual(DEFAULTS)
  })
  it('clamps out-of-range values instead of trusting them', () => {
    const s = normalize({ fov: 400, lookSens: 99, audio: { master: -3, voice: 7 }, subtitles: { background: 5, size: 'xl' } })
    expect(s.fov).toBe(80)
    expect(s.lookSens).toBe(2.5)
    expect([s.audio.master, s.audio.voice]).toEqual([0, 1])
    expect(s.subtitles).toMatchObject({ background: 1, size: 'm' })
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
