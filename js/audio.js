/* Sonic DSP — Audio Engine
 * Polyphoner subtraktiver Synth (2 Oszillatoren, Filter, 2 Hüllkurven)
 * mit einer frei verschaltbaren Modulationsmatrix.
 *
 * Die Modulationsmatrix läuft auf Control-Rate (60 Hz) in JS und schreibt
 * geglättete Werte über setTargetAtTime in die AudioParams. Dadurch bleiben
 * alle 48 Matrix-Zellen frei verschaltbar, ohne dass pro Zelle Audio-Nodes
 * erzeugt werden müssen.
 */

import { SOURCES, DESTS, clamp } from './state.js';

const TWO_PI = Math.PI * 2;
export const midiToHz = (n) => 440 * Math.pow(2, (n - 69) / 12);

/* ---------------------------------------------------------------- Hüllkurve */

class ADSR {
  constructor(cfg) {
    this.set(cfg);
    this.value = 0;
    this.stage = 'idle';
    this.t = 0;
    this.start = 0;
    this.relStart = 0;
  }

  set(cfg) {
    this.a = Math.max(0.001, cfg.a);
    this.d = Math.max(0.001, cfg.d);
    this.s = clamp(cfg.s, 0, 1);
    this.r = Math.max(0.001, cfg.r);
  }

  trigger() {
    this.start = this.value;
    this.stage = 'attack';
    this.t = 0;
  }

  release() {
    if (this.stage === 'idle') return;
    this.relStart = this.value;
    this.stage = 'release';
    this.t = 0;
  }

  tick(dt) {
    switch (this.stage) {
      case 'attack': {
        this.t += dt;
        const k = clamp(this.t / this.a, 0, 1);
        this.value = this.start + (1 - this.start) * k;
        if (k >= 1) {
          this.stage = 'decay';
          this.t = 0;
        }
        break;
      }
      case 'decay': {
        this.t += dt;
        const k = clamp(this.t / this.d, 0, 1);
        this.value = 1 - (1 - this.s) * k;
        if (k >= 1) this.stage = 'sustain';
        break;
      }
      case 'sustain':
        this.value = this.s;
        break;
      case 'release': {
        this.t += dt;
        const k = clamp(this.t / this.r, 0, 1);
        this.value = this.relStart * (1 - k);
        if (k >= 1) {
          this.value = 0;
          this.stage = 'idle';
        }
        break;
      }
      default:
        this.value = 0;
    }
    return this.value;
  }
}

/* --------------------------------------------------------------------- LFO */

class LFO {
  constructor() {
    this.phase = Math.random();
    this.held = Math.random() * 2 - 1;
  }

  advance(rate, dt, shape) {
    const prev = this.phase;
    this.phase = (this.phase + rate * dt) % 1;
    if (this.phase < prev) this.held = Math.random() * 2 - 1;
    return this.value(shape);
  }

  value(shape) {
    const p = this.phase;
    switch (shape) {
      case 'sine':
        return Math.sin(p * TWO_PI);
      case 'tri':
        return 1 - 4 * Math.abs(((p + 0.25) % 1) - 0.5);
      case 'saw':
        return 2 * p - 1;
      case 'square':
        return p < 0.5 ? 1 : -1;
      case 'random':
        return this.held;
      default:
        return 0;
    }
  }
}

/* ------------------------------------------------------------------- Voice */

class Voice {
  constructor(engine, note, velocity) {
    this.engine = engine;
    const ctx = engine.ctx;
    const s = engine.state;
    const t = ctx.currentTime;

    this.note = note;
    this.velocity = clamp(velocity, 0.05, 1);
    this.pitch = note;
    this.released = false;
    this.dead = false;

    this.ampEnv = new ADSR(s.ampEnv);
    this.ampEnv.trigger();
    this.modEnv = new ADSR(s.modEnv);
    this.modEnv.trigger();

    this.osc1 = ctx.createOscillator();
    this.osc1.type = s.osc1.wave;
    this.osc2 = ctx.createOscillator();
    this.osc2.type = s.osc2.wave;

    this.g1 = ctx.createGain();
    this.g1.gain.value = 0;
    this.g2 = ctx.createGain();
    this.g2.gain.value = 0;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = s.filter.type;
    this.filter.frequency.value = s.filter.cutoff;
    this.filter.Q.value = s.filter.reso;

    this.vca = ctx.createGain();
    this.vca.gain.value = 0;

    this.panner = ctx.createStereoPanner();
    this.panner.pan.value = 0;

    this.osc1.connect(this.g1);
    this.osc2.connect(this.g2);
    this.g1.connect(this.filter);
    this.g2.connect(this.filter);
    this.filter.connect(this.vca);
    this.vca.connect(this.panner);
    this.panner.connect(engine.bus);

    const hz = midiToHz(note);
    this.osc1.frequency.setValueAtTime(hz, t);
    this.osc2.frequency.setValueAtTime(hz, t);

    this.osc1.start(t);
    this.osc2.start(t);
  }

  release() {
    if (this.released) return;
    this.released = true;
    this.ampEnv.release();
    this.modEnv.release();
  }

  tick(dt, now) {
    const s = this.engine.state;
    const amp = this.ampEnv.tick(dt);
    const modEnv = this.modEnv.tick(dt);

    /* Glide (Portamento) */
    if (s.glide > 0.001) {
      const k = Math.min(1, dt / s.glide);
      this.pitch += (this.note - this.pitch) * k;
    } else {
      this.pitch = this.note;
    }

    const src = {
      lfo1: this.engine.lfoVal.lfo1,
      lfo2: this.engine.lfoVal.lfo2,
      env2: modEnv,
      vel: this.velocity,
      mw: s.modWheel,
      key: clamp((this.note - 60) / 24, -1, 1),
    };
    this.engine.srcSnapshot = src;

    const sums = { pitch1: 0, pitch2: 0, level1: 0, level2: 0, cutoff: 0, reso: 0, pan: 0, lfo1rate: 0 };
    for (const so of SOURCES) {
      const v = src[so.id];
      if (!v) continue;
      for (const de of DESTS) {
        const amount = s.matrix[`${so.id}:${de.id}`];
        if (amount) sums[de.id] += v * (amount / 100);
      }
    }
    this.engine.lastSums = sums;

    const f1 = midiToHz(this.pitch + sums.pitch1 * 12 + s.osc1.octave * 12 + s.osc1.detune / 100);
    const f2 = midiToHz(this.pitch + sums.pitch2 * 12 + s.osc2.octave * 12 + s.osc2.detune / 100);
    this.osc1.frequency.setTargetAtTime(f1, now, 0.006);
    this.osc2.frequency.setTargetAtTime(f2, now, 0.006);

    const l1 = clamp(s.osc1.level * (1 + sums.level1), 0, 1.6) * 0.5;
    const l2 = clamp(s.osc2.level * (1 + sums.level2), 0, 1.6) * 0.5;
    this.g1.gain.setTargetAtTime(l1, now, 0.01);
    this.g2.gain.setTargetAtTime(l2, now, 0.01);

    const cutoff = clamp(s.filter.cutoff * Math.pow(2, sums.cutoff * 3), 30, 18000);
    this.filter.frequency.setTargetAtTime(cutoff, now, 0.012);
    this.filter.Q.setTargetAtTime(clamp(s.filter.reso + sums.reso * 12, 0.3, 26), now, 0.02);

    this.panner.pan.setTargetAtTime(clamp(sums.pan, -1, 1), now, 0.02);

    const vca = amp * (0.35 + 0.65 * this.velocity) * 0.9;
    this.vca.gain.setTargetAtTime(vca, now, 0.004);

    if (this.ampEnv.stage === 'idle' && amp <= 0.0005) this.dead = true;
  }

  dispose() {
    const t = this.engine.ctx.currentTime;
    try {
      this.osc1.stop(t + 0.02);
      this.osc2.stop(t + 0.02);
    } catch (e) {
      /* bereits gestoppt */
    }
    setTimeout(() => {
      [this.osc1, this.osc2, this.g1, this.g2, this.filter, this.vca, this.panner].forEach((n) => {
        try {
          n.disconnect();
        } catch (e) {
          /* ignore */
        }
      });
    }, 60);
  }
}

/* ------------------------------------------------------------------ Engine */

export class Engine {
  constructor(state) {
    this.state = state;
    this.ctx = null;
    this.voices = new Set();
    this.lfo1 = new LFO();
    this.lfo2 = new LFO();
    this.lfoVal = { lfo1: 0, lfo2: 0 };
    this.lfoRate = { lfo1: 0, lfo2: 0 };
    this.lastSums = null;
    this.srcSnapshot = { lfo1: 0, lfo2: 0, env2: 0, vel: 0, mw: 0, key: 0 };
    this.maxVoices = 8;
    this._last = 0;
    this._timer = null;
    this.onStateChange = null;
  }

  async init() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });

      this.bus = this.ctx.createGain();
      this.bus.gain.value = 0.9;

      this.master = this.ctx.createGain();
      this.master.gain.value = this.state.master;

      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -14;
      this.comp.knee.value = 22;
      this.comp.ratio.value = 5;
      this.comp.attack.value = 0.004;
      this.comp.release.value = 0.18;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.6;

      this.bus.connect(this.master);
      this.master.connect(this.comp);
      this.comp.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);

      if (!this._timer) this._timer = setInterval(() => this.tick(), 15);
      if (this.onStateChange) this.onStateChange(this.ctx.state);
    }
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch (e) {
        /* Nutzerinteraktion fehlt noch */
      }
    }
    if (this.onStateChange) this.onStateChange(this.ctx.state);
    return this.ctx;
  }

  async suspend() {
    if (this.ctx) await this.ctx.suspend();
    if (this.onStateChange) this.onStateChange(this.ctx ? this.ctx.state : 'closed');
  }

  tick() {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    let dt = this._last ? now - this._last : 1 / 60;
    this._last = now;
    dt = clamp(dt, 0.001, 0.1);

    const s = this.state;
    const rate1 = clamp(s.lfo1.rate * Math.pow(2, (this.lastSums ? this.lastSums.lfo1rate : 0) * 2), 0.02, 40);
    const rate2 = clamp(s.lfo2.rate, 0.02, 40);
    this.lfoVal.lfo1 = this.lfo1.advance(rate1, dt, s.lfo1.shape);
    this.lfoVal.lfo2 = this.lfo2.advance(rate2, dt, s.lfo2.shape);
    this.lfoRate.lfo1 = rate1;
    this.lfoRate.lfo2 = rate2;

    const dead = [];
    for (const v of this.voices) {
      v.tick(dt, now);
      if (v.dead) dead.push(v);
    }
    for (const v of dead) {
      this.voices.delete(v);
      v.dispose();
    }

    this.master.gain.setTargetAtTime(s.master, now, 0.03);
  }

  noteOn(note, velocity = 0.8) {
    if (!this.ctx) return;
    for (const v of this.voices) {
      if (v.note === note && !v.released) v.release();
    }
    if (this.voices.size >= this.maxVoices) {
      const oldest = this.voices.values().next().value;
      if (oldest) oldest.release();
    }
    const voice = new Voice(this, note, velocity);
    this.voices.add(voice);
  }

  noteOff(note) {
    for (const v of this.voices) {
      if (v.note === note && !v.released) v.release();
    }
  }

  allNotesOff() {
    for (const v of this.voices) v.release();
  }

  /** Waveform / Filtertyp live auf klingende Stimmen anwenden. */
  refreshVoices() {
    const s = this.state;
    for (const v of this.voices) {
      v.osc1.type = s.osc1.wave;
      v.osc2.type = s.osc2.wave;
      v.filter.type = s.filter.type;
    }
  }
}
