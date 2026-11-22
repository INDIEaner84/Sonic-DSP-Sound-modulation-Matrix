/* Fake-Web-Audio für Node-Tests: bildet nur die von der Engine genutzten APIs
 * nach und protokolliert die erzeugten Knoten. Kein Audio, keine DOM-Abhängigkeit.
 */

export class Param {
  constructor(value = 0) {
    this.value = value;
    this.writes = 0;
  }
  setValueAtTime(v) {
    this.value = v;
    this.writes += 1;
    return this;
  }
  setTargetAtTime(v) {
    this.value = v;
    this.writes += 1;
    return this;
  }
  linearRampToValueAtTime(v) {
    this.value = v;
    this.writes += 1;
    return this;
  }
  exponentialRampToValueAtTime(v) {
    this.value = v;
    this.writes += 1;
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}

class BaseNode {
  constructor(ctx) {
    this.ctx = ctx;
    this.connections = [];
    this.disconnected = false;
  }
  connect(node) {
    this.connections.push(node);
    return node;
  }
  disconnect() {
    this.disconnected = true;
    this.connections = [];
  }
}

export class FakeOscillator extends BaseNode {
  constructor(ctx) {
    super(ctx);
    this.frequency = new Param(440);
    this.detune = new Param(0);
    this.type = 'sine';
    this.startedAt = null;
    this.stoppedAt = null;
  }
  start(t = 0) {
    this.startedAt = t;
  }
  stop(t = 0) {
    this.stoppedAt = t;
  }
}

export class FakeGain extends BaseNode {
  constructor(ctx) {
    super(ctx);
    this.gain = new Param(1);
  }
}

export class FakeBiquad extends BaseNode {
  constructor(ctx) {
    super(ctx);
    this.frequency = new Param(350);
    this.Q = new Param(1);
    this.type = 'lowpass';
  }
}

export class FakePanner extends BaseNode {
  constructor(ctx) {
    super(ctx);
    this.pan = new Param(0);
  }
}

export class FakeCompressor extends BaseNode {
  constructor(ctx) {
    super(ctx);
    this.threshold = new Param(-24);
    this.knee = new Param(30);
    this.ratio = new Param(12);
    this.attack = new Param(0.003);
    this.release = new Param(0.25);
  }
}

export class FakeAnalyser extends BaseNode {
  constructor(ctx) {
    super(ctx);
    this.fftSize = 2048;
    this.smoothingTimeConstant = 0.8;
    this.data = new Float32Array(2048);
  }
  getFloatTimeDomainData(array) {
    for (let i = 0; i < array.length; i++) array[i] = this.data[i % this.data.length] || 0;
  }
}

export class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.sampleRate = 48000;
    this.destination = new BaseNode(this);
    this.created = { oscillators: [], gains: [], filters: [], panners: [], analysers: 0 };
  }
  createGain() {
    const g = new FakeGain(this);
    this.created.gains.push(g);
    return g;
  }
  createOscillator() {
    const o = new FakeOscillator(this);
    this.created.oscillators.push(o);
    return o;
  }
  createBiquadFilter() {
    const f = new FakeBiquad(this);
    this.created.filters.push(f);
    return f;
  }
  createStereoPanner() {
    const p = new FakePanner(this);
    this.created.panners.push(p);
    return p;
  }
  createDynamicsCompressor() {
    return new FakeCompressor(this);
  }
  createAnalyser() {
    this.created.analysers += 1;
    return new FakeAnalyser(this);
  }
  async resume() {
    this.state = 'running';
  }
  async suspend() {
    this.state = 'suspended';
  }
  advance(seconds) {
    this.currentTime += seconds;
  }
}

/** Engine-Timer stoppen, damit Tests deterministisch bleiben. */
export function stopTimer(engine) {
  if (engine._timer) {
    clearInterval(engine._timer);
    engine._timer = null;
  }
}

/** Flache Storage-Attrappe für Persistenztests. */
export function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
    _data: data,
  };
}
