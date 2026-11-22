/* Sonic DSP — Audio Engine (mehrspurig)
 * Pro Projektspur eine eigene Kette: voices → input → pan → gain → master.
 * Der Klang kommt aus dem Patch der jeweiligen Spur; LFOs sind projektweit
 * (eine gemeinsame Phase für alle Spuren, siehe E-03 in der Entscheidungsliste).
 *
 * Die Modulationsmatrix läuft auf Control-Rate (60 Hz) in JS und schreibt
 * geglättete Werte über setTargetAtTime in die AudioParams. Noten können mit
 * exakter Startzeit (`when`) geplant werden – das nutzt der Sequencer.
 */

import { SOURCES, DESTS, clamp, mulberry32 } from './state.js';
import { trackAudible, delaySeconds, FX_DEFAULTS } from './project.js';

const TWO_PI = Math.PI * 2;
export const midiToHz = (n) => 440 * Math.pow(2, (n - 69) / 12);

/* ---------------------------------------------------------------- Hüllkurve */

/** ADSR auf Basis absoluter Audio-Zeit – nötig für geplante Noten. */
class ADSR {
  constructor(cfg) {
    this.set(cfg);
    this.value = 0;
    this.stage = 'idle';
    this.stageStart = 0;
    this.from = 0;
  }

  set(cfg) {
    this.a = Math.max(0.001, cfg.a);
    this.d = Math.max(0.001, cfg.d);
    this.s = clamp(cfg.s, 0, 1);
    this.r = Math.max(0.001, cfg.r);
  }

  trigger(at) {
    this.stage = 'attack';
    this.stageStart = at;
    this.from = this.value;
  }

  release(at) {
    if (this.stage === 'idle') return;
    this.from = this.value;
    this.stage = 'release';
    this.stageStart = at;
  }

  advance(now) {
    switch (this.stage) {
      case 'attack': {
        const k = clamp((now - this.stageStart) / this.a, 0, 1);
        this.value = this.from + (1 - this.from) * k;
        if (k >= 1) {
          this.stage = 'decay';
          this.stageStart += this.a;
        }
        break;
      }
      case 'decay': {
        const k = clamp((now - this.stageStart) / this.d, 0, 1);
        this.value = 1 - (1 - this.s) * k;
        if (k >= 1) {
          this.stage = 'sustain';
          this.value = this.s;
        }
        break;
      }
      case 'sustain':
        this.value = this.s;
        break;
      case 'release': {
        const k = clamp((now - this.stageStart) / this.r, 0, 1);
        this.value = this.from * (1 - k);
        if (k >= 1) {
          this.stage = 'idle';
          this.value = 0;
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

/* ---------------------------------------------------------------- Quellen */

/**
 * Erzeugt eine Tonquelle: normaler Oszillator oder – für `'noise'` – einen
 * geloopten Rausch-Buffer (Percussion/Hihat ohne Sample-Assets).
 * Rauschquellen haben kein `frequency`-AudioParam; Aufrufer prüfen das.
 */
function createSource(ctx, wave, engine) {
  if (wave === 'noise') {
    const src = ctx.createBufferSource();
    src.buffer = engine.noiseBuffer();
    src.loop = true;
    return src;
  }
  const osc = ctx.createOscillator();
  osc.type = wave;
  return osc;
}

/* ------------------------------------------------------------------- Voice */

class Voice {
  /**
   * @param {object} engine
   * @param {object} chain Spurkette {track, input, pan, gain}
   * @param {number} note
   * @param {number} velocity
   * @param {number|null} when
   */
  constructor(engine, chain, note, velocity, when) {
    this.engine = engine;
    this.chain = chain;
    this.track = chain.track;
    const ctx = engine.ctx;
    const s = this.track.patch;

    this.note = note;
    this.velocity = clamp(velocity, 0.05, 1);
    this.pitch = note;
    this.released = false;
    this.dead = false;
    this.triggered = false;
    this._releaseApplied = false;
    this.startAt = Math.max(when != null ? when : ctx.currentTime, ctx.currentTime);
    this.releaseAt = Infinity;

    this.ampEnv = new ADSR(s.ampEnv);
    this.modEnv = new ADSR(s.modEnv);

    this.src1 = createSource(ctx, s.osc1.wave, engine);
    this.src2 = createSource(ctx, s.osc2.wave, engine);

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

    this.src1.connect(this.g1);
    this.src2.connect(this.g2);
    this.g1.connect(this.filter);
    this.g2.connect(this.filter);
    this.filter.connect(this.vca);
    this.vca.connect(this.panner);
    this.panner.connect(chain.input);

    const t0 = this.startAt;
    if (this.src1.frequency) {
      this.src1.frequency.setValueAtTime(midiToHz(note + s.osc1.octave * 12 + s.osc1.detune / 100), t0);
    }
    if (this.src2.frequency) {
      this.src2.frequency.setValueAtTime(midiToHz(note + s.osc2.octave * 12 + s.osc2.detune / 100), t0);
    }
    this.filter.frequency.setValueAtTime(s.filter.cutoff, t0);
    this.filter.Q.setValueAtTime(s.filter.reso, t0);
    this.vca.gain.setValueAtTime(0, t0);
    this.g1.gain.setValueAtTime(0, t0);
    this.g2.gain.setValueAtTime(0, t0);

    this.src1.start(t0);
    this.src2.start(t0);
  }

  release(at) {
    if (this.released) return;
    this.released = true;
    this.releaseAt = Math.max(at, this.startAt);
    if (this.triggered) {
      this._releaseApplied = true;
      this.ampEnv.release(this.releaseAt);
      this.modEnv.release(this.releaseAt);
    }
  }

  scheduleRelease(at) {
    if (this.released) return;
    if (at < this.releaseAt) this.releaseAt = Math.max(at, this.startAt);
  }

  tick(now) {
    const s = this.track.patch;
    const project = this.engine.project;

    if (!this.triggered) {
      if (now + 0.0005 < this.startAt) return;
      this.triggered = true;
      this.ampEnv.trigger(this.startAt);
      this.modEnv.trigger(this.startAt);
    }
    if (this.released && !this._releaseApplied) {
      this._releaseApplied = true;
      this.ampEnv.release(this.releaseAt);
      this.modEnv.release(this.releaseAt);
    }
    if (!this.released && now >= this.releaseAt) {
      this.released = true;
      this._releaseApplied = true;
      this.ampEnv.release(this.releaseAt);
      this.modEnv.release(this.releaseAt);
    }

    const amp = this.ampEnv.advance(now);
    const modEnv = this.modEnv.advance(now);

    if (s.glide > 0.001) {
      const k = Math.min(1, 1 / 60 / s.glide);
      this.pitch += (this.note - this.pitch) * k;
    } else {
      this.pitch = this.note;
    }

    const src = {
      lfo1: this.engine.lfoVal.lfo1,
      lfo2: this.engine.lfoVal.lfo2,
      env2: modEnv,
      vel: this.velocity,
      mw: project ? project.modWheel : 0,
      key: clamp((this.note - 60) / 24, -1, 1),
    };

    const sums = { pitch1: 0, pitch2: 0, level1: 0, level2: 0, cutoff: 0, reso: 0, pan: 0, lfo1rate: 0 };
    for (const so of SOURCES) {
      const v = src[so.id];
      if (!v) continue;
      for (const de of DESTS) {
        const amount = s.matrix[`${so.id}:${de.id}`];
        if (amount) sums[de.id] += v * (amount / 100);
      }
    }
    this.engine.activity.set(this.track.id, { src, sums });

    const f1 = midiToHz(this.pitch + sums.pitch1 * 12 + s.osc1.octave * 12 + s.osc1.detune / 100);
    const f2 = midiToHz(this.pitch + sums.pitch2 * 12 + s.osc2.octave * 12 + s.osc2.detune / 100);
    if (this.src1.frequency) this.src1.frequency.setTargetAtTime(f1, now, 0.006);
    if (this.src2.frequency) this.src2.frequency.setTargetAtTime(f2, now, 0.006);

    const l1 = clamp(s.osc1.level * (1 + sums.level1), 0, 1.6) * 0.5;
    const l2 = clamp(s.osc2.level * (1 + sums.level2), 0, 1.6) * 0.5;
    this.g1.gain.setTargetAtTime(l1, now, 0.01);
    this.g2.gain.setTargetAtTime(l2, now, 0.01);

    const cutoff = clamp(s.filter.cutoff * Math.pow(2, sums.cutoff * 3), 30, 18000);
    this.filter.frequency.setTargetAtTime(cutoff, now, 0.012);
    this.filter.Q.setTargetAtTime(clamp(s.filter.reso + sums.reso * 12, 0.3, 26), now, 0.02);

    this.panner.pan.setTargetAtTime(clamp(sums.pan, -1, 1), now, 0.02);

    this.vca.gain.setTargetAtTime(amp * (0.35 + 0.65 * this.velocity) * 0.9, now, 0.004);

    if (this.triggered && this.ampEnv.stage === 'idle' && amp <= 0.0005) this.dead = true;
  }

  dispose() {
    const ctx = this.engine.ctx;
    const t = ctx.currentTime;
    try {
      this.src1.stop(t + 0.02);
      this.src2.stop(t + 0.02);
    } catch (e) {
      /* bereits gestoppt */
    }
    setTimeout(() => {
      [this.src1, this.src2, this.g1, this.g2, this.filter, this.vca, this.panner].forEach((n) => {
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
  constructor() {
    this.ctx = null;
    this.project = null;
    this.chains = new Map(); // trackId -> {track, input, pan, gain}
    this.voices = new Set();
    this.activity = new Map(); // trackId -> {src, sums}
    this.lfo1 = new LFO();
    this.lfo2 = new LFO();
    this.lfoVal = { lfo1: 0, lfo2: 0 };
    this.lfoRate = { lfo1: 0, lfo2: 0 };
    this.maxVoices = 24;
    this._last = 0;
    this._timer = null;
    this.onStateChange = null;
  }

  /**
   * Startet die Engine. `context` erlaubt Injektion (Tests, Offline-Rendering).
   */
  async init({ context = null } = {}) {
    if (!this.ctx) {
      let ctx = context;
      if (!ctx) {
        const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
        if (!AC) throw new Error('Web Audio API nicht verfügbar');
        ctx = new AC({ latencyHint: 'interactive' });
      }
      this.ctx = ctx;

      this.bus = ctx.createGain();
      this.bus.gain.value = 0.9;

      this.master = ctx.createGain();
      this.master.gain.value = this.project ? this.project.master : 0.72;

      this.metroGain = ctx.createGain();
      this.metroGain.gain.value = 0.5;

      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -14;
      this.comp.knee.value = 22;
      this.comp.ratio.value = 5;
      this.comp.attack.value = 0.004;
      this.comp.release.value = 0.18;

      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.6;

      this.bus.connect(this.master);
      this.metroGain.connect(this.master);
      this._initFx(ctx);
      this.master.connect(this.comp);
      this.comp.connect(this.analyser);
      this.analyser.connect(ctx.destination);

      this.syncTracks();
      this._applyFxSettings(ctx.currentTime);
      if (!this._timer) this._timer = setInterval(() => this.tick(), 15);
      if (this.onStateChange) this.onStateChange(this.ctx.state);
    }
    if (this.ctx.state !== 'running' && this.ctx.resume) {
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
    if (this.ctx && this.ctx.suspend) await this.ctx.suspend();
    if (this.onStateChange) this.onStateChange(this.ctx ? this.ctx.state : 'closed');
  }

  /**
   * Aux-Busse für die Sends: Delay (Rückkopplung + Tone) und Reverb
   * (prozedural erzeugte Impulsantwort, kein Sample-Asset).
   */
  _initFx(ctx) {
    this.delayIn = ctx.createGain();
    this.delay = ctx.createDelay(2);
    this.delayTone = ctx.createBiquadFilter();
    this.delayTone.type = 'lowpass';
    this.delayFb = ctx.createGain();
    this.delayOut = ctx.createGain();
    this.delayOut.gain.value = 0.5;

    this.delayIn.connect(this.delay);
    this.delay.connect(this.delayTone);
    this.delayTone.connect(this.delayOut);
    this.delayTone.connect(this.delayFb);
    this.delayFb.connect(this.delay);
    this.delayOut.connect(this.master);

    this.reverbIn = ctx.createGain();
    this.convolver = ctx.createConvolver();
    this.reverbTone = ctx.createBiquadFilter();
    this.reverbTone.type = 'lowpass';
    this.reverbOut = ctx.createGain();
    this.reverbOut.gain.value = 0.55;

    this.reverbIn.connect(this.convolver);
    this.convolver.connect(this.reverbTone);
    this.reverbTone.connect(this.reverbOut);
    this.reverbOut.connect(this.master);

    this._reverbSize = 0;
    this._noise = null;
  }

  /** Deterministischer Rausch-Buffer (2 s), einmal pro Kontext erzeugt. */
  noiseBuffer() {
    const ctx = this.ctx;
    if (this._noise && this._noise.sampleRate === ctx.sampleRate) return this._noise;
    const rate = ctx.sampleRate || 44100;
    const length = Math.floor(rate * 2);
    const buffer = ctx.createBuffer(1, length, rate);
    const data = buffer.getChannelData(0);
    const rnd = mulberry32(0x5eed5eed);
    for (let i = 0; i < length; i++) data[i] = rnd() * 2 - 1;
    this._noise = buffer;
    return buffer;
  }

  /**
   * Impulsantwort aus abklingendem Rauschen. Energie wird normalisiert, damit
   * die Reverb-Lautstärke unabhängig von der Größe vergleichbar bleibt.
   */
  _buildImpulse(seconds) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate || 44100;
    const length = Math.max(64, Math.floor(rate * seconds));
    const buffer = ctx.createBuffer(2, length, rate);
    const rnd = mulberry32(0x9e3779b9);
    const decay = 3.2;
    let energy = 0;
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const env = Math.exp(-decay * t) * (1 - t);
        const v = (rnd() * 2 - 1) * env;
        data[i] = v;
        energy += v * v;
      }
    }
    const rms = Math.sqrt(energy / (length * 2)) || 1;
    const scale = 0.16 / rms;
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) data[i] *= scale;
    }
    return buffer;
  }

  /** FX-Werte aus dem Projekt in die Busse schreiben (Delay-Zeit, Feedback, IR). */
  _applyFxSettings(now) {
    if (!this.ctx || !this.project || !this.delay) return;
    const fx = { ...FX_DEFAULTS, ...(this.project.fx || {}) };
    const time = delaySeconds({ bpm: this.project.bpm, fx });
    this.delay.delayTime.setTargetAtTime(clamp(time, 0.01, 1.9), now, 0.05);
    this.delayFb.gain.setTargetAtTime(clamp(fx.delayFeedback, 0, 0.85), now, 0.05);
    this.delayTone.frequency.setTargetAtTime(clamp(fx.delayTone, 300, 9000), now, 0.05);
    this.reverbTone.frequency.setTargetAtTime(1200 + (1 - clamp(fx.reverbDamp, 0, 1)) * 10800, now, 0.05);
    if (fx.reverbSize !== this._reverbSize) {
      this.convolver.buffer = this._buildImpulse(fx.reverbSize);
      this._reverbSize = fx.reverbSize;
    }
  }

  setProject(project) {
    this.project = project;
    if (this.ctx) {
      this.syncTracks();
      this._applyFxSettings(this.ctx.currentTime);
    }
  }

  /** Legt für neue Spuren Audioketten an und entfernt gelöschte. */
  syncTracks() {
    if (!this.ctx || !this.project) return;
    const ids = new Set(this.project.tracks.map((t) => t.id));
    for (const [id, chain] of [...this.chains]) {
      if (!ids.has(id)) {
        for (const v of this.voices) if (v.track.id === id) v.release(this.ctx.currentTime);
        try {
          chain.input.disconnect();
          chain.pan.disconnect();
          chain.gain.disconnect();
          chain.sendDelay.disconnect();
          chain.sendReverb.disconnect();
        } catch (e) {
          /* ignore */
        }
        this.chains.delete(id);
        this.activity.delete(id);
      }
    }
    for (const track of this.project.tracks) {
      if (this.chains.has(track.id)) continue;
      const input = this.ctx.createGain();
      const pan = this.ctx.createStereoPanner();
      const gain = this.ctx.createGain();
      gain.gain.value = trackAudible(track, this.project.tracks) ? track.gain : 0;

      /* Sends hinter dem Fader: Mute/Solo wirkt damit auch auf die Effekte. */
      const sendDelay = this.ctx.createGain();
      const sendReverb = this.ctx.createGain();
      sendDelay.gain.value = clamp((track.sends && track.sends.delay) || 0, 0, 1);
      sendReverb.gain.value = clamp((track.sends && track.sends.reverb) || 0, 0, 1);

      input.connect(pan);
      pan.connect(gain);
      gain.connect(this.bus);
      gain.connect(sendDelay);
      gain.connect(sendReverb);
      sendDelay.connect(this.delayIn);
      sendReverb.connect(this.reverbIn);

      this.chains.set(track.id, { track, input, pan, gain, sendDelay, sendReverb });
    }
  }

  tick() {
    const ctx = this.ctx;
    if (!ctx || !this.project) return;
    const now = ctx.currentTime;
    let dt = this._last ? now - this._last : 1 / 60;
    this._last = now;
    dt = clamp(dt, 0.001, 0.1);

    /* LFO-Rate kann über die Matrix moduliert werden: stärkster Wert zählt. */
    let rateMod = 0;
    for (const a of this.activity.values()) {
      if (Math.abs(a.sums.lfo1rate) > Math.abs(rateMod)) rateMod = a.sums.lfo1rate;
    }
    const leadTrack = this.project.tracks[0];
    const leadPatch = leadTrack ? leadTrack.patch : null;
    const rate1Base = leadPatch ? leadPatch.lfo1.rate : 2;
    const rate2Base = leadPatch ? leadPatch.lfo2.rate : 0.3;
    const rate1 = clamp(rate1Base * Math.pow(2, rateMod * 2), 0.02, 40);
    const rate2 = clamp(rate2Base, 0.02, 40);
    this.lfoVal.lfo1 = this.lfo1.advance(rate1, dt, leadPatch ? leadPatch.lfo1.shape : 'sine');
    this.lfoVal.lfo2 = this.lfo2.advance(rate2, dt, leadPatch ? leadPatch.lfo2.shape : 'tri');
    this.lfoRate.lfo1 = rate1;
    this.lfoRate.lfo2 = rate2;

    const dead = [];
    for (const v of this.voices) {
      v.tick(now);
      if (v.dead) dead.push(v);
    }
    for (const v of dead) {
      this.voices.delete(v);
      v.dispose();
    }
    if (!this.voices.size) this.activity.clear();

    /* Mute/Solo/Pegel – eine gemeinsame Regel für alle Spuren */
    for (const chain of this.chains.values()) {
      const audible = trackAudible(chain.track, this.project.tracks);
      chain.gain.gain.setTargetAtTime(audible ? clamp(chain.track.gain, 0, 1.5) : 0, now, 0.02);
      const sends = chain.track.sends || {};
      chain.sendDelay.gain.setTargetAtTime(clamp(sends.delay || 0, 0, 1), now, 0.03);
      chain.sendReverb.gain.setTargetAtTime(clamp(sends.reverb || 0, 0, 1), now, 0.03);
    }

    this._applyFxSettings(now);
    this.master.gain.setTargetAtTime(this.project.master, now, 0.03);
  }

  _steal(at) {
    const active = [...this.voices].filter((v) => !v.released && v.startAt <= at + 0.001);
    if (active.length < this.maxVoices) return;
    active
      .sort((a, b) => a.startAt - b.startAt)
      .slice(0, Math.max(1, active.length - this.maxVoices + 1))
      .forEach((v) => v.release(at));
  }

  /** Note starten – optional zu einem exakten Zeitpunkt. Gibt die Stimme zurück. */
  noteOn(trackId, note, velocity = 0.8, when = null) {
    if (!this.ctx) return null;
    const chain = this.chains.get(trackId);
    if (!chain) return null;
    const at = Math.max(when != null ? when : this.ctx.currentTime, this.ctx.currentTime);

    if (when == null) {
      for (const v of this.voices) {
        if (v.track.id === trackId && v.note === note && !v.released && v.startAt <= at + 0.001) v.release(at);
      }
    }
    this._steal(at);
    const voice = new Voice(this, chain, note, velocity, at);
    this.voices.add(voice);
    return voice;
  }

  noteOff(trackId, note, when = null) {
    if (!this.ctx) return;
    const at = Math.max(when != null ? when : this.ctx.currentTime, this.ctx.currentTime);
    for (const v of this.voices) {
      if (v.track.id === trackId && v.note === note && !v.released && v.startAt <= at + 0.001) v.release(at);
    }
  }

  scheduleRelease(voice, at) {
    if (voice) voice.scheduleRelease(at);
  }

  allNotesOff(trackId = null) {
    const at = this.ctx ? this.ctx.currentTime : 0;
    for (const v of this.voices) {
      if (!trackId || v.track.id === trackId) v.release(at);
    }
  }

  /** Metronom-Klick (kurz, synthetisch – kein Sample nötig). */
  click(when, accent = false) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = Math.max(when, ctx.currentTime);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(accent ? 1860 : 1240, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(accent ? 0.32 : 0.17, t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    osc.connect(gain);
    gain.connect(this.metroGain);
    osc.start(t);
    osc.stop(t + 0.06);
  }

  /** Waveform / Filtertyp live auf klingende Stimmen anwenden. */
  refreshVoices(trackId = null) {
    for (const v of this.voices) {
      if (trackId && v.track.id !== trackId) continue;
      const s = v.track.patch;
      if (v.src1.type) v.src1.type = s.osc1.wave;
      if (v.src2.type) v.src2.type = s.osc2.wave;
      v.filter.type = s.filter.type;
    }
  }
}
