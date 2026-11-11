import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FpsAudio } from '../FpsAudio'
import { FakeAudioContext, FakeNode, FakeParam } from './fakeAudioContext'

type Internals = Record<string, FakeNode> & { ctx: FakeAudioContext }
const inner = (a: FpsAudio) => a as unknown as Internals
const gain = (n: FakeNode) => (n as unknown as { gain: FakeParam }).gain

let audio: FpsAudio
beforeEach(() => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
  ;(window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext
  audio = new FpsAudio()
  audio.unlock()
})
afterEach(() => { audio.dispose(); vi.unstubAllGlobals() })

describe('seven channels reach the right buses', () => {
  it('each slider sets its own bus', () => {
    audio.setMix({ master: 0.5, music: 0, effects: 0.4, voice: 0.3, ambience: 0.2, ui: 0.1, interactions: 0.7 })
    const a = inner(audio)
    expect(gain(a.master).value).toBeCloseTo(0.5)
    expect(gain(a.gunBus).value).toBeCloseTo(0.9 * 0.4)      // Combat
    expect(gain(a.impactBus).value).toBeCloseTo(0.9 * 0.4)   // Combat
    expect(gain(a.voiceBus).value).toBeCloseTo(0.3)          // Radio
    expect(gain(a.uiBus).value).toBeCloseTo(0.1)             // Interface
    expect(gain(a.interactBus).value).toBeCloseTo(0.7)       // Interactions
    expect(gain(a.musicBus).value).toBeCloseTo(0)            // Music
  })
  it('handling and footsteps are Interactions, not Combat or Interface', () => {
    const a = inner(audio)
    const before = { i: a.interactBus.inputs, u: a.uiBus.inputs, g: a.gunBus.inputs, m: a.impactBus.inputs }
    audio.footstep(); audio.reloadStart(); audio.pickup(); audio.empty()
    expect(a.interactBus.inputs).toBeGreaterThan(before.i)
    expect(a.uiBus.inputs).toBe(before.u)
    expect(a.gunBus.inputs).toBe(before.g)
    expect(a.impactBus.inputs).toBe(before.m)
  })
  it('damage, heartbeat and alarms are Combat; markers and countdown pips are Interface', () => {
    const a = inner(audio)
    let g = a.gunBus.inputs
    const u = a.uiBus.inputs
    audio.hurt(); audio.heartbeat(); audio.alarm(1)
    expect(a.gunBus.inputs).toBeGreaterThan(g)
    expect(a.uiBus.inputs).toBe(u)
    g = a.gunBus.inputs
    audio.hitmarker(false); audio.beep(true)
    expect(a.uiBus.inputs).toBeGreaterThan(u)
    expect(a.gunBus.inputs).toBe(g)
  })
})

describe('radio ducking', () => {
  it('a radio line dips music, combat and handling but never silences them, and leaves radio and interface alone', () => {
    audio.vo('dyn-test', 'handler')
    const a = inner(audio)
    expect(gain(a.musicDuck).min).toBeCloseTo(0.45)
    expect(gain(a.combatDuck).min).toBeCloseTo(0.65)
    expect(gain(a.interactDuck).min).toBeCloseTo(0.7)
    expect(gain(a.ambDuck).min).toBeCloseTo(0.5)  // the room is still there
    for (const d of ['musicDuck', 'combatDuck', 'interactDuck']) expect(gain(a[d]).min, d).toBeGreaterThan(0.3)
    // each swells back to full
    expect(gain(a.musicDuck).value).toBe(1)
    expect(gain(a.voiceBus).history).not.toContain(0)
  })
})

describe('voice budget in the live graph', () => {
  it('a burst of identical sounds is bounded instead of building a node per call', () => {
    const ctx = inner(audio).ctx as FakeAudioContext
    const before = ctx.nodesByKind.source ?? 0
    for (let i = 0; i < 200; i++) audio.footstep()
    const built = (ctx.nodesByKind.source ?? 0) - before
    expect(built).toBeLessThan(10)
    expect(audio.stats().voices.refused.cooldown).toBeGreaterThan(150)
  })
  it('the player’s own gunfire is never refused, however busy it gets', () => {
    const profile = { hpFreq: 900, noiseDur: 0.05, vol: 0.5, bodyF0: 120, bodyF1: 50, bodyDur: 0.08, thump: false } as never
    for (let i = 0; i < 100; i++) audio.shot(profile)
    expect(audio.stats().shots).toBe(100)
  })
})

describe('pause and background holds', () => {
  it('suspends once and cannot be restarted by a key press while paused', () => {
    const ctx = inner(audio).ctx as FakeAudioContext
    const resumed = ctx.resumeCalls
    audio.suspend('pause')
    expect(ctx.suspendCalls).toBe(1)
    audio.unlock() // a key press
    expect(ctx.resumeCalls).toBe(resumed)
    audio.resume('pause')
    expect(ctx.resumeCalls).toBe(resumed + 1)
  })
  it('showing a hidden tab does not un-pause a paused game, and vice versa', () => {
    const ctx = inner(audio).ctx as FakeAudioContext
    audio.suspend('pause'); audio.setBackgroundMuted(true)
    const r = ctx.resumeCalls
    audio.setBackgroundMuted(false)
    expect(ctx.resumeCalls).toBe(r)       // still paused
    expect(audio.isHeld()).toBe(true)
    audio.resume('pause')
    expect(audio.isHeld()).toBe(false)
    expect(ctx.resumeCalls).toBe(r + 1)
  })
})

describe('level meters', () => {
  it('report every channel and cost nothing until asked', () => {
    const ctx = inner(audio).ctx as FakeAudioContext
    expect(ctx.nodesByKind.analyser ?? 0).toBe(0)
    const lv = audio.levels()
    expect(Object.keys(lv).sort()).toEqual(['combat', 'environment', 'interactions', 'master', 'music', 'radio', 'ui'])
    expect(ctx.nodesByKind.analyser).toBe(7)
  })
})
