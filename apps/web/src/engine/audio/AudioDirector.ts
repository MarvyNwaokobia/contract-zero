import { MusicLayers } from './MusicLayers';
import { spatialize } from './spatial';

/**
 * AudioDirector — the game's ear (CLONE_PLAN.md slice 2).
 *
 * One WebAudio graph, four rules from the reference study:
 *
 *  1. WEIGHT: every impact is a stack — sub you feel, body you hear, a
 *     material transient, a tail. The catch is the deepest sound in the game.
 *  2. INFORMATION: positional sounds are spatialized (pan + distance gain +
 *     behind-you muffle, see spatial.ts). The recall whistle re-pans every
 *     frame, so you can track the blade's arc with your eyes closed.
 *  3. SCORE: MusicLayers swells with fight state and gets hard-cut gaps under
 *     the beats that matter.
 *  4. HIERARCHY: verb > impacts > score > ambience. Big sounds duck the
 *     score; the catch also punches a silence into it.
 *
 * Everything is synthesized (no downloads). When real stems/samples land,
 * they slot into the same buses and the callers never change.
 */

export type ImpactMaterial = 'flesh' | 'stone' | 'ground' | 'metal';
export type ImpactWeight = 'light' | 'heavy' | 'massive';

interface Pos { x: number; z: number }

// Weight → the sub/body layer shape.
const WEIGHT_SHAPE: Record<ImpactWeight, { f0: number; f1: number; dur: number; vol: number }> = {
  light:   { f0: 200, f1: 70, dur: 0.09, vol: 0.45 },
  heavy:   { f0: 170, f1: 48, dur: 0.14, vol: 0.7 },
  massive: { f0: 150, f1: 40, dur: 0.2,  vol: 0.9 },
};

// Material → the transient's filter band and tail character.
const MATERIAL_VOICE: Record<ImpactMaterial, { band: number; q: number; tail: number }> = {
  flesh:  { band: 650,  q: 0.9, tail: 0 },
  stone:  { band: 1900, q: 1.4, tail: 0.22 },
  ground: { band: 420,  q: 0.8, tail: 0.3 },
  metal:  { band: 2600, q: 2.2, tail: 0.12 },
};

export class AudioDirector {
  private ctx: AudioContext | null = null;
  private master: DynamicsCompressorNode | null = null;

  private musicBus: GainNode | null = null;
  private ambienceBus: GainNode | null = null;
  private impactBus: GainNode | null = null;
  private verbBus: GainNode | null = null;

  private music: MusicLayers | null = null;

  private listener = { x: 0, z: 0, yaw: 0 };

  // Continuous recall whistle chain.
  private whistleOsc: OscillatorNode | null = null;
  private whistleGain: GainNode | null = null;
  private whistlePan: StereoPannerNode | null = null;
  private whistleLpf: BiquadFilterNode | null = null;

  private started = false;

  /** Call from any user-gesture handler; boots the graph + score once. */
  unlock() {
    const g = this.graph();
    if (!g) return;
    if (g.ctx.state === 'suspended') void g.ctx.resume();
    if (!this.started) {
      this.started = true;
      this.music?.start();
      this.startAmbience();
    }
  }

  setListener(x: number, z: number, yaw: number) {
    this.listener.x = x;
    this.listener.z = z;
    this.listener.yaw = yaw;
  }

  setIntensity(level: 0 | 1 | 2 | 3) {
    this.music?.setIntensity(level);
  }

  dispose() {
    this.stopWhistle();
    this.setHeartbeat(false);
    this.music?.dispose();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.music = null;
    this.started = false;
  }

  // ── The verb ───────────────────────────────────────────────────────────────

  /** Blade leaves the hand: low whoosh, self-positioned (no spatial). */
  throw_() {
    this.noiseSweep(900, 300, 0.22, 0.4, this.verbBus);
    this.sine(140, 90, 0.12, 0.15, this.verbBus);
    this.duckMusic(0.6, 120);
  }

  embed(material: ImpactMaterial, pos: Pos) {
    this.impact(material, material === 'flesh' ? 'massive' : 'heavy', pos);
  }

  /** The rip as the blade tears free, wherever it is. */
  rip(pos: Pos) {
    this.spatialOneShot(pos, this.verbBus, (dest) => {
      this.noiseSweep(500, 1600, 0.09, 0.35, dest);
    });
  }

  recallHit(pos: Pos) {
    this.impact('flesh', 'light', pos);
  }

  /**
   * THE sound: the catch. Not spatialized — it happens in your hands.
   * Sub punch + knuckle + slap + steel ring, and a hole cut in the score.
   */
  catch_() {
    this.sine(95, 36, 0.24, 0.9, this.verbBus);
    this.sine(240, 100, 0.08, 0.4, this.verbBus);
    this.noiseSweep(1800, 700, 0.04, 0.35, this.verbBus);
    this.ring(1320, 0.3, 0.08, this.verbBus);
    this.ring(1980, 0.22, 0.05, this.verbBus);
    this.music?.gap(140);
    this.duckMusic(0.35, 280);
  }

  meleeWhiff(stage: number) {
    this.noiseSweep(1400 + stage * 200, 500, 0.1, 0.16, this.verbBus);
  }

  /**
   * Round cleared: punch a hole in the score, then a resolved D open-fifth
   * swell (no third — dark-triumphant, same key as the leitmotif) over a
   * long sub. The audible full stop the kill moment was missing.
   */
  roundClear() {
    this.music?.gap(520);
    this.duckMusic(0.3, 600);
    this.sine(60, 38, 0.55, 0.8, this.verbBus); // the floor drops
    const g = this.graph();
    if (!g || !this.verbBus) return;
    try {
      const now = g.ctx.currentTime + 0.09; // let the sub land first
      for (const [freq, vol] of [[146.83, 0.2], [220.0, 0.18], [293.66, 0.14]] as const) {
        const osc = g.ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        osc.detune.value = (Math.random() - 0.5) * 8;
        const gain = g.ctx.createGain();
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.exponentialRampToValueAtTime(vol, now + 0.07);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 1.5);
        osc.connect(gain).connect(this.verbBus);
        osc.start(now);
        osc.stop(now + 1.55);
      }
      this.ring(1174.66, 0.7, 0.05, this.verbBus); // D6 shimmer on top
    } catch {}
  }

  meleeHit(stage: number, buffed: boolean, pos: Pos) {
    const weight: ImpactWeight = stage === 3 || buffed ? 'heavy' : 'light';
    this.impact('flesh', weight, pos);
    if (buffed) this.ring(1560, 0.18, 0.05, this.verbBus); // the catch-strike glint
  }

  dash() {
    this.noiseSweep(600, 1800, 0.12, 0.18, this.verbBus);
  }

  // ── Threat audio (slice 4): every attack is audible before it lands ────────

  /** Attack tell, spatialized at the attacker. One voice per archetype so
   *  eyes-closed play can name WHO is winding up, not just where. */
  tell(archetype: 'rusher' | 'gunner' | 'bulwark', pos: Pos) {
    this.spatialOneShot(pos, this.impactBus, (dest) => {
      if (archetype === 'rusher') {
        this.noiseSweep(320, 1000, 0.32, 0.5, dest);          // rising snarl
      } else if (archetype === 'gunner') {
        this.sine(600, 1500, 0.55, 0.28, dest);               // charge whine (rises)
      } else {
        this.sine(58, 45, 0.28, 0.85, dest);                  // war-drum double
        this.sine(58, 45, 0.28, 0.85, dest);
      }
    });
  }

  /** Gunner muzzle crack at the shooter's position. */
  enemyShot(pos: Pos) {
    this.spatialOneShot(pos, this.impactBus, (dest) => {
      this.noiseSweep(1600, 500, 0.07, 0.5, dest);
      this.sine(220, 80, 0.07, 0.4, dest);
    });
  }

  /** Taking a hit: a dull, personal thud — never spatialized, it's YOU. */
  heroHit() {
    this.sine(140, 48, 0.16, 0.8, this.verbBus);
    this.noiseBand(420, 0.8, 0.05, 0.4, this.verbBus);
    this.duckMusic(0.45, 220);
  }

  /** The defeat: score hole + a falling minor line. Quiet, not melodramatic. */
  heroDown() {
    this.music?.gap(900);
    this.sine(70, 30, 0.8, 0.9, this.verbBus);
    const g = this.graph();
    if (!g || !this.verbBus) return;
    try {
      // D3 → C3 → Bb2, one per beat: the theme falling over.
      const line: Array<[number, number]> = [[146.83, 0], [130.81, 0.4], [116.54, 0.8]];
      for (const [freq, at] of line) {
        const osc = g.ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        const gain = g.ctx.createGain();
        const t = g.ctx.currentTime + at;
        gain.gain.setValueAtTime(0.001, t);
        gain.gain.exponentialRampToValueAtTime(0.2, t + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
        osc.connect(gain).connect(this.verbBus);
        osc.start(t);
        osc.stop(t + 0.95);
      }
    } catch {}
  }

  /** Boss move tells: bigger voices than the troops, still one per move. */
  bossTell(move: 'torchSwing' | 'emberToss' | 'flameRush' | 'ashRing', pos: Pos) {
    this.spatialOneShot(pos, this.impactBus, (dest) => {
      switch (move) {
        case 'torchSwing':
          this.noiseSweep(220, 700, 0.4, 0.6, dest); // low snarl
          break;
        case 'emberToss':
          this.sine(500, 1300, 0.6, 0.3, dest);      // charge whine
          this.noiseBand(2100, 1.6, 0.3, 0.2, dest); // crackle
          break;
        case 'flameRush':
          this.noiseSweep(150, 900, 0.7, 0.6, dest); // building roar
          this.sine(50, 120, 0.7, 0.5, dest);        // RISING sub = danger
          break;
        case 'ashRing':
          this.sine(56, 40, 0.24, 0.9, dest);        // war drums, three of them
          setTimeout(() => this.sine(56, 40, 0.24, 0.9, dest), 280);
          setTimeout(() => this.sine(60, 42, 0.28, 1.0, dest), 560);
          break;
      }
    });
    this.duckMusic(0.6, 300);
  }

  /** The phase roar: the fight re-teaching itself. */
  bossRoar(pos: Pos) {
    this.music?.gap(350);
    this.duckMusic(0.3, 500);
    this.spatialOneShot(pos, this.verbBus, (dest) => {
      this.noiseSweep(700, 150, 0.8, 0.9, dest);  // falling roar
      this.sine(90, 32, 0.7, 1.0, dest);          // chest sub
      this.ring(180, 0.5, 0.1, dest);
    });
  }

  // ── Voices (slice 5): VO sits at the very top of the hierarchy ─────────────

  /**
   * Play a presence line. Prefers a generated VO file (public/vo/{id}.mp3,
   * produced by scripts/generate-vo.mjs); until those exist, the line lands
   * as the speaker's radio signature under the subtitle. Ducks the score
   * either way — a voice owns the room.
   */
  playVo(id: string, speaker: 'ember' | 'valor' | 'cinder') {
    this.radioSignature(speaker);
    this.duckMusic(0.4, 1600);
    const known = this.voAvailable.get(id);
    if (known === false) return; // no file: the signature carried the line
    if (known === true) {
      this.playVoFile(id);
      return;
    }
    // First ask politely (fetch 404s don't spam the console like <audio> does).
    fetch(`/vo/${id}.mp3`, { method: 'HEAD' })
      .then((r) => {
        this.voAvailable.set(id, r.ok);
        if (r.ok) this.playVoFile(id);
      })
      .catch(() => this.voAvailable.set(id, false));
  }

  private voAvailable = new Map<string, boolean>();

  private playVoFile(id: string) {
    try {
      const el = new Audio(`/vo/${id}.mp3`);
      el.volume = 0.9;
      void el.play().catch(() => {});
    } catch {}
  }

  /** Per-speaker radio static: tells WHO is talking before you read a word. */
  private radioSignature(speaker: 'ember' | 'valor' | 'cinder') {
    switch (speaker) {
      case 'ember': // close, warm, slightly bright — a friend's channel
        this.noiseBand(1900, 1.1, 0.09, 0.18, this.verbBus);
        this.noiseBand(1400, 1.4, 0.06, 0.12, this.verbBus);
        break;
      case 'valor': // he doesn't crackle in — the channel drops to make room
        this.sine(120, 34, 0.5, 0.5, this.verbBus);
        this.noiseBand(700, 0.7, 0.3, 0.14, this.verbBus);
        this.music?.gap(260);
        break;
      case 'cinder': // fire on the line
        this.noiseBand(2600, 0.8, 0.18, 0.2, this.verbBus);
        this.noiseSweep(900, 300, 0.25, 0.2, this.verbBus);
        break;
    }
  }

  /** Low-HP heartbeat layer — informational audio, not decoration. */
  setHeartbeat(on: boolean) {
    if (on === (this.heartbeatTimer !== null)) return;
    if (!on) {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      return;
    }
    const g = this.graph();
    if (!g) return;
    const thump = () => {
      this.sine(72, 38, 0.12, 0.5, this.verbBus);
      setTimeout(() => this.sine(64, 34, 0.1, 0.35, this.verbBus), 180);
    };
    thump();
    this.heartbeatTimer = setInterval(thump, 850);
  }

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  death(pos: Pos) {
    this.spatialOneShot(pos, this.impactBus, (dest) => {
      this.sine(110, 30, 0.34, 0.7, dest);
      this.noiseSweep(300, 90, 0.3, 0.25, dest);
    });
    this.duckMusic(0.45, 260);
  }

  // ── Recall whistle (continuous, re-spatialized every frame) ────────────────

  startWhistle() {
    const g = this.graph();
    if (!g) return;
    this.stopWhistle();
    this.whistleOsc = g.ctx.createOscillator();
    this.whistleOsc.type = 'sawtooth';
    this.whistleOsc.frequency.value = 300;
    const bp = g.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 6;
    this.whistleLpf = g.ctx.createBiquadFilter();
    this.whistleLpf.type = 'lowpass';
    this.whistleLpf.frequency.value = 16000;
    this.whistlePan = g.ctx.createStereoPanner();
    this.whistleGain = g.ctx.createGain();
    this.whistleGain.gain.value = 0.0001;
    this.whistleOsc
      .connect(bp)
      .connect(this.whistleLpf)
      .connect(this.whistlePan)
      .connect(this.whistleGain)
      .connect(this.verbBus!);
    this.whistleOsc.start();
  }

  /** Feed the blade's world position + arc progress each frame. */
  setWhistle(pos: Pos, progress: number) {
    if (!this.whistleOsc || !this.whistleGain || !this.whistlePan || !this.whistleLpf || !this.ctx) return;
    const t = this.ctx.currentTime;
    const s = spatialize(this.listener.x, this.listener.z, this.listener.yaw, pos.x, pos.z);
    this.whistleOsc.frequency.setTargetAtTime(300 + progress * progress * 900, t, 0.02);
    this.whistleGain.gain.setTargetAtTime((0.03 + progress * 0.15) * Math.max(s.gain, 0.25), t, 0.03);
    this.whistlePan.pan.setTargetAtTime(s.pan, t, 0.03);
    this.whistleLpf.frequency.setTargetAtTime(s.lowpass, t, 0.04);
  }

  stopWhistle() {
    try {
      this.whistleOsc?.stop();
      this.whistleOsc?.disconnect();
      this.whistleGain?.disconnect();
      this.whistlePan?.disconnect();
      this.whistleLpf?.disconnect();
    } catch {}
    this.whistleOsc = null;
    this.whistleGain = null;
    this.whistlePan = null;
    this.whistleLpf = null;
  }

  // ── The impact stack ───────────────────────────────────────────────────────

  /** sub + body + material transient + tail, positioned in the world. */
  private impact(material: ImpactMaterial, weight: ImpactWeight, pos: Pos) {
    const w = WEIGHT_SHAPE[weight];
    const m = MATERIAL_VOICE[material];
    this.spatialOneShot(pos, this.impactBus, (dest) => {
      this.sine(w.f0, w.f1, w.dur, w.vol, dest);                       // body
      if (weight !== 'light') this.sine(70, 34, w.dur + 0.06, w.vol * 0.7, dest); // sub
      this.noiseBand(m.band, m.q, 0.045, 0.5, dest);                   // transient
      if (m.tail > 0) this.noiseSweep(m.band, m.band * 0.3, m.tail, 0.18, dest); // debris
      if (material === 'metal') this.ring(2200, 0.2, 0.06, dest);
    });
    this.duckMusic(weight === 'light' ? 0.75 : 0.55, weight === 'light' ? 100 : 200);
  }

  // ── Graph plumbing ─────────────────────────────────────────────────────────

  private graph(): { ctx: AudioContext } | null {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext
          ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return null;
        this.ctx = new Ctor();

        this.master = this.ctx.createDynamicsCompressor();
        this.master.threshold.value = -16;
        this.master.ratio.value = 7;
        this.master.connect(this.ctx.destination);

        const bus = (level: number) => {
          const g = this.ctx!.createGain();
          g.gain.value = level;
          g.connect(this.master!);
          return g;
        };
        // The hierarchy, as mix levels: verb > impacts > score > ambience.
        this.verbBus = bus(1.0);
        this.impactBus = bus(0.9);
        this.musicBus = bus(0.75);
        this.ambienceBus = bus(0.4);

        this.music = new MusicLayers(this.ctx, this.musicBus);
      }
      return { ctx: this.ctx };
    } catch {
      return null;
    }
  }

  /** Low wind bed so the space never reads as dead silence. */
  private startAmbience() {
    const g = this.graph();
    if (!g || !this.ambienceBus) return;
    const len = 2 * g.ctx.sampleRate;
    const buf = g.ctx.createBuffer(1, len, g.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = g.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const lp = g.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 320;
    const gain = g.ctx.createGain();
    gain.gain.value = 0.12;
    const lfo = g.ctx.createOscillator();
    lfo.frequency.value = 0.11;
    const lfoGain = g.ctx.createGain();
    lfoGain.gain.value = 0.05;
    lfo.connect(lfoGain).connect(gain.gain);
    src.connect(lp).connect(gain).connect(this.ambienceBus);
    src.start();
    lfo.start();
  }

  /** Duck the score to `factor` and recover — big sounds get the room. */
  private duckMusic(factor: number, ms: number) {
    if (!this.musicBus || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.musicBus.gain.cancelScheduledValues(t);
    this.musicBus.gain.setTargetAtTime(0.75 * factor, t, 0.015);
    this.musicBus.gain.setTargetAtTime(0.75, t + ms / 1000, 0.12);
  }

  /** Build pan/gain/lowpass for a world position and hand a dest node to `fill`. */
  private spatialOneShot(pos: Pos, busNode: GainNode | null, fill: (dest: AudioNode) => void) {
    const g = this.graph();
    if (!g || !busNode) return;
    const s = spatialize(this.listener.x, this.listener.z, this.listener.yaw, pos.x, pos.z);
    if (s.gain <= 0.01) return;
    const lpf = g.ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = s.lowpass;
    const pan = g.ctx.createStereoPanner();
    pan.pan.value = s.pan;
    const gain = g.ctx.createGain();
    gain.gain.value = s.gain;
    lpf.connect(pan).connect(gain).connect(busNode);
    fill(lpf);
  }

  // ── Synth building blocks (dest-routed) ────────────────────────────────────

  private sine(f0: number, f1: number, dur: number, vol: number, dest: AudioNode | null) {
    const g = this.graph();
    if (!g || !dest) return;
    try {
      const now = g.ctx.currentTime;
      const osc = g.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f0, now);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), now + dur);
      const gain = g.ctx.createGain();
      gain.gain.setValueAtTime(vol, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + dur + 0.02);
      osc.connect(gain).connect(dest);
      osc.start(now);
      osc.stop(now + dur + 0.03);
    } catch {}
  }

  private noiseSweep(f0: number, f1: number, dur: number, vol: number, dest: AudioNode | null) {
    const g = this.graph();
    if (!g || !dest) return;
    try {
      const now = g.ctx.currentTime;
      const buf = g.ctx.createBuffer(1, Math.max(1, Math.floor(g.ctx.sampleRate * dur)), g.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      const src = g.ctx.createBufferSource();
      src.buffer = buf;
      const bp = g.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.2;
      bp.frequency.setValueAtTime(f0, now);
      bp.frequency.exponentialRampToValueAtTime(Math.max(40, f1), now + dur);
      const gain = g.ctx.createGain();
      gain.gain.setValueAtTime(vol, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + dur + 0.01);
      src.connect(bp).connect(gain).connect(dest);
      src.start(now);
      src.stop(now + dur + 0.02);
    } catch {}
  }

  /** Fixed-band noise snap — the material transient. */
  private noiseBand(freq: number, q: number, dur: number, vol: number, dest: AudioNode | null) {
    const g = this.graph();
    if (!g || !dest) return;
    try {
      const now = g.ctx.currentTime;
      const buf = g.ctx.createBuffer(1, Math.max(1, Math.floor(g.ctx.sampleRate * dur)), g.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      const src = g.ctx.createBufferSource();
      src.buffer = buf;
      const bp = g.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      bp.Q.value = q;
      const gain = g.ctx.createGain();
      gain.gain.setValueAtTime(vol, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + dur + 0.01);
      src.connect(bp).connect(gain).connect(dest);
      src.start(now);
      src.stop(now + dur + 0.02);
    } catch {}
  }

  private ring(freq: number, dur: number, vol: number, dest: AudioNode | null) {
    const g = this.graph();
    if (!g || !dest) return;
    try {
      const now = g.ctx.currentTime;
      const osc = g.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const gain = g.ctx.createGain();
      gain.gain.setValueAtTime(vol, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
      osc.connect(gain).connect(dest);
      osc.start(now);
      osc.stop(now + dur + 0.02);
    } catch {}
  }
}
