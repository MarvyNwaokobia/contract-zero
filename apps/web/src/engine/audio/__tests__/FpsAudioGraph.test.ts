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
    expect(gain(a.envBus).value).toBeCloseTo(0.2)            // Environment (the site's positional sounds)
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
    expect(ctx.nodesByKind.processor ?? 0).toBe(0)
    const lv = audio.levels()
    expect(Object.keys(lv).sort()).toEqual(['combat', 'environment', 'interactions', 'master', 'music', 'radio', 'ui'])
    expect(ctx.nodesByKind.processor).toBe(7)
    expect(Object.keys(audio.peaks()).sort()).toEqual(Object.keys(lv).sort())
    expect(ctx.nodesByKind.processor).toBe(7) // reading again builds nothing new
  })
})

// ── Combat audio ────────────────────────────────────────────────────────────

import { LEVELS } from '../../fps/levels'

describe('indoor and outdoor acoustics follow the listener', () => {
  it('builds two reverbs, and fades between them as the listener walks under the Blacksite roof', () => {
    const a = inner(audio)
    expect((a.ctx as FakeAudioContext).nodesByKind.convolver).toBe(2)
    audio.setLevel(LEVELS.blacksite)
    audio.setListener(LEVELS.blacksite.start[0], LEVELS.blacksite.start[1], 0)     // the gate: outside
    expect(audio.isIndoors()).toBe(false)
    expect(gain(a.openWet).value).toBeGreaterThan(0)
    expect(gain(a.roomWet).value).toBe(0)
    audio.setListener(0, -20, 0)                                                   // inside the building
    expect(audio.isIndoors()).toBe(true)
    expect(gain(a.roomWet).value).toBeGreaterThan(gain(a.openWet).value)
    expect(gain(a.openWet).value).toBe(0)
  })
  it('with no level (training, endless) it is all open ground', () => {
    audio.setLevel(null)
    audio.setListener(0, -20, 0)
    expect(audio.isIndoors()).toBe(false)
  })
})

describe('enemy fire', () => {
  const samples = () => { const a = inner(audio) as unknown as { rifle: unknown[] }; a.rifle = [{}] } // stand-in decoded shot
  it('a round that misses but passes close is heard going by, even from a shooter too far to hear', () => {
    samples()
    audio.setListener(0, 0, 0)
    const a = inner(audio)
    const before = a.gunBus.inputs
    // shooter 60 m away firing along z, passing 1 m to the side of the listener at head height
    audio.enemyShot([1, 1.6, -60], { impact: [1, 1.6, 20], hit: false })
    expect(a.gunBus.inputs).toBeGreaterThan(before)
  })
  it('a round that hits you, or passes wide, makes no whiz', () => {
    samples()
    audio.setListener(0, 0, 0)
    const a = inner(audio)
    const before = a.gunBus.inputs
    audio.enemyShot([1, 1.6, -60], { impact: [1, 1.6, 20], hit: true })
    audio.enemyShot([9, 1.6, -60], { impact: [9, 1.6, 20], hit: false })
    expect(a.gunBus.inputs).toBe(before)
  })
  it('a near shot is immediate and single', () => {
    samples()
    audio.setListener(0, 0, 0)
    const ctx = inner(audio).ctx as FakeAudioContext
    ctx.starts.length = 0
    audio.enemyShot([0, 1.6, -5])
    const near = ctx.starts.filter((s) => s.kind === 'source')
    expect(near).toHaveLength(1)
    expect(near[0].t).toBe(0)
  })
  it('a far shot arrives late and comes back as an echo', () => {
    const far = new FpsAudio()                       // a fresh budget: no cooldown from the shot above
    far.unlock()
    ;(far as unknown as { rifle: unknown[] }).rifle = [{}]
    far.setListener(0, 0, 0)
    const ctx = inner(far).ctx as FakeAudioContext
    ctx.starts.length = 0
    far.enemyShot([0, 1.6, -34])
    const shots = ctx.starts.filter((s) => s.kind === 'source')
    expect(shots).toHaveLength(2)
    expect(shots[0].t).toBeGreaterThan(0.08)         // 34 m is 0.1 s of travel
    expect(shots[1].t).toBeGreaterThan(shots[0].t)   // then it comes back off the ground
    far.dispose()
  })
  it('guards walking within earshot are heard; distant ones are not', () => {
    const a = inner(audio)
    audio.setListener(0, 0, 0)
    const before = a.impactBus.inputs
    audio.enemyStep([6, 0, 0])
    expect(a.impactBus.inputs).toBeGreaterThan(before)
    const after = a.impactBus.inputs
    audio.enemyStep([30, 0, 0])
    expect(a.impactBus.inputs).toBe(after)
  })
})

describe('alarm escalation', () => {
  it('the last level is doubled with a second voice; the first is a single siren', () => {
    const ctx = inner(audio).ctx as FakeAudioContext
    const osc = () => ctx.nodesByKind.osc ?? 0
    const o0 = osc()
    audio.alarm(1, 1)
    const single = osc() - o0
    const o1 = osc()
    audio.alarm(1, 3)
    expect(osc() - o1).toBe(single + 1)
  })
})

describe('extraction cues', () => {
  it('the call, the warning and the success reach the Interface channel, not Combat', () => {
    const a = inner(audio)
    const u = a.uiBus.inputs, g = a.gunBus.inputs
    audio.extractCall()
    expect(a.uiBus.inputs).toBeGreaterThan(u)
    expect(a.gunBus.inputs).toBe(g)
  })
  it('the ride-in engine is Environment, starts once and stops cleanly', () => {
    const a = inner(audio)
    const ctx = a.ctx as FakeAudioContext
    const amb = a.ambBus.inputs
    audio.setExtraction(true)
    const oscs = ctx.nodesByKind.osc
    expect(a.ambBus.inputs).toBeGreaterThan(amb)
    audio.setExtraction(true)                       // a second call does not stack another engine
    expect(ctx.nodesByKind.osc).toBe(oscs)
    audio.setExtraction(false)
    audio.setExtraction(false)                      // and stopping twice is harmless
  })
})

// ── The sounds of a site ────────────────────────────────────────────────────

import { emittersFor, MAX_CONTINUOUS, SPEC } from '../soundscape'

describe('soundscape voices', () => {
  const cinder = LEVELS.cinder_yard
  const pump = emittersFor(cinder).find((e) => e.kind === 'pump')!
  const scape = () => audio.soundscape!

  it('voices the nearest few emitters when you stand among them, never more than the cap', () => {
    audio.setLevel(cinder)
    scape().update(pump.x + 1, pump.z, 0, 1000)
    expect(scape().activeCount()).toBeGreaterThan(0)
    expect(scape().activeCount()).toBeLessThanOrEqual(MAX_CONTINUOUS)
  })
  it('goes silent when you are far from everything, and nothing is held without a level', () => {
    audio.setLevel(cinder)
    scape().update(pump.x, pump.z, 0, 1000)
    expect(scape().activeCount()).toBeGreaterThan(0)
    scape().update(9999, 9999, 0, 2000)
    expect(scape().activeCount()).toBe(0)
    scape().update(pump.x, pump.z, 0, 3000)
    expect(scape().activeCount()).toBeGreaterThan(0)
    audio.setLevel(null)
    expect(scape().activeCount()).toBe(0)
  })
  it('does its work about ten times a second however often it is called', () => {
    audio.setLevel(cinder)
    const ctx = inner(audio).ctx as FakeAudioContext
    scape().update(pump.x, pump.z, 0, 5000)
    const nodes = Object.values(ctx.nodesByKind).reduce((a, b) => a + b, 0)
    for (let i = 0; i < 50; i++) scape().update(pump.x, pump.z, 0, 5000 + i)   // 50 calls inside 50 ms
    expect(Object.values(ctx.nodesByKind).reduce((a, b) => a + b, 0)).toBe(nodes)
  })
  it('fires its periodic sounds when they are due and only if the source is within range', () => {
    audio.setLevel(cinder)
    const ctx = inner(audio).ctx as FakeAudioContext
    const steam = emittersFor(cinder).find((e) => e.kind === 'steam')!
    ctx.currentTime = 500                                          // long past every schedule
    ctx.starts.length = 0
    scape().update(steam.x + 2, steam.z, 0, 8000)                  // beside a steam vent
    expect(ctx.starts.length).toBeGreaterThan(0)
    // a listener far from every source: periodic sounds are due but none is audible
    audio.setLevel(cinder)
    ctx.currentTime = 1000
    ctx.starts.length = 0
    scape().update(9999, 9999, 0, 9000)
    expect(ctx.starts.filter((s) => s.kind === 'source').length).toBe(0)
  })
  it('every continuous kind has a voice builder', () => {
    // one single-emitter level per kind, on a strictly increasing clock (the runner throttles to 10 Hz)
    let clock = 20000
    for (const kind of Object.entries(SPEC).filter(([, s]) => s.continuous).map(([k]) => k)) {
      const box = kind === 'engine' ? { kind: 'truck' } : kind === 'server' ? { kind: 'server' } : kind === 'pump' ? { kind: 'pump' } : kind === 'tank' ? { kind: 'tank' } : null
      const art = kind === 'lamp' ? { kind: 'lamp' } : kind === 'stack' ? { kind: 'stack' } : null
      const lvl = { ...cinder, id: 'cinder_yard', walls: box ? [{ x: 0, z: 0, w: 1, d: 1, h: 3, ...box }] : [], cover: [], art: art ? [{ x: 0, z: 0, ...art }] : [] } as unknown as typeof cinder
      audio.setLevel(lvl)
      clock += 500
      scape().update(1, 0, 0, clock)
      expect(scape().activeCount(), kind).toBe(1)
    }
  })
})

describe('every radio voice has its own signature', () => {
  it('each speaker puts static on the radio channel, and they are not all the same', () => {
    const a = inner(audio)
    const ctx = a.ctx as FakeAudioContext
    const built: Record<string, number> = {}
    for (const who of ['handler', 'vanguard', 'ashen', 'vex', 'halcyon'] as const) {
      const before = ctx.nodesByKind.source ?? 0
      const inputs = a.voiceBus.inputs
      audio.vo('dyn-sig', who)
      expect(a.voiceBus.inputs, who).toBeGreaterThan(inputs)
      built[who] = (ctx.nodesByKind.source ?? 0) - before
    }
    expect(built.halcyon).toBe(2)                                    // two narrow bands
    expect(new Set(Object.values(built)).size).toBeGreaterThan(1)    // not one signature for everyone
  })
})

// ── The score across the game ───────────────────────────────────────────────

describe('adaptive music', () => {
  const music = () => (inner(audio) as unknown as { music: { current: string; targets(): Record<string, number> } | null }).music!
  it('is silent until a screen asks for something, then follows the screen', () => {
    expect(audio.stats().music.state).toBe('silent')
    audio.setMusicState('hub')
    expect(audio.stats().music.state).toBe('hub')
    expect(music().current).toBe('hub')
    audio.setMusicState('table')
    expect(music().current).toBe('table')
  })
  it('the fight drives the states from the guards, and the extraction overrides then hands back', () => {
    audio.setMusicIntensity(0); expect(music().current).toBe('infiltration')
    audio.setMusicIntensity(1); expect(music().current).toBe('detection')
    audio.setMusicIntensity(2); expect(music().current).toBe('combat')
    audio.setExtraction(true);  expect(music().current).toBe('extraction')
    expect(music().targets().riser).toBeGreaterThan(0)
    audio.setMusicIntensity(1); expect(music().current).toBe('extraction')   // the fight cannot take the countdown's score away
    audio.setExtraction(false); expect(music().current).toBe('detection')    // and it returns to what the fight was doing
    expect(music().targets().riser).toBe(0)
  })
  it('one score for the whole app: changing state never builds a second one', () => {
    const ctx = inner(audio).ctx as FakeAudioContext
    audio.setMusicState('hub')
    const drones = ctx.nodesByKind.osc ?? 0
    for (const s of ['prep', 'infiltration', 'combat', 'table', 'hub'] as const) audio.setMusicState(s)
    expect(ctx.nodesByKind.osc ?? 0).toBe(drones)  // layers cross-fade; no oscillator is added or restarted
  })
  it('results sound a resolution once on entry and not again while you stay', () => {
    const ctx = inner(audio).ctx as FakeAudioContext
    audio.setMusicState('combat')
    const before = ctx.nodesByKind.osc ?? 0
    audio.setMusicState('results')
    expect((ctx.nodesByKind.osc ?? 0) - before).toBe(3)   // the open fifth
    audio.setMusicState('results')
    expect((ctx.nodesByKind.osc ?? 0) - before).toBe(3)
  })
  it('a state set before audio is unlocked is waiting for it', () => {
    const early = new FpsAudio()
    early.setMusicState('hub')
    expect(early.stats().music.state).toBe('hub')
    early.unlock()
    expect((early as unknown as { music: { current: string } }).music.current).toBe('hub')
    early.dispose()
  })
  it('a muted music slider builds no score at all', () => {
    const quiet = new FpsAudio()
    quiet.setMix({ master: 0.9, music: 0, effects: 1, voice: 1, ambience: 0.8, ui: 0.8, interactions: 1 })
    quiet.unlock()
    quiet.setMusicState('hub')
    expect(quiet.stats().music.playing).toBe(false)
    quiet.dispose()
  })
})

describe('no room tone off a site', () => {
  it('the Hub has none; a site has its own; leaving takes it away', () => {
    const a = inner(audio)
    expect(gain(a.ambBus).value).toBe(0)
    audio.setZone('CINDER_YARD')
    expect(gain(a.ambBus).value).toBeGreaterThan(0)
    audio.setZone('NONE')
    expect(gain(a.ambBus).value).toBe(0)
  })
})
