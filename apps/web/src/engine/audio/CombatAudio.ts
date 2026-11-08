import { Howl, Howler } from 'howler';
import type { DamageEvent } from '../combat/DamageSystem';
import type { GunShotAudio } from '../combat/GunFeel';

// Fallback shot voice when no per-gun profile is passed (≈ the old generic crack).
const DEFAULT_SHOT: GunShotAudio = {
  noiseDur: 0.06, hpFreq: 1100, bodyF0: 180, bodyF1: 70, bodyDur: 0.08, vol: 0.55,
};

interface SoundBank {
  sounds: Howl[];
  volume: number;
}

function loadBank(paths: string[], volume = 1): SoundBank {
  return {
    sounds: paths.map(
      (src) => new Howl({ src: [src], preload: true, volume })
    ),
    volume,
  };
}

function playOne(bank: SoundBank, pitchVariation = 0.08): number | undefined {
  if (bank.sounds.length === 0) return;
  const sound = bank.sounds[Math.floor(Math.random() * bank.sounds.length)];
  const rate = 1 + (Math.random() - 0.5) * pitchVariation * 2;
  sound.rate(rate);
  sound.volume(bank.volume);
  return sound.play();
}

export class CombatAudio {
  private whoosh: SoundBank;
  private punchHit: SoundBank;
  private slashHit: SoundBank;
  private blockHit: SoundBank;
  private bodyFall: SoundBank;
  private stopped = false;

  constructor() {
    this.whoosh = loadBank([
      '/sounds/combat/whoosh_802462.mp3',
      '/sounds/combat/whoosh_768408.mp3',
    ], 0.3);

    this.punchHit = loadBank([
      '/sounds/combat/punch_276600.mp3',
      '/sounds/combat/punch_847837.mp3',
    ], 0.8);

    this.slashHit = loadBank([
      '/sounds/combat/slash_437118.mp3',
      '/sounds/combat/slash_776646.mp3',
    ], 0.7);

    this.blockHit = loadBank([
      '/sounds/combat/slash_437118.mp3',
    ], 0.3);

    this.bodyFall = loadBank([
      '/sounds/combat/fall_504626.mp3',
    ], 0.4);
  }

  playSwing(_classId?: string) {
    if (this.stopped) return;
    playOne(this.whoosh);
  }

  onDamageEvent(event: DamageEvent) {
    if (this.stopped) return;

    if (event.blocked) {
      playOne(this.blockHit);
      return;
    }

    if (event.hitType === 'light') {
      playOne(this.punchHit);
    } else if (event.hitType === 'heavy') {
      playOne(this.slashHit);
      this.subThump(150, 40, 0.8, 0.18);
      this.duckBGM(0.4, 180);
    } else {
      playOne(this.punchHit);
      setTimeout(() => !this.stopped && playOne(this.slashHit), 60);
      this.subThump(180, 38, 1.0, 0.28);
      this.duckBGM(0.55, 240);
    }

    if (event.killed) {
      this.subThump(200, 30, 1.0, 0.5);
      setTimeout(() => {
        if (!this.stopped) playOne(this.bodyFall);
      }, 300);
    }
  }

  playComboHit(comboCount: number) {
    if (this.stopped) return;
    const sound = this.punchHit.sounds[0];
    if (sound) {
      sound.rate(1 + comboCount * 0.06);
      sound.volume(Math.min(0.6, 0.3 + comboCount * 0.04));
      sound.play();
    }
  }

  playFootstep(volume = 0.08) {
    if (this.stopped) return;
    try {
      const ctx = this.getSharedContext();
      if (!ctx) return;
      const now = ctx.currentTime;

      const noise = ctx.createBufferSource();
      const bufferSize = ctx.sampleRate * 0.04;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
      }
      noise.buffer = buffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 200 + Math.random() * 100;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(volume, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

      noise.connect(filter).connect(gain).connect(ctx.destination);
      noise.start(now);
      noise.stop(now + 0.06);
    } catch {}
  }

  /** A gunshot voiced per weapon (crack + body from the gun's GunShotAudio profile).
   *  Kept brief so rapid-fire weapons don't smear into a wall of sound. `volumeScale`
   *  lets the opponent's fire sit a little behind your own in the mix. */
  playGunshot(shot: GunShotAudio = DEFAULT_SHOT, volumeScale = 1) {
    if (this.stopped) return;
    try {
      const ctx = this.getSharedContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const vol = shot.vol * volumeScale;

      // Crack — high-passed noise burst; cutoff/length are the gun's signature.
      const buf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * shot.noiseDur)), ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = shot.hpFreq;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.55 * vol, now);
      ng.gain.exponentialRampToValueAtTime(0.001, now + shot.noiseDur + 0.01);
      noise.connect(hp).connect(ng).connect(ctx.destination);
      noise.start(now);
      noise.stop(now + shot.noiseDur + 0.01);

      // Body — downward sine punch; big guns sweep lower and longer.
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(shot.bodyF0, now);
      osc.frequency.exponentialRampToValueAtTime(shot.bodyF1, now + shot.bodyDur);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.4 * vol, now);
      og.gain.exponentialRampToValueAtTime(0.001, now + shot.bodyDur + 0.01);
      osc.connect(og).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + shot.bodyDur + 0.02);

      // Sub-thump for the heavy weapons — the shot you feel in the chest.
      if (shot.thump) this.subThump(110, 35, 0.7 * volumeScale, 0.2);
    } catch {}
  }

  /** Mag-out: two quick mechanical ticks at reload start. */
  playReloadStart(volumeScale = 1) {
    if (this.stopped) return;
    this.mechTick(2600, 0.14 * volumeScale, 0);
    this.mechTick(1800, 0.11 * volumeScale, 0.09);
  }

  /** Mag-in "chunk" when the reload completes — the gun is live again. */
  playReloadEnd(volumeScale = 1) {
    if (this.stopped) return;
    this.mechTick(1200, 0.16 * volumeScale, 0);
    try {
      const ctx = this.getSharedContext();
      if (!ctx) return;
      const now = ctx.currentTime + 0.03;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 620;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.12 * volumeScale, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
      osc.connect(g).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.1);
    } catch {}
  }

  /** Crisp confirmation tick when YOUR shot lands — crits get a double tick. */
  playHitmarker(crit = false) {
    if (this.stopped) return;
    this.mechTick(crit ? 3200 : 2400, 0.12, 0);
    if (crit) this.mechTick(4200, 0.1, 0.05);
  }

  /** Short filtered-noise click — the building block of weapon-handling foley. */
  private mechTick(freq: number, vol: number, delay: number) {
    try {
      const ctx = this.getSharedContext();
      if (!ctx) return;
      const now = ctx.currentTime + delay;
      const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.03), ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      bp.Q.value = 1.4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
      noise.connect(bp).connect(g).connect(ctx.destination);
      noise.start(now);
      noise.stop(now + 0.04);
    } catch {}
  }

  /** Bright metallic clang for a parry / perfect guard. */
  playParry() {
    if (this.stopped) return;
    try {
      const ctx = this.getSharedContext();
      if (!ctx) return;
      const now = ctx.currentTime;

      // sharp noise tick
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.05, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 3000;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.4, now);
      ng.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      noise.connect(hp).connect(ng).connect(ctx.destination);
      noise.start(now);
      noise.stop(now + 0.05);

      // ringing metallic partials
      [2200, 3300, 4400].forEach((f, i) => {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = f;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.1 / (i + 1), now + 0.005);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
        osc.connect(g).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.4);
      });
    } catch {}
  }

  playComboMilestone(count: number) {
    if (this.stopped) return;
    const baseFreq = 440 + count * 40;
    this.synthNote(baseFreq, 0.12, 0.08);
    setTimeout(() => this.synthNote(baseFreq * 1.5, 0.1, 0.1), 50);
    setTimeout(() => this.synthNote(baseFreq * 2, 0.08, 0.12), 100);
  }

  // --- Crowd ambience (procedural) ---
  private crowdGain: GainNode | null = null;
  private crowdSource: AudioBufferSourceNode | null = null;
  private crowdBaseVol = 0.05;

  /** Continuous low murmur of the arena crowd — looped filtered noise. */
  startCrowdAmbience() {
    if (this.stopped || this.crowdSource) return;
    try {
      const ctx = this.getSharedContext();
      if (!ctx) return;

      const seconds = 2;
      const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      let last = 0;
      for (let i = 0; i < data.length; i++) {
        // brown-ish noise = warmer, less hiss → reads as a hum of voices
        last = (last + (Math.random() * 2 - 1) * 0.08) * 0.96;
        data[i] = last;
      }

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 700;

      const gain = ctx.createGain();
      gain.gain.value = this.crowdBaseVol;

      src.connect(filter).connect(gain).connect(ctx.destination);
      src.start();

      this.crowdSource = src;
      this.crowdGain = gain;
    } catch {}
  }

  /** Continuously track crowd excitement (0..1) → murmur swells. */
  setCrowdEnergy(energy: number) {
    if (!this.crowdGain) return;
    const target = this.crowdBaseVol + energy * 0.12;
    this.crowdGain.gain.value += (target - this.crowdGain.gain.value) * 0.1;
  }

  /** Bright, rising swell — the crowd pops for a clean hit / KO. */
  crowdCheer(intensity = 0.6) {
    this.crowdNoiseSwell(1500, 0.9, 0.35 + intensity * 0.6, 0.18 + intensity * 0.25);
  }

  /** Lower, growling jeer — block, whiff, or the player getting hit. */
  crowdBoo(intensity = 0.5) {
    this.crowdNoiseSwell(320, 1.6, 0.45 + intensity * 0.5, 0.12 + intensity * 0.2);
  }

  private crowdNoiseSwell(centerHz: number, q: number, dur: number, vol: number) {
    if (this.stopped) return;
    try {
      const ctx = this.getSharedContext();
      if (!ctx) return;
      const now = ctx.currentTime;

      const buffer = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

      const src = ctx.createBufferSource();
      src.buffer = buffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = centerHz;
      filter.Q.value = q;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(vol, now + dur * 0.35);
      gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

      src.connect(filter).connect(gain).connect(ctx.destination);
      src.start(now);
      src.stop(now + dur);
    } catch {}
  }

  // --- Environment ambience (procedural) ---
  // Battlefield stages have no crowd; they breathe instead: a looped wind bed
  // that gusts on a slow LFO, plus sparse ember crackles from what still burns.
  private windSource: AudioBufferSourceNode | null = null;
  private windLfo: OscillatorNode | null = null;
  private emberIntervalId: ReturnType<typeof setInterval> | null = null;

  startWindAmbience() {
    if (this.stopped || this.windSource) return;
    try {
      const ctx = this.getSharedContext();
      if (!ctx) return;

      // Wind bed: brown noise through a low-pass reads as moving air, not hiss.
      const seconds = 4;
      const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      let last = 0;
      for (let i = 0; i < data.length; i++) {
        last = (last + (Math.random() * 2 - 1) * 0.05) * 0.98;
        data[i] = last;
      }

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 420;

      const gain = ctx.createGain();
      gain.gain.value = 0.055;

      // Gusts: the LFO wobbles the bed between lulls and pushes (~14s period).
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.07;
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 0.035;
      lfo.connect(lfoDepth).connect(gain.gain);
      lfo.start();

      src.connect(filter).connect(gain).connect(ctx.destination);
      src.start();

      this.windSource = src;
      this.windLfo = lfo;

      this.emberIntervalId = setInterval(() => {
        if (this.stopped || Math.random() < 0.45) return;
        this.emberCrackle();
      }, 700);
    } catch {}
  }

  private emberCrackle() {
    try {
      const ctx = this.getSharedContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const dur = 0.03 + Math.random() * 0.05;
      const buf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * dur)), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2200 + Math.random() * 2600;
      bp.Q.value = 4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.014 + Math.random() * 0.028, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + dur);
      src.connect(bp).connect(g).connect(ctx.destination);
      src.start(now);
      src.stop(now + dur);
    } catch {}
  }

  private stopWindAmbience() {
    if (this.emberIntervalId) {
      clearInterval(this.emberIntervalId);
      this.emberIntervalId = null;
    }
    if (this.windLfo) {
      try { this.windLfo.stop(); } catch {}
      this.windLfo = null;
    }
    if (this.windSource) {
      try { this.windSource.stop(); } catch {}
      this.windSource = null;
    }
  }

  private bgmCtx: AudioContext | null = null;
  private bgmGain: GainNode | null = null;
  private bgmIntervalId: ReturnType<typeof setInterval> | null = null;

  startBGM() {
    if (this.stopped || this.bgmCtx) return;
    try {
      const ctx = new AudioContext();
      this.bgmCtx = ctx;
      const masterGain = ctx.createGain();
      masterGain.gain.value = 0.06;
      masterGain.connect(ctx.destination);
      this.bgmGain = masterGain;

      const bassNotes = [65.41, 73.42, 82.41, 73.42]; // C2, D2, E2, D2
      let noteIdx = 0;

      const playBeat = () => {
        if (this.stopped || !this.bgmCtx) return;
        const now = ctx.currentTime;
        const freq = bassNotes[noteIdx % bassNotes.length];
        noteIdx++;

        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = freq;

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 300;

        const env = ctx.createGain();
        env.gain.setValueAtTime(0.3, now);
        env.gain.exponentialRampToValueAtTime(0.01, now + 0.4);

        osc.connect(filter).connect(env).connect(masterGain);
        osc.start(now);
        osc.stop(now + 0.45);

        // Kick drum on beats 1 and 3
        if (noteIdx % 2 === 1) {
          const kick = ctx.createOscillator();
          kick.type = 'sine';
          kick.frequency.setValueAtTime(150, now);
          kick.frequency.exponentialRampToValueAtTime(30, now + 0.1);
          const kickEnv = ctx.createGain();
          kickEnv.gain.setValueAtTime(0.6, now);
          kickEnv.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
          kick.connect(kickEnv).connect(masterGain);
          kick.start(now);
          kick.stop(now + 0.15);
        }
      };

      playBeat();
      this.bgmIntervalId = setInterval(playBeat, 500);
    } catch {}
  }

  playVictoryFanfare() {
    if (this.stopped) return;
    this.synthNote(523, 0.12, 0.15);
    setTimeout(() => this.synthNote(659, 0.12, 0.15), 100);
    setTimeout(() => this.synthNote(784, 0.12, 0.15), 200);
    setTimeout(() => this.synthNote(1047, 0.15, 0.2), 300);
  }

  playDefeatMelody() {
    if (this.stopped) return;
    this.synthNote(330, 0.15, 0.4);
    setTimeout(() => this.synthNote(220, 0.15, 0.5), 200);
  }

  private subThump(f0 = 150, f1 = 40, vol = 0.8, dur = 0.18) {
    const ctx = this.getSharedContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(f1, now + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur);
  }

  private duckBGM(amount = 0.4, ms = 180) {
    if (!this.bgmGain) return;
    const base = 0.06;
    this.bgmGain.gain.value = base * (1 - amount);
    setTimeout(() => {
      if (this.bgmGain) this.bgmGain.gain.value = base;
    }, ms);
  }

  /**
   * Stop ONLY the combat music bed. Crowd ambience and one-shots stay live —
   * this is the KO beat, where the BGM cuts, the crowd roars, and the
   * victory/defeat sting still has to play. (The old KO path called stopAll(),
   * whose `stopped` flag silently gated the fanfare off — it never played.)
   */
  stopMusic() {
    if (this.bgmIntervalId) {
      clearInterval(this.bgmIntervalId);
      this.bgmIntervalId = null;
    }
    if (this.bgmGain) {
      this.bgmGain.gain.value = 0;
    }
    if (this.bgmCtx) {
      this.bgmCtx.close().catch(() => {});
      this.bgmCtx = null;
    }
  }

  /** Full shutdown (page/unmount): silences everything, including future one-shots. */
  stopAll() {
    this.stopped = true;
    Howler.stop();
    if (this.crowdSource) {
      try { this.crowdSource.stop(); } catch {}
      this.crowdSource = null;
    }
    this.crowdGain = null;
    this.stopWindAmbience();
    this.stopMusic();
  }

  private sharedCtx: AudioContext | null = null;

  private getSharedContext(): AudioContext | null {
    if (this.sharedCtx && this.sharedCtx.state !== 'closed') return this.sharedCtx;
    try {
      this.sharedCtx = new AudioContext();
      return this.sharedCtx;
    } catch {
      return null;
    }
  }

  private synthNote(freq: number, volume: number, duration: number) {
    try {
      const ctx = this.getSharedContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(volume, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + duration);
    } catch {}
  }
}
