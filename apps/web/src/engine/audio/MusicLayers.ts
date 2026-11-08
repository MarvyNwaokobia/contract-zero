/**
 * Adaptive score: three synthesized stems over one leitmotif
 * (CLONE_PLAN.md slice 2, "Score").
 *
 * The system is the point; these synth stems are stand-ins with the same
 * shape real stems will have. When commissioned/Higgsfield audio lands, each
 * layer becomes a looped AudioBuffer and everything else here stays.
 *
 *   layer 0 · drone  — always on with the score: detuned D-minor bed
 *   layer 1 · pulse  — low heartbeat thump on the downbeats (engaged)
 *   layer 2 · motif  — THE THEME, a sparse plucked line (combat)
 *
 * Intensity (0..3) swells layers in slowly and drops them fast, so walking
 * away from a fight audibly relaxes. `gap()` hard-mutes the whole score for
 * a beat — the silence that makes the catch and the kill read.
 *
 * The Valor motif (D minor, deliberately singable in 8 notes):
 *   D4 · F4 · A4 · G4 ·· D4 · F4 · C5 · A4
 */

const BPM = 70;
const BEAT = 60 / BPM;          // 0.857s
const CYCLE = 16;               // beats per loop
const LOOKAHEAD = 0.4;          // s of scheduling horizon
const TICK_MS = 100;

// Beat → frequency (0 = rest). Two answering phrases of the motif.
const D4 = 293.66, F4 = 349.23, G4 = 392.0, A4 = 440.0, C5 = 523.25;
const MOTIF: number[] = [
  D4, 0, F4, 0, A4, G4, 0, 0,
  D4, 0, F4, 0, C5, A4, 0, 0,
];
const PULSE_BEATS = new Set([0, 4, 8, 12]);

// Per-layer target gains at each intensity level.
const LAYER_GAINS: Array<[number, number, number, number]> = [
  [0.16, 0.16, 0.16, 0.18], // drone
  [0, 0.5, 0.5, 0.6],       // pulse
  [0, 0, 0.42, 0.5],        // motif
];
const SWELL_TAU = 1.1;  // slow in
const RELAX_TAU = 0.35; // fast out

export class MusicLayers {
  private ctx: AudioContext;
  private out: GainNode;           // master music gain (gap() mutes this)
  private layers: GainNode[] = [];
  private intensity = 0;

  private droneNodes: AudioScheduledSourceNode[] = [];
  private motifDelay: DelayNode | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;
  private nextBeatTime = 0;
  private beat = 0;
  private running = false;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(destination);

    for (let i = 0; i < 3; i++) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.out);
      this.layers.push(g);
    }

    // Motif space: a single feedback delay makes the plucks feel like a place.
    this.motifDelay = ctx.createDelay(1);
    this.motifDelay.delayTime.value = BEAT * 0.75;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const wet = ctx.createGain();
    wet.gain.value = 0.3;
    this.motifDelay.connect(fb).connect(this.motifDelay);
    this.motifDelay.connect(wet).connect(this.layers[2]);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.startDrone();
    this.applyIntensity(true);
    this.nextBeatTime = this.ctx.currentTime + 0.1;
    this.beat = 0;
    this.timer = setInterval(() => this.schedule(), TICK_MS);
  }

  setIntensity(level: 0 | 1 | 2 | 3) {
    if (level === this.intensity) return;
    this.intensity = level;
    this.applyIntensity(false);
  }

  /** Hard score silence for `ms` — the room the big beats land in. */
  gap(ms: number) {
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(0.0001, t);
    this.out.gain.setTargetAtTime(1, t + ms / 1000, 0.08);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const n of this.droneNodes) { try { n.stop(); } catch {} }
    this.droneNodes = [];
    this.running = false;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private applyIntensity(immediate: boolean) {
    const t = this.ctx.currentTime;
    this.layers.forEach((layer, i) => {
      const target = LAYER_GAINS[i][this.intensity];
      const rising = target > layer.gain.value;
      if (immediate) layer.gain.setValueAtTime(target, t);
      else layer.gain.setTargetAtTime(target, t, rising ? SWELL_TAU : RELAX_TAU);
    });
  }

  /** Layer 0: two detuned saws + a fifth, breathing through a slow filter LFO. */
  private startDrone() {
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 380;
    filter.Q.value = 0.7;
    filter.connect(this.layers[0]);

    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 130;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();
    this.droneNodes.push(lfo);

    const voices: Array<[number, OscillatorType, number]> = [
      [73.42, 'sawtooth', 4],   // D2, slightly sharp
      [73.42, 'sawtooth', -6],  // D2, slightly flat
      [110.0, 'sine', 0],       // A2, the open fifth
    ];
    for (const [freq, type, detune] of voices) {
      const osc = this.ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const g = this.ctx.createGain();
      g.gain.value = type === 'sine' ? 0.5 : 0.33;
      osc.connect(g).connect(filter);
      osc.start();
      this.droneNodes.push(osc);
    }
  }

  private schedule() {
    if (!this.running) return;
    const horizon = this.ctx.currentTime + LOOKAHEAD;
    while (this.nextBeatTime < horizon) {
      const b = this.beat % CYCLE;
      if (PULSE_BEATS.has(b)) this.pulse(this.nextBeatTime);
      const note = MOTIF[b];
      if (note > 0) this.pluck(note, this.nextBeatTime);
      this.beat++;
      this.nextBeatTime += BEAT;
    }
  }

  /** Layer 1: the low heartbeat thump. */
  private pulse(t: number) {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(88, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.22);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    osc.connect(g).connect(this.layers[1]);
    osc.start(t);
    osc.stop(t + 0.32);
  }

  /** Layer 2: one plucked note of the theme (dry + into the shared delay). */
  private pluck(freq: number, t: number) {
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.55, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t + BEAT * 0.9);
    osc.connect(g);
    g.connect(this.layers[2]);
    if (this.motifDelay) g.connect(this.motifDelay);
    osc.start(t);
    osc.stop(t + BEAT);
  }
}
