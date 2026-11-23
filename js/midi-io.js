/* Sonic DSP — MIDI-Dateien (SMF)
 * Eigener, dependency-freier Encoder/Decoder für Standard-MIDI-Files.
 * Bewusste Entscheidung: keine Library, damit das Projekt ohne Build-Schritt,
 * ohne node_modules und ohne Netzwerkzugriff lauffähig bleibt (siehe
 * docs/PROBLEME-UND-ENTSCHEIDUNGEN.md, E-02).
 *
 * Encoder: Format 1, PPQ 480 (oder Projekt-PPQ), Tempo-Meta, Spurnamen.
 * Decoder: Format 0/1, Running Status, Meta-Events, Sysex wird übersprungen.
 */

import { createProject, createTrack, clipOf, playOrder, PPQ, BEATS_PER_BAR } from './project.js';
import { buildPatch } from './state.js';
import { PRESETS } from './state.js';

export const MIDI_PPQ = PPQ;
const MAX_NOTES = 20000;

/* --------------------------------------------------------------- Byte-Helfer */

const hasTextEncoder = typeof TextEncoder !== 'undefined';
const encoder = hasTextEncoder ? new TextEncoder() : null;
const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: false }) : null;

function textBytes(str) {
  const s = String(str == null ? '' : str);
  if (encoder) return Array.from(encoder.encode(s));
  return Array.from(s, (c) => c.charCodeAt(0) & 0x7f);
}

function decodeText(bytes) {
  if (decoder) return decoder.decode(bytes);
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

class Writer {
  constructor() {
    this.bytes = [];
  }
  u8(v) {
    this.bytes.push(v & 0xff);
  }
  u16(v) {
    this.u8(v >> 8);
    this.u8(v);
  }
  u32(v) {
    this.u8(v >>> 24);
    this.u8(v >>> 16);
    this.u8(v >>> 8);
    this.u8(v);
  }
  vlq(value) {
    let v = Math.max(0, Math.round(value));
    const stack = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    for (const b of stack) this.u8(b);
  }
  text(str) {
    for (const b of textBytes(str)) this.u8(b);
  }
  append(arr) {
    for (const b of arr) this.u8(b);
  }
}

class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.pos = 0;
  }
  get eof() {
    return this.pos >= this.b.length;
  }
  get remaining() {
    return this.b.length - this.pos;
  }
  u8() {
    if (this.eof) throw new Error('Unerwartetes Dateiende');
    return this.b[this.pos++];
  }
  u16() {
    return (this.u8() << 8) | this.u8();
  }
  u32() {
    return this.u8() * 0x1000000 + ((this.u8() << 16) | (this.u8() << 8) | this.u8());
  }
  vlq() {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const byte = this.u8();
      v = v * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) return v;
    }
    throw new Error('Variable-Length-Wert zu lang');
  }
  take(n) {
    if (n < 0 || this.pos + n > this.b.length) throw new Error('Unerwartetes Dateiende');
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  tag() {
    const bytes = this.take(4);
    return String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  }
}

/* ------------------------------------------------------------------- Encoder */

function metaEvent(type, data) {
  const w = new Writer();
  w.u8(0xff);
  w.u8(type);
  w.vlq(data.length);
  w.append(data);
  return w.bytes;
}

/**
 * @param {object} project Laufzeit-Projekt
 * @param {{repeats?: number}} options 1–16 Loop-Wiederholungen
 * @returns {Uint8Array}
 */
export function encodeProject(project, { repeats = 1, sequence = null } = {}) {
  const loopTicks = project.bars * BEATS_PER_BAR * MIDI_PPQ;
  const rep = Math.min(16, Math.max(1, Math.round(repeats) || 1));
  /* Song-Modus: jeder Schritt der Kette ist ein Loop mit eigenem Clip. */
  const steps = Array.isArray(sequence) && sequence.length ? sequence : null;

  const chunks = [];

  /* Spur 0: Tempo, Takt, Projektname */
  {
    const w = new Writer();
    w.vlq(0);
    w.append(metaEvent(0x03, textBytes(project.name || 'Sonic DSP')));
    const usPerQuarter = Math.round(60000000 / Math.min(240, Math.max(40, project.bpm || 120)));
    w.vlq(0);
    w.append(metaEvent(0x51, [(usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff]));
    w.vlq(0);
    w.append(metaEvent(0x58, [4, 2, 24, 8])); // 4/4, 24 Clocks, 8 Noten
    w.vlq(0);
    w.append(metaEvent(0x2f, []));
    chunks.push({ name: 'Conductor', bytes: w.bytes });
  }

  project.tracks.forEach((track, ti) => {
    const channel = ti % 16;
    const items = [];
    if (steps) {
      steps.forEach((sceneId, step) => {
        const clip = clipOf(project, track, sceneId);
        const base = step * loopTicks;
        for (const ev of clip ? clip.events : []) {
          const on = base + ev.tick;
          const off = Math.min(base + ev.tick + ev.dur, base + loopTicks);
          items.push({ tick: on, kind: 0, note: ev.note, vel: Math.max(1, Math.round(ev.vel * 127)), channel });
          items.push({ tick: Math.max(on + 1, off), kind: 1, note: ev.note, vel: 64, channel });
        }
      });
    } else {
      const events = (project.scenes ? clipOf(project, track, project.activeSceneId) : null)?.events || [];
      for (const ev of events) {
        for (let r = 0; r < rep; r++) {
          const base = r * loopTicks;
          const on = base + ev.tick;
          const off = Math.min(base + ev.tick + ev.dur, base + loopTicks);
          items.push({ tick: on, kind: 0, note: ev.note, vel: Math.max(1, Math.round(ev.vel * 127)), channel });
          items.push({ tick: Math.max(on + 1, off), kind: 1, note: ev.note, vel: 64, channel });
        }
      }
    }

    /* Bei gleichem Tick erst Note-Off, damit keine hängenden Noten entstehen */
    items.sort((a, b) => a.tick - b.tick || b.kind - a.kind || a.note - b.note);

    const w = new Writer();
    w.vlq(0);
    w.append(metaEvent(0x03, textBytes(track.name || `Track ${ti + 1}`)));
    let last = 0;
    for (const it of items) {
      w.vlq(it.tick - last);
      last = it.tick;
      if (it.kind === 0) {
        w.u8(0x90 | it.channel);
        w.u8(it.note);
        w.u8(it.vel);
      } else {
        w.u8(0x80 | it.channel);
        w.u8(it.note);
        w.u8(it.vel);
      }
    }
    w.vlq(0);
    w.append(metaEvent(0x2f, []));
    chunks.push({ name: track.name, bytes: w.bytes });
  });

  const out = new Writer();
  out.append(textBytes('MThd'));
  out.u32(6);
  out.u16(1); // Format 1
  out.u16(chunks.length);
  out.u16(MIDI_PPQ);
  out.append(textBytes('MTrk'));
  out.u32(chunks[0].bytes.length);
  out.append(chunks[0].bytes);
  for (let i = 1; i < chunks.length; i++) {
    out.append(textBytes('MTrk'));
    out.u32(chunks[i].bytes.length);
    out.append(chunks[i].bytes);
  }
  return new Uint8Array(out.bytes);
}

/* ------------------------------------------------------------------- Decoder */

function parseTrack(bytes, errors) {
  const r = new Reader(bytes);
  const notes = [];
  const open = new Map();
  let name = '';
  let running = 0;
  let tick = 0;
  let tempo = null;
  let lastTick = 0;

  const keyOf = (ch, note) => `${ch}:${note}`;

  while (!r.eof) {
    const delta = r.vlq();
    tick += delta;
    lastTick = tick;

    let status = r.b[r.pos];
    if (status === undefined) throw new Error('Event ohne Status-Byte');
    if (status & 0x80) {
      r.pos += 1;
      if (status < 0xf0) running = status;
    } else if (running) {
      status = running;
    } else {
      throw new Error('Running Status ohne vorherigen Status');
    }

    if (status === 0xff) {
      const type = r.u8();
      const len = r.vlq();
      const data = r.take(len);
      if (type === 0x03) name = decodeText(data);
      else if (type === 0x51 && len >= 3) tempo = (data[0] << 16) | (data[1] << 8) | data[2];
      else if (type === 0x2f) break;
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const len = r.vlq();
      r.take(len);
      continue;
    }

    const kind = status & 0xf0;
    const ch = status & 0x0f;

    if (kind === 0x90) {
      const note = r.u8();
      const vel = r.u8();
      if (vel > 0) {
        const key = keyOf(ch, note);
        const list = open.get(key) || [];
        list.push({ tick, vel });
        open.set(key, list);
      } else {
        closeNote(ch, note, 64);
      }
    } else if (kind === 0x80) {
      const note = r.u8();
      r.u8();
      closeNote(ch, note, 64);
    } else if (kind === 0xc0 || kind === 0xd0) {
      r.u8();
    } else {
      r.u8();
      r.u8();
    }
  }

  function closeNote(ch, note) {
    const key = keyOf(ch, note);
    const list = open.get(key);
    if (!list || !list.length) {
      errors.push(`Note-Off ohne Note-On (Kanal ${ch + 1}, Note ${note})`);
      return;
    }
    const start = list.shift();
    if (!list.length) open.delete(key);
    notes.push({
      tick: start.tick,
      dur: Math.max(1, tick - start.tick),
      note,
      vel: Math.round((start.vel / 127) * 1000) / 1000,
      channel: ch,
    });
  }

  /* Offene Noten am Track-Ende schließen */
  for (const [key, list] of open) {
    const [ch, note] = key.split(':').map(Number);
    for (const start of list) {
      notes.push({
        tick: start.tick,
        dur: Math.max(1, lastTick - start.tick),
        note,
        vel: Math.round((start.vel / 127) * 1000) / 1000,
        channel: ch,
      });
    }
  }

  notes.sort((a, b) => a.tick - b.tick || a.note - b.note);
  return { name, notes, tempo };
}

/**
 * Liest eine MIDI-Datei.
 * @returns {{ok:boolean, ppq?:number, bpm?:number, tracks?:Array, errors:string[], warnings:string[]}}
 */
export function decodeMidi(bytes) {
  const errors = [];
  const warnings = [];
  try {
    if (!bytes || bytes.length < 14) throw new Error('Datei zu kurz für eine MIDI-Datei');
    const r = new Reader(bytes);

    if (r.tag() !== 'MThd') throw new Error('Kein MIDI-Header (MThd) gefunden');
    const headerLen = r.u32();
    if (headerLen < 6) throw new Error('MIDI-Header zu kurz');
    const format = r.u16();
    const ntrks = r.u16();
    const division = r.u16();
    if (r.pos < 8 + headerLen) r.take(8 + headerLen - r.pos);
    if (division & 0x8000) throw new Error('SMPTE-Zeitbasis wird nicht unterstützt');
    if (format > 1) throw new Error(`MIDI-Format ${format} wird nicht unterstützt (nur 0 und 1)`);
    if (ntrks < 1 || ntrks > 64) throw new Error(`Ungültige Spurenzahl (${ntrks})`);

    const tracks = [];
    let bpm = 120;
    let tempoSeen = false;

    for (let i = 0; i < ntrks; i++) {
      if (r.remaining < 8) throw new Error(`Spur ${i + 1}: Chunk fehlt`);
      const tag = r.tag();
      if (tag !== 'MTrk') throw new Error(`Spur ${i + 1}: Chunk "${tag}" ist kein MTrk`);
      const len = r.u32();
      if (len < 0 || r.pos + len > r.b.length) throw new Error(`Spur ${i + 1}: Chunk-Länge überschreitet die Datei`);
      const chunk = r.take(len);
      let parsed;
      try {
        parsed = parseTrack(chunk, errors);
      } catch (err) {
        throw new Error(`Spur ${i + 1}: ${err.message}`);
      }
      if (parsed.tempo && !tempoSeen) {
        bpm = Math.round(60000000 / parsed.tempo);
        tempoSeen = true;
      }
      if (parsed.notes.length) {
        tracks.push({ name: parsed.name || `Track ${tracks.length + 1}`, notes: parsed.notes });
      }
    }

    const totalNotes = tracks.reduce((n, t) => n + t.notes.length, 0);
    if (totalNotes > MAX_NOTES) throw new Error(`Zu viele Noten (${totalNotes}, max. ${MAX_NOTES})`);
    if (!tracks.length) throw new Error('MIDI-Datei enthält keine Noten');

    return { ok: true, ppq: division, bpm, tracks, errors, warnings };
  } catch (err) {
    return { ok: false, errors: [...errors, err.message], warnings };
  }
}

/**
 * Baut aus MIDI-Bytes ein lauffähiges Projekt (Spuren mit Patches).
 * @param {Uint8Array} bytes
 * @param {{name?: string, patches?: Array<object>}} options Patches werden reihum verteilt
 */
export function decodeToProject(bytes, { name = 'MIDI-Import', patches = [] } = {}) {
  const parsed = decodeMidi(bytes);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: parsed.warnings };

  const scale = MIDI_PPQ / parsed.ppq;
  const limit = 8; // LIMITS.maxTracks
  const srcTracks = parsed.tracks.slice(0, limit);
  const warnings = [...parsed.warnings];
  if (parsed.tracks.length > limit) {
    warnings.push(`Nur die ersten ${limit} von ${parsed.tracks.length} MIDI-Spuren importiert`);
  }

  let maxTick = 0;
  for (const t of srcTracks) {
    for (const n of t.notes) maxTick = Math.max(maxTick, Math.round(n.tick * scale) + Math.round(n.dur * scale));
  }
  const bars = Math.min(16, Math.max(1, Math.ceil(maxTick / (BEATS_PER_BAR * MIDI_PPQ))));
  const loopTicks = bars * BEATS_PER_BAR * MIDI_PPQ;
  if (maxTick > loopTicks) warnings.push('Noten jenseits 16 Takten wurden gekürzt');

  const built = srcTracks.map((t, i) => {
    const track = createTrack({
      name: (t.name || `MIDI ${i + 1}`).slice(0, 24),
      patch: patches.length ? patches[i % patches.length] : buildPatch({}),
    });
    const events = [];
    for (const n of t.notes) {
      const tick = Math.min(loopTicks - 1, Math.max(0, Math.round(n.tick * scale)));
      const dur = Math.max(1, Math.min(loopTicks - tick, Math.round(n.dur * scale) || 1));
      events.push({ tick, dur, note: n.note, vel: Math.max(0, Math.min(1, n.vel)) });
    }
    return { track, events };
  });

  const project = createProject({
    name: String(name).slice(0, 40),
    bpm: parsed.bpm,
    bars,
    tracks: built.map((entry) => entry.track),
    activeTrackId: built[0].track.id,
  });
  built.forEach((entry, i) => {
    const clip = clipOf(project, project.tracks[i], project.activeSceneId);
    if (clip && entry.events.length) clip.addEvents(entry.events);
  });
  return { ok: true, project, errors: [], warnings };
}

/** Praktische Vorgabe: Presets der Reihe nach als Import-Klänge. */
export function defaultImportPatches() {
  return PRESETS.map((p) => buildPatch(p.patch));
}
