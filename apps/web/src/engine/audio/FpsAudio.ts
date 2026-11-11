import type { Speaker } from '../story/presence';
import { spatialize } from './spatial';
import type { GunShotAudio } from '../combat/GunFeel';
import { MusicLayers } from './MusicLayers';
import { VoiceBudget, type Channel } from './voices';
import { alarmPattern, closestApproach, distanceClass, nearMissStrength, propagationDelay, type AlarmLevel, type Vec3 } from './combat';
import { impulseResponse, INDOOR_IR, isIndoors, OUTDOOR_IR, spaceMix } from './acoustics';
import type { LevelDef } from '../fps/levels';
import { SoundscapeRunner } from './soundscapeRunner';
import type { LevelId } from '../fps/levels';

/**
 * @module audio/FpsAudio
 * @description The tactical audio director for CONTRACT ZERO.
 *
 * Ready-or-Not sells itself through sound, so this is the first full-quality
 * system. Self-contained WebAudio synthesis — the only downloads are four tiny
 * generated mp3s (three rifle shots, one wall impact), so it stays instant on
 * mobile — routed through a small bus + limiter graph so
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

// Gunshot and wall-impact samples: original, synthesised offline by
// scripts/generate-sfx.mjs (see CREDITS.md), not recordings. The runtime synth read
// like a punch, so the gun plays these buffers. One is picked at random per shot
// with a little pitch wobble so rapid fire isn't a copy-paste.
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
  return ZONE_AMB[zone] ?? ZONE_AMB.DUSTLINE;
}

/**
 * Which ambience bed a mission plays. A contract is bound to a site, so the site's
 * level decides it; `zone` on a contract is only a time-of-day theme (day, dusk and
 * night map to DUSTLINE, REDYARD and BLACKSITE) and must not pick the room tone.
 * Authored missions (campaign, survival) carry no level and keep their own zone.
 */
export function ambienceKey(zone: string, level?: LevelId): string {
  if (level === 'blacksite') return 'BLACKSITE';
  if (level === 'cinder_yard') return 'CINDER_YARD';
  if (level === 'dustline_depot') return 'DUSTLINE';
  return zone;
}

// Per-zone ambience bed: how dark the room tone is (lowpass), how loud, and an
// optional low drone — the Rift gets an ominous sub hum, Survival a tense one.
const ZONE_AMB: Record<string, { lp: number; vol: number; drone?: number }> = {
  DUSTLINE: { lp: 520, vol: 0.05 },
  'REDYARD': { lp: 360, vol: 0.045 },        // colder, quieter, institutional
  'BLACKSITE': { lp: 240, vol: 0.06, drone: 44 },     // the dark place hums under you
  CINDER_YARD: { lp: 300, vol: 0.055, drone: 55 },   // a refinery's low rumble; the machinery bed sits on top
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

/** The player's volume mix, 0…1 per channel. `effects` is the Combat channel (its saved key predates
 *  the split); `ambience` is Environment; `voice` is Radio and dialogue; `interactions` covers reloads,
 *  pickups and footsteps. */
export interface Mix { master: number; music: number; effects: number; voice: number; ambience: number; ui: number; interactions: number }

export class FpsAudio {
  private ctx: Ctx | null = null;
  private master!: GainNode;
  private limiter!: DynamicsCompressorNode;
  private gunBus!: GainNode;
  private impactBus!: GainNode;
  private uiBus!: GainNode;
  /** Reloads, pickups, footsteps. */
  private interactBus!: GainNode;
  /** Ducking stages: a bus's level is its mix gain; a duck is a temporary dip on top, so the two never fight. */
  private combatDuck!: GainNode;
  private ambDuck!: GainNode;
  private musicDuck!: GainNode;
  private interactDuck!: GainNode;
  /** The level's roofs, for telling indoors from outdoors; and two reverbs (a dense room, open ground). */
  private roofs: LevelDef['art'] | null = null;
  private level: LevelDef | null = null;
  /** Positional sounds of the site (soundscape.ts): engines, hums, steam, a PA. */
  soundscape: SoundscapeRunner | null = null;
  private indoors = false;
  private reverbIn!: GainNode;
  private roomWet!: GainNode;
  private openWet!: GainNode;
  private extractHum: { oscs: OscillatorNode[]; gain: GainNode } | null = null;
  /** How many sounds may play at once, and which give way first (voices.ts). */
  private budget = new VoiceBudget({
    max: 28,
    perChannel: { interactions: 6, ui: 6 },
    cooldownMs: { impact: 28, 'enemy-shot': 45, footstep: 140, explosion: 250, hitmarker: 40, clack: 35, heartbeat: 400, whiz: 120, ricochet: 150, 'enemy-step': 90, extract: 300 },
  });
  private ambBus!: GainNode;
  /** The Environment channel's own gain, for the positional sounds of the site. `ambBus` is the room-tone level (a
   *  few hundredths), which would swallow them. */
  private envBus!: GainNode;
  private ambBaseVol = 0.05;
  /** The player's mix (Settings → Audio) and whether the tab is in the background. */
  private mix: Mix = { master: 0.9, music: 0.5, effects: 1, voice: 1, ambience: 0.8, ui: 0.8, interactions: 1 };
  /** The adaptive score (MusicLayers) on its own bus, under the music slider. */
  private musicBus!: GainNode;
  private music: MusicLayers | null = null;
  private musicLevel: 0 | 1 | 2 | 3 = 0;
  private backgroundMuted = false;
  private voiceBus!: GainNode;
  /** The ambience level after the player's ambience slider. */
  private get ambTarget(): number { return this.ambBaseVol * this.mix.ambience; }
  private ambLp: BiquadFilterNode | null = null; // the ambience tone filter (retuned per zone)
  private drone: OscillatorNode | null = null;   // optional low zone hum (the Rift / Survival)
  /** A refinery's machinery: a pump hum and steam vents letting go now and then. */
  private machineryOn = false;
  private machinery: { oscs: OscillatorNode[]; gain: GainNode; hiss: number } | null = null;
  private zone = 'DUSTLINE';

  // Listener pose (camera), updated each frame.
  private lx = 0;
  private lz = 0;
  private lyaw = 0;

  private stats_: FpsAudioStats = { shots: 0, impacts: 0, reloads: 0, footsteps: 0, unlocked: false, samples: 0, zone: 'DUSTLINE' };

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
      this.ambBus.gain.value = this.ambTarget;
      this.voiceBus = ctx.createGain();
      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = 0;
      this.interactBus = ctx.createGain();
      this.combatDuck = ctx.createGain();
      this.ambDuck = ctx.createGain();
      this.musicDuck = ctx.createGain();
      this.interactDuck = ctx.createGain();
      // bus -> (duck stage) -> master. UI and radio are never ducked.
      this.gunBus.connect(this.combatDuck);
      this.impactBus.connect(this.combatDuck);
      this.combatDuck.connect(this.master);
      this.envBus = ctx.createGain();
      this.envBus.gain.value = this.mix.ambience;
      this.ambBus.connect(this.ambDuck); this.envBus.connect(this.ambDuck); this.ambDuck.connect(this.master);
      this.musicBus.connect(this.musicDuck); this.musicDuck.connect(this.master);
      this.interactBus.connect(this.interactDuck); this.interactDuck.connect(this.master);
      this.uiBus.connect(this.master);
      this.voiceBus.connect(this.master);
      // Reverb: combat sound (after ducking) is sent to a dense room and to open ground; which one is
      // heard depends on whether the listener is under a roof (setListener -> applySpace).
      this.reverbIn = ctx.createGain();
      this.roomWet = ctx.createGain();
      this.openWet = ctx.createGain();
      this.roomWet.gain.value = 0;
      this.openWet.gain.value = 0;
      this.combatDuck.connect(this.reverbIn);
      for (const [spec, wet] of [[INDOOR_IR, this.roomWet], [OUTDOOR_IR, this.openWet]] as const) {
        const conv = ctx.createConvolver();
        const ir = ctx.createBuffer(2, Math.floor(ctx.sampleRate * spec.seconds), ctx.sampleRate);
        for (let c = 0; c < 2; c++) ir.getChannelData(c).set(impulseResponse(ctx.sampleRate, spec, c));
        conv.buffer = ir;
        this.reverbIn.connect(conv);
        conv.connect(wet);
        wet.connect(this.master);
      }
      this.applySpace();
      // the sounds of the site, on the Environment channel
      this.soundscape = new SoundscapeRunner(ctx, this.envBus, (s) => this.noise(s), (key, pri, ms) => this.allow(key, 'environment', pri, ms));
      this.soundscape.setLevel(this.level);
      this.applyMix();
      // The score only runs while it can be heard: a muted music slider costs nothing.
      this.syncMusic();

      this.startAmbience();
      void this.loadSamples();
      this.stats_.unlocked = true;
    }
    if (!this.isHeld()) this.ctx?.resume?.().catch(() => {});
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
  /** Ask the voice budget before building a sound. False means skip it. */
  private allow(key: string, channel: Channel, priority: number, durationMs: number): boolean {
    return this.budget.request({ key, channel, priority, durationMs }, typeof performance !== 'undefined' ? performance.now() : Date.now()).ok;
  }

  isUnlocked(): boolean {
    return this.stats_.unlocked;
  }

  setListener(x: number, z: number, yaw: number): void {
    this.lx = x;
    this.lz = z;
    this.lyaw = yaw;
    // under a roof or not; a small margin so the doorway is already the room
    const inside = isIndoors(this.roofs, x, z, 0.8);
    if (inside !== this.indoors) {
      this.indoors = inside;
      this.applySpace();
    }
    this.soundscape?.update(x, z, yaw, typeof performance !== 'undefined' ? performance.now() : Date.now());
  }

  /** The level being played: indoor and outdoor acoustics, and the sounds of the site. Null (training, endless) is all outdoors and silent of emitters. */
  setLevel(level: LevelDef | null): void {
    this.level = level;
    this.roofs = level ? level.art : null;
    const inside = isIndoors(this.roofs, this.lx, this.lz, 0.8);
    if (inside !== this.indoors) this.indoors = inside;
    this.applySpace();
    this.soundscape?.setLevel(level);
  }

  /** Fade the reverb to the space the listener is in. */
  private applySpace(): void {
    const ctx = this.ctx;
    if (!ctx || !this.roomWet) return;
    const m = spaceMix(this.indoors);
    this.roomWet.gain.setTargetAtTime(m.indoorWet, ctx.currentTime, 0.12);
    this.openWet.gain.setTargetAtTime(m.outdoorWet, ctx.currentTime, 0.12);
  }

  /** The level being played (probes). */
  get currentLevel(): LevelDef | null { return this.level; }

  /** Whether the listener is under a roof (probes). */
  isIndoors(): boolean {
    return this.indoors;
  }

  stats(): FpsAudioStats & { mix: Mix; backgroundMuted: boolean; masterGain: number | null; music: { playing: boolean; level: number; gain: number | null }; voices: { granted: number; refused: Record<string, number> } } {
    return {
      voices: { granted: this.budget.granted, refused: { ...this.budget.refused } },
      ...this.stats_, mix: { ...this.mix }, backgroundMuted: this.backgroundMuted, masterGain: this.master ? this.master.gain.value : null,
      music: { playing: !!this.music, level: this.musicLevel, gain: this.musicBus ? this.musicBus.gain.value : null },
    };
  }

  /** Combat intensity for the score: 0 calm, 1 alert, 2 engaged, 3 boss. */
  setMusicIntensity(level: 0 | 1 | 2 | 3): void {
    this.musicLevel = level;
    this.music?.setIntensity(level);
  }

  /** A beat of silence in the score, for a kill or a catch to land in. */
  musicGap(ms: number): void {
    this.music?.gap(ms);
  }

  private syncMusic(): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return;
    if (this.mix.music > 0 && !this.music) {
      this.music = new MusicLayers(ctx, this.musicBus);
      this.music.start();
      this.music.setIntensity(this.musicLevel);
    } else if (this.mix.music <= 0 && this.music) {
      this.music.dispose();
      this.music = null;
    }
  }

  dispose(): void {
    this.setExtraction(false);
    this.soundscape?.dispose();
    this.soundscape = null;
    this.music?.dispose();
    this.music = null;
    try { this.ctx?.close(); } catch { /* already closed */ }
    this.ctx = null;
  }

  // ── The player's own gun: the REAL recorded crack, SHAPED per weapon ──
  // Every gun is voiced from the one rifle sample plus its own GunShotAudio
  // profile, so a pistol snaps, an SMG spits fast and thin, the marksman BOOMS,
  // and the legendary punches — all distinct, no extra downloads.
  shot(profile: GunShotAudio): void {
    if (!this.allow('shot', 'combat', 100, 300)) return;
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
    if (!this.allow('impact', 'combat', 40, 400)) return;
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
      if (Math.random() < 0.28 && this.allow('ricochet', 'combat', 35, 350)) this.ricochet(g, now);
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

  /** A round glancing off hard cover: a thin whine that falls away, through the impact's own spatial chain. */
  private ricochet(dest: AudioNode, now: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(2600 + Math.random() * 600, now + 0.01);
    o.frequency.exponentialRampToValueAtTime(900, now + 0.3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.07, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    o.connect(g).connect(dest);
    o.start(now);
    o.stop(now + 0.32);
  }

  /** Crisp, centred confirmation your shot connected (audio-first kill-confirm). */
  hitmarker(killed: boolean): void {
    if (!this.allow('hitmarker', 'ui', 70, 120)) return;
    this.tick(killed ? 3400 : 2400, 0.12, 0);
    if (killed) this.tick(1600, 0.14, 0.05);
  }

  /** A meaty mechanical knock (mag/bolt) — noise through a low bandpass with body. */
  private clack(freq: number, vol: number, delay: number, dur = 0.08): void {
    const ctx = this.ctx;
    if (!ctx || !this.allow('clack', 'interactions', 30, 200)) return;
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
    src.connect(bp).connect(g).connect(this.interactBus);
    src.start(now);
    src.stop(now + dur + 0.02);
  }

  /** Reload BEGIN: mag-release click, then the magazine sliding/dropping out. */
  reloadStart(): void {
    this.tick(2200, 0.10, 0, this.interactBus);         // release button
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
    this.tick(1200, 0.15, 0, this.interactBus);
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime + 0.03;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 620;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    osc.connect(g).connect(this.interactBus);
    osc.start(now);
    osc.stop(now + 0.1);
  }

  /** Picking something up: a soft canvas-and-latch sound. */
  pickup(): void {
    this.clack(700, 0.12, 0, 0.07);
    this.clack(1100, 0.09, 0.06, 0.05);
  }

  /** Extraction countdown pip; `hi` on the last seconds. */
  beep(hi = false): void {
    if (!this.allow('beep', 'ui', 50, 120)) return;
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = hi ? 1320 : 880;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.05, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    osc.connect(g).connect(this.uiBus);
    osc.start(now);
    osc.stop(now + 0.1);
  }

  /** A demolition charge: a low boom with a long noisy tail, spatialised. */
  explosion(at: [number, number, number]): void {
    if (!this.allow('explosion', 'combat', 80, 2500)) return;
    const ctx = this.ctx;
    if (!ctx) return;
    const sp = spatialize(this.lx, this.lz, this.lyaw, at[0], at[2]);
    const now = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.value = Math.max(0.35, sp.gain) * 1.4;
    const pan = ctx.createStereoPanner();
    pan.pan.value = sp.pan;
    g.connect(pan).connect(this.impactBus);
    const boom = ctx.createOscillator();
    boom.type = 'sine';
    boom.frequency.setValueAtTime(90, now);
    boom.frequency.exponentialRampToValueAtTime(28, now + 0.9);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(1, now);
    bg.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
    boom.connect(bg).connect(g);
    boom.start(now);
    boom.stop(now + 1.25);
    const n = ctx.createBufferSource();
    n.buffer = this.noise(2.2);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, now);
    lp.frequency.exponentialRampToValueAtTime(180, now + 2);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.9, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + 2.2);
    n.connect(lp).connect(ng).connect(g);
    n.start(now);
    n.stop(now + 2.2);
    this.duck(0.8, 0.6);
  }

  /** A site alarm. Level 1 is alerted, 2 is the fuse lit, 3 the final seconds: each faster, higher and
   *  fuller than the last (combat/alarmPattern). */
  alarm(secs = 4, level: AlarmLevel = 1): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.allow('alarm', 'combat', 70, 1000)) return;
    const pat = alarmPattern(level);
    const now = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(pat.gain, now + 0.3);
    g.gain.setValueAtTime(pat.gain, now + secs - 0.4);
    g.gain.linearRampToValueAtTime(0.0001, now + secs);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1800 + level * 400;
    lp.connect(g).connect(this.gunBus);
    const voice = (type: OscillatorType, ratio: number, level_: number) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      for (let t = 0; t < secs; t += pat.periodS) {
        osc.frequency.setValueAtTime(pat.loHz * ratio, now + t);
        osc.frequency.linearRampToValueAtTime(pat.hiHz * ratio, now + t + pat.periodS / 2);
        osc.frequency.linearRampToValueAtTime(pat.loHz * ratio, now + t + pat.periodS);
      }
      const og = ctx.createGain();
      og.gain.value = level_;
      osc.connect(og).connect(lp);
      osc.start(now);
      osc.stop(now + secs);
    };
    voice('sawtooth', 1, 1);
    if (pat.second) voice('square', 1.5, 0.35); // the last seconds are doubled a fifth up
  }

  // ── Extraction ──

  /** The extraction is called: a radio click and three rising notes. */
  extractCall(): void {
    const ctx = this.ctx;
    if (!ctx || !this.allow('extract', 'ui', 75, 600)) return;
    this.noiseBand(1500, 0.08, 0.12);
    const now = ctx.currentTime;
    [660, 880, 1100].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now + i * 0.11);
      g.gain.exponentialRampToValueAtTime(0.08, now + i * 0.11 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.11 + 0.14);
      o.connect(g).connect(this.uiBus);
      o.start(now + i * 0.11);
      o.stop(now + i * 0.11 + 0.16);
    });
  }

  /** You left the zone: two falling notes, a warning and not a punishment. */
  extractLeft(): void {
    const ctx = this.ctx;
    if (!ctx || !this.allow('extract', 'ui', 75, 600)) return;
    const now = ctx.currentTime;
    [700, 520].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now + i * 0.16);
      g.gain.exponentialRampToValueAtTime(0.06, now + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.16 + 0.2);
      o.connect(g).connect(this.uiBus);
      o.start(now + i * 0.16);
      o.stop(now + i * 0.16 + 0.22);
    });
  }

  /** Out: a resolved open fifth over a long low floor, the full stop after the countdown. */
  extractSuccess(): void {
    const ctx = this.ctx;
    if (!ctx || !this.allow('extract', 'ui', 80, 1800)) return;
    const now = ctx.currentTime;
    for (const [f, vol] of [[220, 0.16], [330, 0.14], [440, 0.1]] as const) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(vol, now + 0.12);
      g.gain.exponentialRampToValueAtTime(0.001, now + 1.7);
      o.connect(g).connect(this.uiBus);
      o.start(now);
      o.stop(now + 1.75);
    }
    this.musicGap(400);
  }

  /** The ride in: a low engine swelling while the countdown runs, fading when it ends or breaks. */
  setExtraction(on: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!on) {
      const h = this.extractHum;
      if (h) {
        h.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
        setTimeout(() => h.oscs.forEach((o) => { try { o.stop(); } catch { /* stopped */ } }), 1800);
        this.extractHum = null;
      }
      return;
    }
    if (this.extractHum) return;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 170;
    gain.connect(lp).connect(this.ambBus);
    const oscs = [52, 79, 104].map((f, i) => {
      const o = ctx.createOscillator();
      o.type = i === 2 ? 'sine' : 'sawtooth';
      // revving up as it approaches: where machinery masks the level (Cinder Yard), the rising pitch still reads
      o.frequency.setValueAtTime(f * 0.7, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(f, ctx.currentTime + 5);
      const g = ctx.createGain();
      g.gain.value = i === 2 ? 0.14 : 0.24;
      o.connect(g).connect(gain);
      o.start();
      return o;
    });
    gain.gain.setTargetAtTime(1, ctx.currentTime, 2.2); // it arrives slowly, like something approaching
    this.extractHum = { oscs, gain };
  }

  /** Dry hammer click on an empty magazine. */
  empty(): void {
    this.tick(1500, 0.09, 0, this.interactBus);
  }

  /**
   * A presence line (slice 6). Plays the per-speaker radio signature, ducks the
   * room (a voice owns it), then prefers the recorded /vo/{id}.mp3 — the lines
   * without a recording land on the signature + subtitle alone, exactly as the
   * story system was designed to degrade.
   */
  vo(id: string, speaker: Speaker): void {
    // The static + duck need the WebAudio graph, but the recording does not —
    // never let a missing context swallow a line.
    if (this.ctx) {
      this.radioSignature(speaker);
      this.radioDuck(1.8);
    }
    // A contract's own lines are written per mission and never have a recording.
    if (id.startsWith('dyn-')) return;
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
      el.volume = this.backgroundMuted ? 0 : Math.min(1, 0.95 * this.mix.voice * Math.min(1, this.mix.master / 0.9));
      // Some lines run long: hold the subtitle for the RECORDING, not a guess.
      el.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(el.duration) && el.duration > 0) this.voDurations.set(id, el.duration);
      });
      void el.play().catch(() => {});
    } catch { /* autoplay blocked */ }
  }

  /** Per-speaker static: you know WHO is talking before you read a word. */
  private radioSignature(speaker: Speaker): void {
    if (speaker === 'handler') {        // close, warm, a friend's channel
      this.noiseBand(1900, 0.1, 0.14);
      this.noiseBand(1400, 0.07, 0.09);
    } else if (speaker === 'vanguard') { // low — the channel drops to make room for command
      this.noiseBand(520, 0.16, 0.16);
    } else if (speaker === 'halcyon') {  // clean and narrow: a procurement desk's headset
      this.noiseBand(2800, 0.06, 0.1);
      this.noiseBand(2100, 0.05, 0.07);
    } else if (speaker === 'ashen') {   // harsh, overdriven: a refinery set
      this.noiseBand(760, 0.13, 0.15);
      this.noiseBand(2600, 0.09, 0.08);
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
    // A narrow band of noise carries little energy (it measured about -50 dBFS at the authored levels,
    // under the music), so the radio click is scaled up to sit where the cue can be heard.
    g.gain.setValueAtTime(vol * 8, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(bp).connect(g).connect(this.voiceBus ?? this.uiBus);
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
    if (!this.allow('footstep', 'interactions', 20, 120)) return;
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
    src.connect(lp).connect(g).connect(this.interactBus);
    src.start(now);
    src.stop(now + 0.08);
    this.stats_.footsteps++;
  }

  /** An ENEMY's shot: the same crack as yours, spatialised from the shooter so you hear where the
   *  fire is coming from. A shot beyond about 30 m arrives late (sound is slow), duller and with an
   *  echo off the ground. If `info` says the round missed, and its path really passed near your
   *  head, you hear it go by, before the crack, whether or not the shot itself is audible. */
  enemyShot(at: [number, number, number], info?: { impact: Vec3; hit: boolean }): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (info && !info.hit) {
      const c = closestApproach(at, info.impact, [this.lx, 1.6, this.lz]);
      const strength = nearMissStrength(c.dist);
      if (strength > 0) this.whiz(c.point, strength);
    }
    if (this.rifle.length === 0) return;
    const sp = spatialize(this.lx, this.lz, this.lyaw, at[0], at[2]);
    if (sp.gain <= 0.001) return;
    if (!this.allow('enemy-shot', 'combat', 50, 500)) return;
    const dist = Math.hypot(at[0] - this.lx, at[2] - this.lz);
    const cls = distanceClass(dist);
    const delay = cls === 'near' ? 0 : propagationDelay(dist);
    const play = (extraDelay: number, gain: number, lowpass: number) => {
      const src = ctx.createBufferSource();
      src.buffer = this.rifle[(Math.random() * this.rifle.length) | 0];
      src.playbackRate.value = 0.9 + Math.random() * 0.14;
      const pan = ctx.createStereoPanner();
      pan.pan.value = sp.pan;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = lowpass;
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(g);
      g.connect(pan);
      pan.connect(lp);
      lp.connect(this.impactBus);
      src.start(ctx.currentTime + delay + extraDelay);
    };
    play(0, sp.gain * 0.75 * (cls === 'far' ? 0.85 : 1), cls === 'far' ? Math.min(sp.lowpass, 1400) : sp.lowpass);
    if (cls === 'far') play(0.21, sp.gain * 0.22, 900); // the shot coming back off the ground and the hills
  }

  /** A round passing close to your head: a short high band sweeping down, panned to the side it passed. */
  private whiz(point: Vec3, strength: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.allow('whiz', 'combat', 85, 300)) return;
    const sp = spatialize(this.lx, this.lz, this.lyaw, point[0], point[2]);
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise(0.22);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 3;
    bp.frequency.setValueAtTime(5200, now);
    bp.frequency.exponentialRampToValueAtTime(1700, now + 0.2);
    const g = ctx.createGain();
    // band-limited noise carries little energy: it needs a high gain to read as a close pass (measured)
    g.gain.setValueAtTime(1.6 * strength, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    const pan = ctx.createStereoPanner();
    pan.pan.value = sp.pan;
    src.connect(bp).connect(g).connect(pan).connect(this.gunBus);
    src.start(now);
    src.stop(now + 0.24);
  }

  /** Someone walking nearby: a low thud from their position, only within earshot. */
  enemyStep(at: [number, number, number]): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const dist = Math.hypot(at[0] - this.lx, at[2] - this.lz);
    if (dist > 12) return;
    if (!this.allow('enemy-step', 'combat', 45, 160)) return;
    const sp = spatialize(this.lx, this.lz, this.lyaw, at[0], at[2]);
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise(0.06);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(sp.lowpass, 240 + Math.random() * 80);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.22 * sp.gain * (1 - dist / 14), now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    const pan = ctx.createStereoPanner();
    pan.pan.value = sp.pan;
    src.connect(lp).connect(g).connect(pan).connect(this.impactBus);
    src.start(now);
    src.stop(now + 0.09);
  }

  /** You got hit — a low body thud + a sharp sting, centred. */
  hurt(): void {
    if (!this.allow('hurt', 'combat', 95, 250)) return;
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
    osc.connect(g).connect(this.gunBus);
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
    n.connect(hp).connect(ng).connect(this.gunBus);
    n.start(now);
    n.stop(now + 0.09);
  }

  /** Low-HP heartbeat (lub-dub). The scene calls this on a cadence when hurt. */
  heartbeat(): void {
    if (!this.allow('heartbeat', 'combat', 60, 450)) return;
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
      o.connect(g).connect(this.gunBus);
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
    const cfg = ZONE_AMB[zone] ?? ZONE_AMB.DUSTLINE;
    this.ambBaseVol = cfg.vol;
    const ctx = this.ctx;
    if (!ctx) return; // applied by startAmbience() on the next unlock()
    if (this.ambLp) this.ambLp.frequency.setTargetAtTime(cfg.lp, ctx.currentTime, 0.4);
    this.ambBus.gain.cancelScheduledValues(ctx.currentTime);
    this.ambBus.gain.setTargetAtTime(this.ambTarget, ctx.currentTime, 0.6);
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
  /** The player's volume mix, applied immediately (0…1 each). */
  setMix(m: Partial<Mix> & Omit<Mix, 'music'>): void {
    this.mix = { ...this.mix, ...m };
    this.applyMix();
    this.syncMusic();
  }

  /** Silence everything while the tab is hidden (if the player wants that). */
  setBackgroundMuted(muted: boolean): void {
    this.backgroundMuted = muted;
    this.applyMix();
    // A hidden, muted tab does no audio work at all.
    if (muted) this.suspend('background'); else this.resume('background');
  }

  /** Reasons the graph is held. It runs only when there are none, so a key press while the pause
   *  menu is open cannot restart it, and showing the tab cannot un-pause it. */
  private holds = new Set<string>();

  /** Stop the whole graph's clock (the pause menu, a hidden tab). Sounds freeze where they are. */
  suspend(reason = 'app'): void {
    this.holds.add(reason);
    void this.ctx?.suspend?.();
  }

  /** Release one reason; the graph runs again once none remain. A no-op before the first gesture. */
  resume(reason = 'app'): void {
    this.holds.delete(reason);
    if (this.holds.size === 0) void this.ctx?.resume?.();
  }

  /** Whether anything is holding the graph stopped. */
  isHeld(): boolean {
    return this.holds.size > 0;
  }

  /** Per-channel accumulators, filled in the audio thread between reads. */
  private meterAcc: Record<string, { sumsq: number; n: number; peak: number }> | null = null;

  /** Build the taps on first use, so normal play pays nothing. They accumulate on the audio thread
   *  (an AudioWorklet), because a polled analyser only ever sees the tail of each rendered block and a
   *  short sound can fall between two reads, and a main-thread tap drops blocks whenever a heavy
   *  frame holds the page. Where worklets are missing it falls back to a ScriptProcessor. For probes
   *  and the dev bench, never the shipped mix path. Readings are zero until the worklet has loaded. */
  private ensureMeters(): void {
    const ctx = this.ctx;
    if (!ctx || this.meterAcc) return;
    const acc: Record<string, { sumsq: number; n: number; peak: number }> = {};
    this.meterAcc = acc;
    const taps: [string, AudioNode][] = [
      ['combat', this.combatDuck], ['environment', this.ambDuck], ['music', this.musicDuck], ['interactions', this.interactDuck],
      ['ui', this.uiBus], ['radio', this.voiceBus], ['master', this.master],
    ];
    for (const [name] of taps) acc[name] = { sumsq: 0, n: 0, peak: 0 };
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    const fallback = () => {
      for (const [name, node] of taps) {
        const m = acc[name];
        const proc = ctx.createScriptProcessor(1024, 1, 1);
        proc.onaudioprocess = (e) => {
          const d = e.inputBuffer.getChannelData(0);
          for (let i = 0; i < d.length; i++) { const v = d[i]; m.sumsq += v * v; const av = v < 0 ? -v : v; if (av > m.peak) m.peak = av; }
          m.n += d.length;
        };
        node.connect(proc);
        proc.connect(sink);
      }
    };
    const hasWorklet = !!ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined' && typeof Blob !== 'undefined' && typeof URL?.createObjectURL === 'function';
    if (!hasWorklet) { fallback(); return; }
    const code = 'class M extends AudioWorkletProcessor{constructor(){super();this.s=0;this.n=0;this.p=0}process(i){const c=i[0]&&i[0][0];if(c){for(let k=0;k<c.length;k++){const v=c[k];this.s+=v*v;const a=v<0?-v:v;if(a>this.p)this.p=a}this.n+=c.length;if(this.n>=2048){this.port.postMessage([this.s,this.n,this.p]);this.s=0;this.n=0;this.p=0}}return true}}registerProcessor("cz-meter",M)';
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    ctx.audioWorklet.addModule(url).then(() => {
      for (const [name, node] of taps) {
        const w = new AudioWorkletNode(ctx, 'cz-meter');
        w.port.onmessage = (e: MessageEvent<number[]>) => { const m = acc[name]; m.sumsq += e.data[0]; m.n += e.data[1]; if (e.data[2] > m.peak) m.peak = e.data[2]; };
        node.connect(w);
        w.connect(sink);
      }
    }).catch(fallback).finally(() => URL.revokeObjectURL(url));
  }

  /** The RMS level (0..1) of each channel since the last read, after ducking. The first call only
   *  starts the meters. For probes and the dev bench. */
  levels(): Record<string, number> {
    if (!this.ctx) return {};
    this.ensureMeters();
    const out: Record<string, number> = {};
    for (const [k, m] of Object.entries(this.meterAcc!)) { out[k] = m.n ? Math.sqrt(m.sumsq / m.n) : 0; m.sumsq = 0; m.n = 0; }
    return out;
  }

  /** The loudest single sample (0..1) of each channel since the last read: what a short sound reaches. */
  peaks(): Record<string, number> {
    if (!this.ctx) return {};
    this.ensureMeters();
    const out: Record<string, number> = {};
    for (const [k, m] of Object.entries(this.meterAcc!)) { out[k] = m.peak; m.peak = 0; }
    return out;
  }

  private applyMix(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const set = (g: GainNode | undefined, v: number) => g?.gain.setTargetAtTime(v, t, 0.05);
    set(this.master, this.backgroundMuted ? 0 : this.mix.master);
    set(this.gunBus, 0.9 * this.mix.effects);
    set(this.impactBus, 0.9 * this.mix.effects);
    set(this.uiBus, this.mix.ui);
    set(this.interactBus, this.mix.interactions);
    set(this.voiceBus, this.mix.voice);
    set(this.ambBus, this.ambTarget);
    set(this.envBus, this.mix.ambience);
    // MusicLayers is mixed hot (it was written to sit alone); 0.6 seats it under the fight.
    set(this.musicBus, 0.6 * this.mix.music);
  }

  /** Turn the refinery machinery bed on or off (Cinder Yard). */
  setMachinery(on: boolean): void {
    this.machineryOn = on;
    const ctx = this.ctx;
    if (!ctx) return; // applied on unlock
    if (!on) {
      if (this.machinery) {
        const m = this.machinery;
        m.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
        window.clearInterval(m.hiss);
        setTimeout(() => m.oscs.forEach((o) => { try { o.stop(); } catch { /* stopped */ } }), 1200);
        this.machinery = null;
      }
      return;
    }
    if (this.machinery) return;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 180;
    gain.connect(lp).connect(this.ambBus);
    // Two detuned saws a few hertz apart: the beat is the pumps.
    const oscs = [49, 51.5, 98].map((f, i) => {
      const o = ctx.createOscillator();
      o.type = i < 2 ? 'sawtooth' : 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = i < 2 ? 0.05 : 0.03;
      o.connect(g).connect(gain);
      o.start();
      return o;
    });
    gain.gain.setTargetAtTime(1, ctx.currentTime, 1.2);
    // A steam vent somewhere lets go every few seconds.
    const hiss = window.setInterval(() => {
      const c = this.ctx;
      if (!c || !this.machineryOn) return;
      const now = c.currentTime;
      const n = c.createBufferSource();
      n.buffer = this.noise(1.4);
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2600 + Math.random() * 1500;
      bp.Q.value = 0.7;
      const g = c.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.035, now + 0.15);
      g.gain.exponentialRampToValueAtTime(0.001, now + 1.3);
      const pan = c.createStereoPanner();
      pan.pan.value = Math.random() * 1.6 - 0.8;
      n.connect(bp).connect(g).connect(pan).connect(this.ambBus);
      n.start(now);
      n.stop(now + 1.4);
    }, 4800);
    this.machinery = { oscs, gain, hiss };
  }

  private startAmbience(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.machineryOn) setTimeout(() => this.setMachinery(true), 0);
    const cfg = ZONE_AMB[this.zone] ?? ZONE_AMB.DUSTLINE;
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

  /** Dip a duck stage to (1 - amount) and let it swell back over `seconds`. */
  private dip(node: GainNode | undefined, amount: number, seconds: number): void {
    const ctx = this.ctx;
    if (!ctx || !node) return;
    const now = ctx.currentTime;
    const g = node.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(0, 1 - amount), now);
    g.linearRampToValueAtTime(1, now + seconds + 0.25);
  }

  /** Duck the ambience under a loud event, then let it swell back. */
  private duck(amount: number, seconds: number): void {
    this.dip(this.ambDuck, amount, seconds);
  }

  /** A radio line owns the mix: music, combat and handling dip rather than vanish, and the room
   *  tone eases back, so the voice is clear and the world is still there. */
  private radioDuck(seconds: number): void {
    this.dip(this.musicDuck, 0.55, seconds);
    this.dip(this.combatDuck, 0.35, seconds);
    this.dip(this.interactDuck, 0.3, seconds);
    this.duck(0.5, seconds);
  }

  private tick(freq: number, vol: number, delay: number, bus?: GainNode): void {
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
    src.connect(bp).connect(g).connect(bus ?? this.uiBus);
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
