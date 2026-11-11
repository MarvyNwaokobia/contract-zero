// A recording stand-in for the WebAudio graph, enough to build FpsAudio's buses and play its
// sounds in a headless test and ask: which bus did this sound reach, how far did a duck dip,
// how many nodes did it cost. It makes no sound and measures nothing about loudness.

export class FakeParam {
  value = 0
  history: number[] = []
  private set(v: number) { this.value = v; this.history.push(v) }
  cancelScheduledValues() { return this }
  setValueAtTime(v: number) { this.set(v); return this }
  linearRampToValueAtTime(v: number) { this.set(v); return this }
  exponentialRampToValueAtTime(v: number) { this.set(v); return this }
  setTargetAtTime(v: number) { this.set(v); return this }
  get min() { return Math.min(...this.history, this.value) }
}

const PARAMS = new Set(['gain', 'frequency', 'Q', 'detune', 'pan', 'delayTime', 'threshold', 'ratio', 'attack', 'release', 'knee', 'playbackRate'])

export class FakeNode {
  /** How many nodes have been connected INTO this one. */
  inputs = 0
  kind: string
  constructor(kind: string) {
    this.kind = kind
    return new Proxy(this, {
      get: (t, p) => {
        if (p in t) return (t as unknown as Record<string | symbol, unknown>)[p]
        if (typeof p === 'string' && PARAMS.has(p)) { const prm = new FakeParam(); (t as unknown as Record<string, unknown>)[p] = prm; return prm }
        return undefined
      },
    })
  }
  connect(dest: FakeNode) { if (dest) dest.inputs++; return dest }
  disconnect() {}
  start() {}
  stop() {}
  getFloatTimeDomainData(a: Float32Array) { a.fill(0) }
}

export class FakeAudioContext {
  static created = 0
  currentTime = 0
  sampleRate = 48000
  state = 'running'
  destination = new FakeNode('destination')
  resumeCalls = 0
  suspendCalls = 0
  nodesByKind: Record<string, number> = {}
  constructor() { FakeAudioContext.created++ }
  private make(kind: string) { this.nodesByKind[kind] = (this.nodesByKind[kind] ?? 0) + 1; return new FakeNode(kind) }
  createGain() { return this.make('gain') }
  createDynamicsCompressor() { return this.make('compressor') }
  createBiquadFilter() { return this.make('filter') }
  createStereoPanner() { return this.make('panner') }
  createBufferSource() { return this.make('source') }
  createOscillator() { return this.make('osc') }
  createDelay() { return this.make('delay') }
  createAnalyser() { return this.make('analyser') }
  createBuffer(_c: number, n: number) { return { getChannelData: () => new Float32Array(n), length: n } }
  decodeAudioData() { return Promise.reject(new Error('no decode in tests')) }
  resume() { this.resumeCalls++; this.state = 'running'; return Promise.resolve() }
  suspend() { this.suspendCalls++; this.state = 'suspended'; return Promise.resolve() }
  close() { return Promise.resolve() }
}
