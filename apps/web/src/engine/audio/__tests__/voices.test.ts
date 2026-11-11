import { describe, expect, it } from 'vitest'
import { loadLimit, VoiceBudget } from '../voices'

const v = (over: Partial<Parameters<VoiceBudget['request']>[0]> = {}) => ({ key: 'k', channel: 'combat' as const, priority: 50, durationMs: 1000, ...over })

describe('voice budget', () => {
  it('lower priorities are refused first as load climbs; critical never is', () => {
    const b = new VoiceBudget({ max: 8 })
    // fill 4 voices with distinct keys (no cooldown): the lowest tier (limit 4) is now full
    for (let i = 0; i < 4; i++) expect(b.request(v({ key: `a${i}`, priority: 70 }), 0).ok).toBe(true)
    expect(b.request(v({ key: 'step', priority: 20 }), 0)).toEqual({ ok: false, why: 'load' })
    expect(b.request(v({ key: 'impact', priority: 40 }), 0).ok).toBe(true) // mid tier limit 6
    for (let i = 0; i < 3; i++) b.request(v({ key: `b${i}`, priority: 70 }), 0)
    expect(b.count(0)).toBe(8)
    expect(b.request(v({ key: 'late-mid', priority: 40 }), 0)).toEqual({ ok: false, why: 'load' })
    expect(b.request(v({ key: 'shot', priority: 100 }), 0).ok).toBe(true) // critical gets through a full budget
  })
  it('a voice frees its slot when it ends', () => {
    const b = new VoiceBudget({ max: 2 })
    expect(b.request(v({ key: 'a', priority: 70, durationMs: 100 }), 0).ok).toBe(true)
    expect(b.request(v({ key: 'b', priority: 70, durationMs: 100 }), 0).ok).toBe(true)
    expect(b.request(v({ key: 'c', priority: 70 }), 50).ok).toBe(false)
    expect(b.request(v({ key: 'c', priority: 70 }), 150).ok).toBe(true)
  })
  it('a per-sound cooldown stops one event stacking copies', () => {
    const b = new VoiceBudget({ max: 40, cooldownMs: { impact: 30 } })
    expect(b.request(v({ key: 'impact' }), 0).ok).toBe(true)
    expect(b.request(v({ key: 'impact' }), 10)).toEqual({ ok: false, why: 'cooldown' })
    expect(b.request(v({ key: 'impact' }), 31).ok).toBe(true)
    expect(b.request(v({ key: 'other' }), 31).ok).toBe(true)
  })
  it('a channel cap applies to everything short of critical', () => {
    const b = new VoiceBudget({ max: 40, perChannel: { interactions: 2 } })
    expect(b.request(v({ key: 'a', channel: 'interactions', priority: 30 }), 0).ok).toBe(true)
    expect(b.request(v({ key: 'b', channel: 'interactions', priority: 30 }), 0).ok).toBe(true)
    expect(b.request(v({ key: 'c', channel: 'interactions', priority: 30 }), 0)).toEqual({ ok: false, why: 'channel' })
    expect(b.request(v({ key: 'd', channel: 'combat', priority: 30 }), 0).ok).toBe(true)
  })
  it('counts what it refuses, for the performance probe', () => {
    const b = new VoiceBudget({ max: 1, cooldownMs: { x: 100 } })
    b.request(v({ key: 'x', priority: 70 }), 0)
    b.request(v({ key: 'x', priority: 70 }), 5)
    b.request(v({ key: 'y', priority: 70 }), 5)
    expect(b.refused).toEqual({ cooldown: 1, load: 1, channel: 0 })
    expect(b.granted).toBe(1)
  })
  it('load limits step down by tier', () => {
    expect([100, 70, 40, 10].map((p) => loadLimit(p, 20))).toEqual([Infinity, 20, 15, 10])
  })
})
