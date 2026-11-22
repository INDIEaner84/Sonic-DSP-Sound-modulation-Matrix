/* Sonic DSP — Audio Engine (mehrspurig)
 * Pro Projektspur eine eigene Kette: voices → input → pan → gain → master.
 * Der Klang kommt aus dem Patch der jeweiligen Spur; LFOs sind projektweit
 * (eine gemeinsame Phase für alle Spuren, siehe E-03 in der Entscheidungsliste).
 *
 * Die Modulationsmatrix läuft auf Control-Rate (60 Hz) in JS und schreibt
 * geglättete Werte über setTargetAtTime in die AudioParams. Noten können mit
 * exakter Startzeit (`when`) geplant werden – das nutzt der Sequencer.
 */

import { SOURCES, DESTS, clamp } from './state.js';
import { trackAudible } from './project.js';

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
    this.panner.connect(chain.input);

    const t0 = this.startAt;
    this.osc1.frequency.setValueAtTime(midiToHz(note + s.osc1.octave * 12 + s.osc1.detune / 100), t0);
    this.osc2.frequency.setValueAtTime(midiToHz(note + s.osc2.octave * 12 + s.osc2.detune / 100), t0);
    this.filter.frequency.setValueAtTime(s.filter.cutoff, t0);
    this.filter.Q.setValueAtTime(s.filter.reso, t0);
    this.vca.gain.setValueAtTime(0, t0);
    this.g1.gain.setValueAtTime(0, t0);
    this.g2.gain.setValueAtTime(0, t0);

    this.osc1.start(t0);
    this.osc2.start(t0);
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

    this.vca.gain.setTargetAtTime(amp * (0.35 + 0.65 * this.velocity) * 0.9, now, 0.004);

    if (this.triggered && this.ampEnv.stage === 'idle' && amp <= 0.0005) this.dead = true;
  }

  dispose() {
    const ctx = this.engine.ctx;
    const t = ctx.currentTime;
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
      this.master.connect(this.comp);
      this.comp.connect(this.analyser);
      this.analyser.connect(ctx.destination);

      this.syncTracks();
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

  setProject(project) {
    this.project = project;
    if (this.ctx) this.syncTracks();
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
      input.connect(pan);
      pan.connect(gain);
      gain.connect(this.bus);
      this.chains.set(track.id, { track, input, pan, gain });
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
    }

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
      v.osc1.type = s.osc1.wave;
      v.osc2.type = s.osc2.wave;
      v.filter.type = s.filter.type;
    }
  }
}
