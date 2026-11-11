// Turns the soundscape model (soundscape.ts) into WebAudio: the nearest few continuous
// emitters are held as voices that follow the listener, and the periodic ones fire one-shots
// on their own schedule. Everything goes to the Environment bus.

import type { LevelDef } from '../fps/levels'
import { propagationDelay } from './combat'
import { emittersFor, mixFor, nearestContinuous, nextDelay, SPEC, type Emitter, type EmitterKind } from './soundscape'

type Dest = AudioNode
interface Voice { stop: () => void; gain: GainNode; pan: StereoPannerNode; lp: BiquadFilterNode; dying?: boolean }
type Mix = { gain: number; pan: number; lowpass: number }
type Build = (ctx: AudioContext, dest: Dest, noise: (s: number) => AudioBuffer) => () => void

const osc = (ctx: AudioContext, type: OscillatorType, hz: number, level: number, dest: Dest) => {
  const o = ctx.createOscillator(); o.type = type; o.frequency.value = hz
  const g = ctx.createGain(); g.gain.value = level
  o.connect(g).connect(dest); o.start()
  return o
}
const lfo = (ctx: AudioContext, hz: number, depth: number, target: AudioParam) => {
  const o = ctx.createOscillator(); o.frequency.value = hz
  const g = ctx.createGain(); g.gain.value = depth
  o.connect(g).connect(target); o.start()
  return o
}
const noiseLoop = (ctx: AudioContext, noise: (s: number) => AudioBuffer, dest: Dest) => {
  const s = ctx.createBufferSource(); s.buffer = noise(2); s.loop = true; s.connect(dest); s.start()
  return s
}

/** Continuous voices. Each returns its own stopper. Levels are low: these are beds. */
const CONTINUOUS: Partial<Record<EmitterKind, Build>> = {
  // a truck idling: two low saws and a slow shudder
  engine: (ctx, dest) => {
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 150; lp.connect(dest)
    const sum = ctx.createGain(); sum.gain.value = 1; sum.connect(lp)
    const a = osc(ctx, 'sawtooth', 46, 0.2, sum), b = osc(ctx, 'sawtooth', 69, 0.14, sum)
    const l = lfo(ctx, 11, 0.07, sum.gain)
    return () => [a, b, l].forEach((o) => { try { o.stop() } catch { /* stopped */ } })
  },
  // electronics: a buzzing mains hum and its octave
  server: (ctx, dest) => {
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 240; bp.Q.value = 3; bp.connect(dest)
    const a = osc(ctx, 'square', 120, 0.07, bp), b = osc(ctx, 'square', 240, 0.04, bp)
    return () => [a, b].forEach((o) => { try { o.stop() } catch { /* stopped */ } })
  },
  // a lamp's ballast: a thin hum with a slow flicker
  lamp: (ctx, dest) => {
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 100; bp.Q.value = 8; bp.connect(dest)
    const sum = ctx.createGain(); sum.gain.value = 1; sum.connect(bp)
    const a = osc(ctx, 'sawtooth', 100, 0.18, sum)
    const l = lfo(ctx, 7.3, 0.25, sum.gain)
    return () => [a, l].forEach((o) => { try { o.stop() } catch { /* stopped */ } })
  },
  // a flare stack: a low roar that breathes
  stack: (ctx, dest, noise) => {
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 280; lp.connect(dest)
    const g = ctx.createGain(); g.gain.value = 0.5; g.connect(lp)
    const n = noiseLoop(ctx, noise, g)
    const l = lfo(ctx, 0.18, 0.25, g.gain)
    return () => { try { n.stop() } catch { /* stopped */ } try { l.stop() } catch { /* stopped */ } }
  },
  // a pump: two detuned saws, the beat is the stroke
  pump: (ctx, dest) => {
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 190; lp.connect(dest)
    const a = osc(ctx, 'sawtooth', 49, 0.12, lp), b = osc(ctx, 'sawtooth', 51.5, 0.12, lp), c = osc(ctx, 'sine', 98, 0.07, lp)
    return () => [a, b, c].forEach((o) => { try { o.stop() } catch { /* stopped */ } })
  },
  // a full tank: a deep resonance
  tank: (ctx, dest) => {
    const a = osc(ctx, 'sine', 38, 0.14, dest), b = osc(ctx, 'sine', 57, 0.06, dest)
    return () => [a, b].forEach((o) => { try { o.stop() } catch { /* stopped */ } })
  },
}

/** One-shots for the periodic kinds, already placed (gain, pan, lowpass). */
function oneShot(ctx: AudioContext, kind: EmitterKind, mix: Mix, dest: Dest, noise: (s: number) => AudioBuffer, delay = 0): void {
  const t = ctx.currentTime + delay
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = mix.lowpass
  const pan = ctx.createStereoPanner(); pan.pan.value = mix.pan
  const out = ctx.createGain(); out.gain.value = mix.gain
  lp.connect(pan).connect(out).connect(dest)
  const env = (g: GainNode, peak: number, attack: number, hold: number) => {
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + attack); g.gain.exponentialRampToValueAtTime(0.001, t + attack + hold)
  }
  const stopAt = (n: AudioScheduledSourceNode, secs: number) => { n.start(t); n.stop(t + secs) }
  if (kind === 'steam' || kind === 'clank') {
    const src = ctx.createBufferSource(); src.buffer = noise(kind === 'steam' ? 1.4 : 0.2)
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = kind === 'steam' ? 0.7 : 4; bp.frequency.value = kind === 'steam' ? 3000 + Math.random() * 1500 : 1100
    const g = ctx.createGain(); env(g, kind === 'steam' ? 0.6 : 1.2, kind === 'steam' ? 0.15 : 0.005, kind === 'steam' ? 1.2 : 0.18)
    src.connect(bp).connect(g).connect(lp); stopAt(src, kind === 'steam' ? 1.4 : 0.2)
    if (kind === 'clank') { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(620, t); o.frequency.exponentialRampToValueAtTime(400, t + 0.4); const og = ctx.createGain(); env(og, 0.3, 0.004, 0.4); o.connect(og).connect(lp); stopAt(o, 0.45) }
  } else if (kind === 'camera') {
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(1500, t); o.frequency.linearRampToValueAtTime(2100, t + 0.12)
    const g = ctx.createGain(); env(g, 0.5, 0.01, 0.12); o.connect(g).connect(lp); stopAt(o, 0.16)
  } else if (kind === 'radar') {
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 2300
    const g = ctx.createGain(); env(g, 0.5, 0.003, 0.06); o.connect(g).connect(lp); stopAt(o, 0.08)
  } else if (kind === 'chime') {
    for (const [f, at] of [[880, 0], [660, 0.55]] as const) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t + at); g.gain.exponentialRampToValueAtTime(0.5, t + at + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + at + 0.9)
      o.connect(g).connect(lp); o.start(t + at); o.stop(t + at + 0.95)
    }
  } else if (kind === 'boom') {
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(62, t); o.frequency.exponentialRampToValueAtTime(30, t + 1.6)
    const g = ctx.createGain(); env(g, 0.9, 0.04, 1.6); o.connect(g).connect(lp); stopAt(o, 1.7)
    const n = ctx.createBufferSource(); n.buffer = noise(2)
    const nl = ctx.createBiquadFilter(); nl.type = 'lowpass'; nl.frequency.value = 180
    const ng = ctx.createGain(); env(ng, 0.5, 0.03, 1.8); n.connect(nl).connect(ng).connect(lp); stopAt(n, 2)
  }
}

export class SoundscapeRunner {
  private level: LevelDef | null = null
  private emitters: Emitter[] = []
  private voices = new Map<string, Voice>()
  private nextAt = new Map<EmitterKind, number>()
  private last = 0

  constructor(
    private ctx: AudioContext,
    private out: Dest,
    private noise: (s: number) => AudioBuffer,
    /** Asks the voice budget before a one-shot. */
    private allow: (key: string, priority: number, ms: number) => boolean,
  ) {}

  /** The emitters of the level being played (probes). */
  get list(): readonly Emitter[] { return this.emitters }
  /** What an emitter does at a listener position (probes): loudness, pan, brightness and walls between. */
  mixAt(id: string, lx: number, lz: number, yaw = 0): { gain: number; pan: number; lowpass: number; blocked: number } | null {
    const e = this.emitters.find((x) => x.id === id)
    return e && this.level ? mixFor(this.level, e, lx, lz, yaw) : null
  }

  /** Keep only one emitter (probes: to measure a single source without the others). */
  isolate(id: string): void {
    for (const vid of [...this.voices.keys()]) if (vid !== id) this.release(vid, 0.05)
    this.emitters = this.emitters.filter((e) => e.id === id)
  }

  /** Continuous voices held right now. */
  activeCount(): number { return [...this.voices.values()].filter((v) => !v.dying).length }

  setLevel(level: LevelDef | null): void {
    for (const id of [...this.voices.keys()]) this.release(id, 0.05)
    this.level = level
    this.emitters = level ? emittersFor(level) : []
    this.nextAt.clear()
    for (const k of new Set(this.emitters.filter((e) => !SPEC[e.kind].continuous).map((e) => e.kind))) this.nextAt.set(k, this.ctx.currentTime + nextDelay(k, Math.random()))
  }

  private release(id: string, secs = 0.6): void {
    const v = this.voices.get(id)
    if (!v || v.dying) return
    v.dying = true
    v.gain.gain.setTargetAtTime(0, this.ctx.currentTime, secs / 3)
    setTimeout(() => { v.stop(); this.voices.delete(id) }, secs * 1000 + 100)
  }

  /** Follow the listener. Cheap to call every frame: it does its work about ten times a second. */
  update(lx: number, lz: number, yaw: number, nowMs: number): void {
    const level = this.level
    if (!level || nowMs - this.last < 100) return
    this.last = nowMs
    const ctx = this.ctx, t = ctx.currentTime
    // continuous: the nearest few
    const want = nearestContinuous(this.emitters, lx, lz)
    const wantIds = new Set(want.map((e) => e.id))
    for (const id of [...this.voices.keys()]) if (!wantIds.has(id)) this.release(id)
    for (const e of want) {
      const mix = mixFor(level, e, lx, lz, yaw)
      let v = this.voices.get(e.id)
      if (!v || v.dying) {
        const build = CONTINUOUS[e.kind]
        if (!build) continue
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = mix.lowpass
        const pan = ctx.createStereoPanner(); pan.pan.value = mix.pan
        const gain = ctx.createGain(); gain.gain.value = 0
        lp.connect(pan).connect(gain).connect(this.out)
        const stop = build(ctx, lp, this.noise)
        v = { stop, gain, pan, lp }
        this.voices.set(e.id, v)
      }
      v.gain.gain.setTargetAtTime(mix.gain, t, 0.15)
      v.pan.pan.setTargetAtTime(mix.pan, t, 0.1)
      v.lp.frequency.setTargetAtTime(mix.lowpass, t, 0.1)
    }
    // periodic: when due, one from the nearest emitter of that kind that is in range
    for (const [kind, due] of this.nextAt) {
      if (t < due) continue
      this.nextAt.set(kind, t + nextDelay(kind, Math.random()))
      const spec = SPEC[kind]
      const inRange = this.emitters.filter((e) => e.kind === kind).map((e) => ({ e, d: Math.hypot(e.x - lx, e.z - lz) })).filter((x) => x.d <= spec.range).sort((a, b) => a.d - b.d)
      const pick = inRange[0]
      if (!pick || !this.allow(`amb-${kind}`, 20, 2000)) continue
      const m = mixFor(level, pick.e, lx, lz, yaw)
      if (m.gain <= 0.001) continue
      // sound is slow: a far boom arrives after its flash, and is placed by direction alone
      oneShot(ctx, kind, m, this.out, this.noise, kind === 'boom' ? propagationDelay(pick.d, 1.2) : 0)
    }
  }

  dispose(): void {
    for (const v of this.voices.values()) v.stop()
    this.voices.clear()
    this.emitters = []
    this.level = null
  }
}
