import { spatialize } from './spatial';
import type { GunShotAudio } from '../combat/GunFeel';

/**
 * @module audio/FpsAudio
 * @description The tactical audio director for the Valor clone (the plan slice 2).
 *
 * Ready-or-Not sells itself through sound, so this is the first full-quality
 * system. Self-contained WebAudio synthesis — no samples to download, which
 * keeps it instant on mobile — routed through a small bus + limiter graph so
 * the mix has a ducking hierarchy instead of everything hitting the speakers
 * flat:
 *
 *   gun · impacts · ui · ambience  →  master  →  limiter  →  out
 *
 * The camera is the listener: impacts are spatialised (pan = left/right,
 * gain = distance, lowpass = behind-you) via the pure `spatialize()` shared
 * with the rest of the engine, so with your eyes closed you can call out a
 * shot, a body hit, a wall hit, a reload, and which side it came from.
 *
 * Lazily initialised: the AudioContext is created on the first `unlock()`
 * (a user gesture), so there is no autoplay warning and nothing to tear down
 * if the player never interacts.
 */

type Ctx = AudioContext;

// Real recorded gunshots (Pixabay, royalty-free) — the synth read like a punch,
// so the gun is real audio now. Trimmed dry + loudness-matched; one is picked at
// random per shot with a little pitch wobble so rapid fire isn't a copy-paste.
const SAMPLE_BASE = '/sounds/fps/';
const RIFLE_FILES = ['rifle_1.mp3', 'rifle_2.mp3', 'rifle_3.mp3'];
const WALL_FILE = 'impact_wall.mp3';

const clamp = (lo: number, hi: number, v: number) => Math.max(lo, Math.min(hi, v));

/**
 * How a weapon's real-sample shot is SHAPED from its GunShotAudio profile —
 * pure so it's testable without a WebAudio graph. Snappier guns (a higher crack
 * cutoff) pitch up and stay bright; boomy guns pitch down and roll off the top.
 */
export function shotShape(profile: GunShotAudio): { rate: number; toneHz: number; gain: number } {
  return {
    rate: clamp(0.72, 1.3, 0.78 + ((profile.hpFreq - 500) / 1200) * 0.48),
    toneHz: 1400 + profile.hpFreq * 3.4,
    gain: 0.62 + profile.vol * 0.55,
  };
}

/** The ambience config for a zone (falls back to Ashfall). Exported for tests. */
export function zoneAmbience(zone: string): { lp: number; vol: number; drone?: number } {
  return ZONE_AMB[zone] ?? ZONE_AMB.ASHFALL;
}

// Per-zone ambience bed: how dark the room tone is (lowpass), how loud, and an
// optional low drone — the Rift gets an ominous sub hum, Survival a tense one.
const ZONE_AMB: Record<string, { lp: number; vol: number; drone?: number }> = {
  ASHFALL: { lp: 520, vol: 0.05 },
  'PROVING GROUND': { lp: 360, vol: 0.045 },        // colder, quieter, institutional
  'THE RIFT': { lp: 240, vol: 0.06, drone: 44 },     // the dark place hums under you
  SURVIVAL: { lp: 620, vol: 0.055, drone: 70 },      // a taut arena bed
};

export interface FpsAudioStats {
  shots: number;
  impacts: number;
  reloads: number;
  footsteps: number;
  unlocked: boolean;
  samples: number; // real gunshot buffers decoded (0 = still on synth fallback)
  zone: string;    // the ambience bed currently loaded
}

export class FpsAudio {
  private ctx: Ctx | null = null;
  private master!: GainNode;
  private limiter!: DynamicsCompressorNode;
  private gunBus!: GainNode;
  private impactBus!: GainNode;
  private uiBus!: GainNode;
  private ambBus!: GainNode;
  private ambBaseVol = 0.05;
  private ambLp: BiquadFilterNode | null = null; // the ambience tone filter (retuned per zone)
  private drone: OscillatorNode | null = null;   // optional low zone hum (the Rift / Survival)
  private zone = 'ASHFALL';

  // Listener pose (camera), updated each frame.
  private lx = 0;
  private lz = 0;
  private lyaw = 0;

  private stats_: FpsAudioStats = { shots: 0, impacts: 0, reloads: 0, footsteps: 0, unlocked: false, samples: 0, zone: 'ASHFALL' };

  // Real gunshot samples, decoded into this context's graph.
  private rifle: AudioBuffer[] = [];
  private wall: AudioBuffer | null = null;
  private samplesLoaded = false;
  private fetching: Promise<(ArrayBuffer | null)[]> | null = null;

  constructor() {
    // Prefetch the sample bytes at construction (scene mount) so they're ready to
    // decode the instant the context unlocks — the first shot is a real one.
    if (typeof fetch !== 'undefined') {
      this.fetching = Promise.all(
        [...RIFLE_FILES, WALL_FILE].map((f) =>
          fetch(SAMPLE_BASE + f).then((r) => r.arrayBuffer()).catch(() => null)),
      );
    }
  }

  /** Create the graph on the first gesture (keydown / pointer / touch). Idempotent. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;

      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -6;
      this.limiter.ratio.value = 12;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.18;
      this.limiter.connect(ctx.destination);

      this.master = ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.limiter);

      this.gunBus = ctx.createGain();
      this.impactBus = ctx.createGain();
      this.uiBus = ctx.createGain();
      this.ambBus = ctx.createGain();
      this.gunBus.gain.value = 0.9;
      this.impactBus.gain.value = 0.9;
      this.uiBus.gain.value = 0.8;
      this.ambBus.gain.value = this.ambBaseVol;
      for (const b of [this.gunBus, this.impactBus, this.uiBus, this.ambBus]) b.connect(this.master);

      this.startAmbience();
      void this.loadSamples();
      this.stats_.unlocked = true;
    }
    this.ctx?.resume?.().catch(() => {});
  }

  private async loadSamples(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || !this.fetching || this.samplesLoaded) return;
    this.samplesLoaded = true;
    let abs: (ArrayBuffer | null)[];
    try { abs = await this.fetching; } catch { return; }
    for (let i = 0; i < RIFLE_FILES.length; i++) {
      const ab = abs[i];
      if (ab) { try { this.rifle.push(await ctx.decodeAudioData(ab.slice(0))); } catch { /* skip a bad file */ } }
    }
    const wallAb = abs[RIFLE_FILES.length];
    if (wallAb) { try { this.wall = await ctx.decodeAudioData(wallAb.slice(0)); } catch { /* skip */ } }
    this.stats_.samples = this.rifle.length;
  }

  /** True once a user gesture has built the graph (autoplay is allowed). */
  isUnlocked(): boolean {
    return this.stats_.unlocked;
  }

  setListener(x: number, z: number, yaw: number): void {
    this.lx = x;
    this.lz = z;
    this.lyaw = yaw;
  }

  stats(): FpsAudioStats {
    return { ...this.stats_ };
  }

  dispose(): void {
    try { this.ctx?.close(); } catch { /* already closed */ }
    this.ctx = null;
  }

  // ── The player's own gun: the REAL recorded crack, SHAPED per weapon ──
  // Every gun is voiced from the one rifle sample plus its own GunShotAudio
  // profile, so a pistol snaps, an SMG spits fast and thin, the marksman BOOMS,
  // and the legendary punches — all distinct, no extra downloads.
  shot(profile: GunShotAudio): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.rifle.length === 0) { this.synthShot(profile); return; } // ~1 frame until decoded
    const now = ctx.currentTime;
    const buf = this.rifle[(Math.random() * this.rifle.length) | 0];
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const shape = shotShape(profile);
    src.playbackRate.value = shape.rate * (0.98 + Math.random() * 0.04);
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = shape.toneHz; // boomy(500)->3100Hz, smg(1700)->7180Hz
    const g = ctx.createGain();
    g.gain.value = shape.gain;           // louder guns hit harder
    src.connect(tone).connect(g).connect(this.gunBus);
    src.start(now);
    this.bodyPunch(profile, now);                       // per-weapon low-end under the crack
    if (profile.thump) this.sub(112, 34, 0.6, 0.2);     // the big guns get a sub
    this.duck(0.4 + profile.vol * 0.2, 0.12 + profile.bodyDur);
    this.stats_.shots++;
  }

  /** The tonal body punch under a shot — its low-end character, per weapon. */
  private bodyPunch(shot: GunShotAudio, now: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const body = ctx.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(shot.bodyF0, now);
    body.frequency.exponentialRampToValueAtTime(shot.bodyF1, now + shot.bodyDur);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.36 * shot.vol, now);
    bg.gain.exponentialRampToValueAtTime(0.001, now + shot.bodyDur + 0.01);
    body.connect(bg).connect(this.gunBus);
    body.start(now);
    body.stop(now + shot.bodyDur + 0.02);
  }

  /** Synth fallback, used only for the brief window before the samples decode. */
  private synthShot(shot: GunShotAudio): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const crack = ctx.createBufferSource();
    crack.buffer = this.noise(shot.noiseDur);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = shot.hpFreq;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.55 * shot.vol, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + shot.noiseDur + 0.01);
    crack.connect(hp).connect(ng).connect(this.gunBus);
    crack.start(now);
    crack.stop(now + shot.noiseDur + 0.02);

    this.bodyPunch(shot, now);
    if (shot.thump) this.sub(110, 35, 0.7, 0.2);
    this.duck(0.45, 0.12);
    this.stats_.shots++;
  }

  // ── A round landing: spatialised at its world point (flesh vs wall) ──
  impact(kind: 'flesh' | 'wall', at: [number, number, number]): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const sp = spatialize(this.lx, this.lz, this.lyaw, at[0], at[2]);
    if (sp.gain <= 0.001) return;
    const now = ctx.currentTime;

    const pan = ctx.createStereoPanner();
    pan.pan.value = sp.pan;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = sp.lowpass;
    const g = ctx.createGain();
    g.gain.value = sp.gain;
    g.connect(pan).connect(lp).connect(this.impactBus);

    if (kind === 'flesh') {
      // wet, low thud
      const thud = ctx.createOscillator();
      thud.type = 'sine';
      thud.frequency.setValueAtTime(150, now);
      thud.frequency.exponentialRampToValueAtTime(60, now + 0.12);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.5, now);
      tg.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
      thud.connect(tg).connect(g);
      thud.start(now);
      thud.stop(now + 0.16);
      const slap = ctx.createBufferSource();
      slap.buffer = this.noise(0.05);
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.18, now);
      sg.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      slap.connect(sg).connect(g);
      slap.start(now);
      slap.stop(now + 0.06);
    } else if (this.wall) {
      // real bullet-on-metal impact, spatialised through g
      const src = ctx.createBufferSource();
      src.buffer = this.wall;
      src.playbackRate.value = 0.95 + Math.random() * 0.12;
      src.connect(g);
      src.start(now);
    } else {
      // synth fallback until the impact sample decodes
      const tick = ctx.createBufferSource();
      tick.buffer = this.noise(0.04);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2600;
      bp.Q.value = 0.8;
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.4, now);
      tg.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      tick.connect(bp).connect(tg).connect(g);
      tick.start(now);
      tick.stop(now + 0.06);
    }
    this.stats_.impacts++;
  }

  /** Crisp, centred confirmation your shot connected (audio-first kill-confirm). */
  hitmarker(killed: boolean): void {
    this.tick(killed ? 3400 : 2400, 0.12, 0);
    if (killed) this.tick(1600, 0.14, 0.05);
  }

  /** A meaty mechanical knock (mag/bolt) — noise through a low bandpass with body. */
  private clack(freq: number, vol: number, delay: number, dur = 0.08): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise(dur + 0.02);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 2.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(bp).connect(g).connect(this.uiBus);
    src.start(now);
    src.stop(now + dur + 0.02);
  }

  /** Reload BEGIN: mag-release click, then the magazine sliding/dropping out. */
  reloadStart(): void {
    this.tick(2200, 0.10, 0);          // release button
    this.clack(430, 0.15, 0.07, 0.10); // mag unseats
    this.clack(300, 0.11, 0.17, 0.13); // mag drops clear
    this.stats_.reloads++;
  }

  /** Reload COMPLETE: fresh mag slapped in, then the charging handle racked. */
  reloadDone(): void {
    this.clack(520, 0.17, 0, 0.09);    // mag seats hard
    this.clack(1500, 0.12, 0.11, 0.06);// handle drawn back
    this.clack(820, 0.16, 0.19, 0.10); // handle forward — round chambered
  }

  reloadEnd(): void {
    this.tick(1200, 0.15, 0);
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime + 0.03;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 620;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    osc.connect(g).connect(this.uiBus);
    osc.start(now);
    osc.stop(now + 0.1);
  }

  /** Dry hammer click on an empty magazine. */
  empty(): void {
    this.tick(1500, 0.09, 0);
  }

  /**
   * A presence line (slice 6). Plays the per-speaker radio signature, ducks the
   * room (a voice owns it), then prefers the recorded /vo/{id}.mp3 — the lines
   * without a recording land on the signature + subtitle alone, exactly as the
   * story system was designed to degrade.
   */
  vo(id: string, speaker: 'ember' | 'valor' | 'cinder'): void {
    // The static + duck need the WebAudio graph, but the recording does not —
    // never let a missing context swallow a line.
    if (this.ctx) {
      this.radioSignature(speaker);
      this.duck(0.8, 1.8);
    }
    const known = this.voAvailable.get(id);
    if (known === false) return;
    if (known === true) { this.playVoFile(id); return; }
    // HEAD first: a 404 here is quiet, an <audio> 404 spams the console.
    fetch(`/vo/${id}.mp3`, { method: 'HEAD' })
      .then((r) => { this.voAvailable.set(id, r.ok); if (r.ok) this.playVoFile(id); })
      .catch(() => this.voAvailable.set(id, false));
  }

  private voAvailable = new Map<string, boolean>();
  private voDurations = new Map<string, number>();

  /** Real length of a recorded line, once its metadata has loaded. */
  voDuration(id: string): number | undefined {
    return this.voDurations.get(id);
  }

  private playVoFile(id: string): void {
    try {
      const el = new Audio(`/vo/${id}.mp3`);
      el.volume = 0.95;
      // Valor speaks slowly: hold the subtitle for the RECORDING, not a guess.
      el.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(el.duration) && el.duration > 0) this.voDurations.set(id, el.duration);
      });
      void el.play().catch(() => {});
    } catch { /* autoplay blocked */ }
  }

  /** Per-speaker static: you know WHO is talking before you read a word. */
  private radioSignature(speaker: 'ember' | 'valor' | 'cinder'): void {
    if (speaker === 'ember') {        // close, warm, a friend's channel
      this.noiseBand(1900, 0.1, 0.14);
      this.noiseBand(1400, 0.07, 0.09);
    } else if (speaker === 'valor') { // low — the channel drops to make room for him
      this.noiseBand(520, 0.16, 0.16);
    } else {
      this.noiseBand(1150, 0.11, 0.12);
    }
  }

  private noiseBand(freq: number, dur: number, vol: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise(dur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 2.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(bp).connect(g).connect(this.uiBus);
    src.start(now);
    src.stop(now + dur + 0.02);
  }

  /** Rising triad — the rank-up / reward sting (slice 5 earn loop). */
  reward(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    [660, 880, 1320].forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const g = ctx.createGain();
      const t = now + i * 0.09;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.connect(g).connect(this.uiBus);
      osc.start(t);
      osc.stop(t + 0.4);
    });
  }

  /** Own footstep — quiet, centred, low. Scene calls this on a cadence when moving. */
  footstep(vol = 0.09): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise(0.05);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 220 + Math.random() * 90;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    src.connect(lp).connect(g).connect(this.impactBus);
    src.start(now);
    src.stop(now + 0.08);
    this.stats_.footsteps++;
  }

  /** An ENEMY's shot — the same real rifle crack, but spatialised from their
   *  position so you can hear where the fire is coming from (slice 3). */
  enemyShot(at: [number, number, number]): void {
    const ctx = this.ctx;
    if (!ctx || this.rifle.length === 0) return;
    const sp = spatialize(this.lx, this.lz, this.lyaw, at[0], at[2]);
    if (sp.gain <= 0.001) return;
    const src = ctx.createBufferSource();
    src.buffer = this.rifle[(Math.random() * this.rifle.length) | 0];
    src.playbackRate.value = 0.9 + Math.random() * 0.14;
    const pan = ctx.createStereoPanner();
    pan.pan.value = sp.pan;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = sp.lowpass;
    const g = ctx.createGain();
    g.gain.value = sp.gain * 0.75; // sit a touch behind your own gun
    src.connect(g);
    g.connect(pan);
    pan.connect(lp);
    lp.connect(this.impactBus);
    src.start();
  }

  /** You got hit — a low body thud + a sharp sting, centred. */
  hurt(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(70, now + 0.16);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    osc.connect(g).connect(this.uiBus);
    osc.start(now);
    osc.stop(now + 0.22);
    const n = ctx.createBufferSource();
    n.buffer = this.noise(0.08);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1200;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.3, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    n.connect(hp).connect(ng).connect(this.uiBus);
    n.start(now);
    n.stop(now + 0.09);
  }

  /** Low-HP heartbeat (lub-dub). The scene calls this on a cadence when hurt. */
  heartbeat(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const beat = (t: number, vol: number) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(62, now + t);
      o.frequency.exponentialRampToValueAtTime(38, now + t + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now + t);
      g.gain.exponentialRampToValueAtTime(vol, now + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, now + t + 0.16);
      o.connect(g).connect(this.uiBus);
      o.start(now + t);
      o.stop(now + t + 0.2);
    };
    beat(0, 0.5);
    beat(0.24, 0.35);
  }

  /**
   * Load a zone's ambience bed (Ashfall / Proving Ground / the Rift / Survival).
   * Retunes the room tone + level and starts/stops the low zone drone. Safe to
   * call before unlock — the config is applied when the graph is built.
   */
  setZone(zone: string): void {
    this.zone = zone;
    this.stats_.zone = zone;
    const cfg = ZONE_AMB[zone] ?? ZONE_AMB.ASHFALL;
    this.ambBaseVol = cfg.vol;
    const ctx = this.ctx;
    if (!ctx) return; // applied by startAmbience() on the next unlock()
    if (this.ambLp) this.ambLp.frequency.setTargetAtTime(cfg.lp, ctx.currentTime, 0.4);
    this.ambBus.gain.cancelScheduledValues(ctx.currentTime);
    this.ambBus.gain.setTargetAtTime(cfg.vol, ctx.currentTime, 0.6);
    this.setDrone(cfg.drone);
  }

  /** Start / retune / stop the low zone drone (an ominous sub under the dark). */
  private setDrone(freq?: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!freq) {
      if (this.drone) { try { this.drone.stop(); } catch { /* already stopped */ } this.drone = null; }
      return;
    }
    if (!this.drone) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const g = ctx.createGain();
      g.gain.value = 0;
      g.gain.setTargetAtTime(0.5, ctx.currentTime, 0.8); // relative to the already-quiet ambience bus
      osc.connect(g).connect(this.ambBus);
      osc.start();
      this.drone = osc;
    }
    this.drone.frequency.setTargetAtTime(freq, ctx.currentTime, 0.5);
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private startAmbience(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const cfg = ZONE_AMB[this.zone] ?? ZONE_AMB.ASHFALL;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      // brown-ish noise = warm room tone rather than hiss
      last = (last + (Math.random() * 2 - 1) * 0.06) * 0.97;
      data[i] = last;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cfg.lp;
    src.connect(lp).connect(this.ambBus);
    src.start();
    this.ambLp = lp;
    this.setDrone(cfg.drone);
  }

  /** Duck the ambience under a loud event, then let it swell back. */
  private duck(amount: number, seconds: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const g = this.ambBus.gain;
    const now = ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(0, this.ambBaseVol * (1 - amount)), now);
    g.linearRampToValueAtTime(this.ambBaseVol, now + seconds + 0.25);
  }

  private tick(freq: number, vol: number, delay: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise(0.03);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
    src.connect(bp).connect(g).connect(this.uiBus);
    src.start(now);
    src.stop(now + 0.05);
  }

  private sub(f0: number, f1: number, vol: number, dur: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(f1, now + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur + 0.02);
    osc.connect(g).connect(this.gunBus);
    osc.start(now);
    osc.stop(now + dur + 0.03);
  }

  private noise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    return buf;
  }
}
