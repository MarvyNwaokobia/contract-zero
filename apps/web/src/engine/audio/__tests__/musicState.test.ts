import { describe, expect, it } from 'vitest'
import { effectiveState, ENTRY_STINGER, rising, stateForIntensity, STATE_TARGETS, type MusicState } from '../musicState'

const ALL = Object.keys(STATE_TARGETS) as MusicState[]
const sum = (s: MusicState) => Object.values(STATE_TARGETS[s]).reduce((a, b) => a + b, 0)

describe('music states', () => {
  it('every state the game needs exists: hub, preparation, infiltration, detection, combat, extraction, results, table', () => {
    for (const s of ['hub', 'prep', 'infiltration', 'detection', 'combat', 'extraction', 'results', 'table'] as MusicState[]) expect(STATE_TARGETS[s], s).toBeTruthy()
  })
  it('silent is silent and nothing else is', () => {
    expect(sum('silent')).toBe(0)
    for (const s of ALL.filter((x) => x !== 'silent')) expect(sum(s), s).toBeGreaterThan(0)
  })
  it('the fight escalates by adding layers: bed, then pulse, then theme', () => {
    const t = (s: MusicState) => STATE_TARGETS[s]
    expect(t('infiltration').pulse).toBe(0)
    expect(t('detection').pulse).toBeGreaterThan(0)
    expect(t('detection').motif).toBe(0)
    expect(t('combat').motif).toBeGreaterThan(0)
    expect(sum('infiltration')).toBeLessThan(sum('detection'))
    expect(sum('detection')).toBeLessThan(sum('combat'))
    expect(sum('combat')).toBeLessThan(sum('boss'))
  })
  it('only the extraction has a riser, and it is the fullest of the non-boss states', () => {
    for (const s of ALL) expect(STATE_TARGETS[s].riser > 0, s).toBe(s === 'extraction')
    expect(sum('extraction')).toBeGreaterThan(sum('combat'))
  })
  it('every level stays under a safe ceiling (the score sits under the fight)', () => {
    for (const s of ALL) for (const v of Object.values(STATE_TARGETS[s])) expect(v).toBeLessThanOrEqual(0.7)
  })
  it('fight intensity maps onto the fight states', () => {
    expect([0, 1, 2, 3].map((l) => stateForIntensity(l as 0 | 1 | 2 | 3))).toEqual(['infiltration', 'detection', 'combat', 'boss'])
  })
  it('an override wins, and clearing it returns to the base', () => {
    expect(effectiveState('combat', 'extraction')).toBe('extraction')
    expect(effectiveState('combat', null)).toBe('combat')
  })
  it('results sounds a resolution on entry; calm states do not', () => {
    expect(ENTRY_STINGER.results).toBe('resolve')
    expect(ENTRY_STINGER.hub).toBeUndefined()
  })
  it('going up adds layers (a slow swell); coming down only relaxes (a quick fall)', () => {
    expect(rising('infiltration', 'combat')).toBe(true)
    expect(rising('combat', 'infiltration')).toBe(false)
    expect(rising('combat', 'results')).toBe(false)
    expect(rising('silent', 'hub')).toBe(true)
  })
})
