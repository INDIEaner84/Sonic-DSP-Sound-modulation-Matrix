/* Sample-Bank + Sample-Stimme auf Basis des eigenen SF2-Parsers.
 *
 * `SampleBank` hält eine geparste SF2-Datei und erzeugt AudioBuffers erst beim
 * ersten Gebrauch (lazy) — eine 30-MB-Bank soll den Start nicht blockieren.
 * `createSf2Voice` baut eine Stimme mit derselben Schnittstelle wie die Synth-,
 * Piano- und Drum-Stimmen (`kind`, `startAt`, `released`, `dead`, `release`,
 * `scheduleRelease`, `tick`, `dispose`) und hängt sie an `chain.input`, damit
 * Pan, Fader, Mute/Solo, Drive, Sends und Aufnahme automatisch mitspielen.
 *
 * Keine Assets im Repo: Die Datei kommt vom Nutzer (Datei-Dialog), die Lizenz
 * bleibt seine (siehe docs/LIZENZEN.md).
 */

import { parseSf2, sf2Presets, zonesForNote, readSf2Zone } from './sf2.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Zeitcents (SF2) in Sekunden; -32768 = „nicht gesetzt" → Rückfallwert. */
export function timecentsToSeconds(timecents, fallback = 0.01) {
  if (!Number.isFinite(timecents) || timecents <= -12000) return fallback;
  return clamp(Math.pow(2, timecents / 1200), 0.001, 8);
}

/** Halbton-Abstand einer Zone zu einer Note (inkl. Feinstimmung/Pitch-Korrektur). */
export function zoneSemitones(zone, note) {
  const fine = (zone.fineTune || 0) / 100 + (zone.pitchCorrection || 0) / 100;
  return note - zone.rootKey + (zone.coarseTune || 0) + fine;
}

export class SampleBank {
  /**
   * @param {object} parsed Ergebnis von `parseSf2(...).soundfont`
   * @param {object} ctx AudioContext (nur für `createBuffer`)
   */
  constructor(soundfont, ctx, { fileName = '' } = {}) {
    this.soundfont = soundfont;
    this.ctx = ctx;
    this.fileName = fileName;
    this.buffers = new Map(); // `${presetIndex}:${zoneIndex}` → AudioBuffer
    this.created = 0;
  }

  get info() {
    const presets = this.soundfont ? this.soundfont.presets.length : 0;
    const zones = this.soundfont
      ? this.soundfont.presets.reduce((sum, preset) => sum + preset.zones.length, 0)
      : 0;
    return {
      fileName: this.fileName,
      name: this.soundfont && this.soundfont.info ? this.soundfont.info.name : '',
      presets,
      zones,
      samples: this.soundfont ? this.soundfont.samples.length : 0,
      has24Bit: !!(this.soundfont && this.soundfont.has24Bit),
    };
  }

  get presets() {
    return sf2Presets(this.soundfont);
  }

  hasPreset(index) {
    return !!(this.soundfont && this.soundfont.presets[index]);
  }

  /** Preset über gespeicherte Referenz {name, program, bank} finden. */
  resolve(reference = {}) {
    if (!this.soundfont || !this.soundfont.presets.length) return null;
    const presets = this.soundfont.presets;
    if (reference.name) {
      const byName = presets.findIndex((p) => p.name === reference.name);
      if (byName >= 0) return { index: byName, preset: presets[byName] };
    }
    const program = Number.isFinite(reference.program) ? reference.program : 0;
    const bank = Number.isFinite(reference.bank) ? reference.bank : 0;
    const exact = presets.findIndex((p) => p.program === program && p.bank === bank);
    if (exact >= 0) return { index: exact, preset: presets[exact] };
    const byProgram = presets.findIndex((p) => p.program === program);
    return { index: byProgram >= 0 ? byProgram : 0, preset: presets[byProgram >= 0 ? byProgram : 0] };
  }

  bufferFor(presetIndex, zoneIndex) {
    const key = `${presetIndex}:${zoneIndex}`;
    const cached = this.buffers.get(key);
    if (cached) return cached;
    const preset = this.soundfont.presets[presetIndex];
    if (!preset) return null;
    const zone = preset.zones[zoneIndex];
    if (!zone) return null;
    const audio = readSf2Zone(this.soundfont, zone);
    if (!audio || !audio.pcm.length) return null;
    const buffer = this.ctx.createBuffer(1, audio.pcm.length, audio.sampleRate);
    const channel = buffer.getChannelData(0);
    channel.set(audio.pcm);
    const entry = {
      buffer,
      audio,
      zone,
      loop: !!audio.loop && audio.loopEnd > audio.loopStart + 8,
    };
    this.buffers.set(key, entry);
    this.created += 1;
    return entry;
  }

  /**
   * Stimmen-Spezifikation für eine Note.
   * @returns {{presetIndex:number, zoneIndex:number, zone:object, buffer:object, audio:object, loop:boolean}|null}
   */
  voiceFor(reference, note, velocity) {
    const found = this.resolve(reference);
    if (!found) return null;
    const matches = zonesForNote(found.preset, note, velocity);
    if (!matches.length) return null;
    /* Zonen sind nach Key-Bereich sortiert; die erste passende ist die spezifischste. */
    const zoneIndex = found.preset.zones.indexOf(matches[0]);
    const entry = this.bufferFor(found.index, zoneIndex);
    if (!entry) return null;
    return {
      presetIndex: found.index,
      presetName: found.preset.name,
      zoneIndex,
      zone: entry.zone,
      buffer: entry.buffer,
      audio: entry.audio,
      loop: entry.loop,
    };
  }

  /** Kurzinfo für das Status-Panel. */
  summary() {
    const info = this.info;
    return info.presets ? `${info.name || info.fileName || 'SF2'} · ${info.presets} Presets` : 'keine Bank';
  }
}

/**
 * Baut aus Datei-Bytes eine Bank.
 * @returns {{ok:boolean, bank:SampleBank|null, errors:string[], warnings:string[]}}
 */
export function createSampleBank(bytes, ctx, { fileName = '' } = {}) {
  if (!ctx || typeof ctx.createBuffer !== 'function') {
    return { ok: false, bank: null, errors: ['Sampler braucht einen laufenden AudioContext'], warnings: [] };
  }
  const parsed = parseSf2(bytes);
  if (!parsed.ok) return { ok: false, bank: null, errors: parsed.errors, warnings: parsed.warnings };
  const bank = new SampleBank(parsed.soundfont, ctx, { fileName });
  return { ok: true, bank, errors: [], warnings: parsed.warnings };
}

/* ---------------------------------------------------------------- Stimme */

export class SampleVoice {
  constructor(engine, chain, note, velocity, when, spec) {
    this.engine = engine;
    this.chain = chain;
    this.track = chain.track;
    this.kind = 'sf2';
    this.note = note;
    this.velocity = clamp(velocity, 0.05, 1);
    this.spec = spec;
    this.released = false;
    this.dead = false;
    this.triggered = true;
    this.releaseAt = Infinity;

    const ctx = engine.ctx;
    const t0 = Math.max(when != null ? when : ctx.currentTime, ctx.currentTime);
    this.startAt = t0;

    const { zone, buffer, audio, loop } = spec;
    this.pitchRatio = Math.pow(2, zoneSemitones(zone, note) / 12);
    this.looping = !!loop;

    this.src = ctx.createBufferSource();
    this.src.buffer = buffer;
    if (this.src.playbackRate) this.src.playbackRate.value = this.pitchRatio;
    if (this.looping) {
      this.src.loop = true;
      this.src.loopStart = clamp(audio.loopStart / audio.sampleRate, 0, buffer.duration);
      this.src.loopEnd = clamp(audio.loopEnd / audio.sampleRate, this.src.loopStart + 0.001, buffer.duration);
    }

    this.vca = ctx.createGain();
    this.vca.gain.value = 0;
    this.panner = ctx.createStereoPanner();
    this.panner.pan.value = clamp((zone.pan || 0) / 500, -1, 1);

    this.src.connect(this.vca);
    this.vca.connect(this.panner);
    this.panner.connect(chain.input);

    const attenuation = clamp(zone.attenuation || 0, 0, 1000); // 0,1 dB
    const gain = 10 ** (-attenuation / 200); // ≈ 10^(-dB/20)
    this.peak = clamp(this.velocity * gain, 0.0005, 1.4);
    this.attack = timecentsToSeconds(zone.attack, 0.004);
    this.releaseSeconds = timecentsToSeconds(zone.release, 0.25);

    const playSeconds = buffer.duration / this.pitchRatio;
    this.naturalEnd = t0 + playSeconds;
    this.endAt = this.looping ? Infinity : this.naturalEnd + 0.02;

    try {
      this.vca.gain.setValueAtTime(0.0001, t0);
      if (this.attack > 0.002) {
        this.vca.gain.linearRampToValueAtTime(this.peak, t0 + this.attack);
      } else {
        this.vca.gain.setValueAtTime(this.peak, t0);
      }
      this.src.start(t0);
    } catch (e) {
      this.dead = true;
    }
  }

  release(at) {
    if (this.released) return;
    this.released = true;
    const t = Math.max(at, this.startAt + 0.005);
    this.releaseAt = t;
    const end = t + this.releaseSeconds;
    try {
      this.vca.gain.cancelScheduledValues(t);
      this.vca.gain.setTargetAtTime(0.0001, t, Math.max(0.005, this.releaseSeconds / 3));
    } catch (e) {
      /* ignore */
    }
    this.endAt = Math.min(this.endAt, end + 0.05);
    if (this.looping) {
      try {
        this.src.stop(end + 0.03);
      } catch (e) {
        /* ignore */
      }
    }
  }

  scheduleRelease(at) {
    this.release(at);
  }

  tick(now) {
    if (this.released && now >= this.releaseAt) this.released = true;
    if (now >= this.endAt) {
      this.dead = true;
      this.released = true;
    }
  }

  dispose() {
    const ctx = this.engine.ctx;
    const t = ctx ? ctx.currentTime : 0;
    try {
      if (typeof this.src.stop === 'function') this.src.stop(t + 0.02);
    } catch (e) {
      /* ignore */
    }
    setTimeout(() => {
      for (const node of [this.src, this.vca, this.panner]) {
        try {
          node.disconnect();
        } catch (e) {
          /* ignore */
        }
      }
    }, 60);
  }
}

/**
 * Fabrik für die Engine-Registry. Liefert `null`, wenn keine Bank geladen ist
 * oder das Preset die Note nicht abdeckt — die Engine fällt dann auf das
 * Klavier zurück, statt stumm zu bleiben.
 */
export function createSf2Voice(engine, chain, note, velocity, when) {
  const bank = engine.sampleBank;
  if (!bank) return null;
  const spec = bank.voiceFor(chain.track.sample || {}, note, velocity);
  if (!spec) return null;
  return new SampleVoice(engine, chain, note, velocity, when, spec);
}
