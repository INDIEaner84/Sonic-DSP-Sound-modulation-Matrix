/* Sonic DSP — Projektmodell
 * Ein Projekt enthält Spuren (jede mit eigenem Patch und eigenem Loop-Clip),
 * Tempo, Loop-Länge und Performance-Werte. Diese Datei ist die einzige
 * Wahrheitsquelle für Schema, Grenzen, Validierung und Persistenz.
 */

import { Clip } from './clip.js';
import { buildPatch, getIn, PATCH_RANGES, PATCH_ENUMS, SOURCES, DESTS, DEFAULT_PATCH } from './state.js';

export const PROJECT_VERSION = 1;
export const STORAGE_KEY = 'sonicdsp.project.v1';
export const PPQ = 480;
export const BEATS_PER_BAR = 4;

export const LIMITS = {
  maxTracks: 8,
  maxEventsPerTrack: 5000,
  maxTakesPerTrack: 40,
  maxFileBytes: 1_000_000,
  minBars: 1,
  maxBars: 16,
  minBpm: 40,
  maxBpm: 240,
  maxProjectName: 40,
  maxTrackName: 24,
  maxGain: 1.5,
};

export const QUANTIZE_STEPS = [0, 60, 120, 240]; // OFF, 1/32, 1/16, 1/8 (PPQ 480)

const SOURCE_IDS = new Set(SOURCES.map((s) => s.id));
const DEST_IDS = new Set(DESTS.map((d) => d.id));
const TOP_LEVEL_PATCH_KEYS = new Set([
  'glide',
  'osc1',
  'osc2',
  'filter',
  'ampEnv',
  'modEnv',
  'lfo1',
  'lfo2',
  'matrix',
]);

let idSeq = 0;
function newId(prefix) {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}${idSeq.toString(36)}`;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => isNum(v) && Number.isInteger(v);

/* ------------------------------------------------------------------ Fabriken */

export function createTrack({ name, patch, id, gain = 0.8, patchName = 'Init' } = {}) {
  return {
    id: id || newId('trk'),
    name: name || 'Track',
    patchName,
    patch: buildPatch(patch),
    mute: false,
    solo: false,
    gain,
    clip: new Clip(),
  };
}

export function createProject(overrides = {}) {
  const track = overrides.tracks && overrides.tracks.length ? overrides.tracks[0] : createTrack({ name: 'Track 1' });
  const tracks = overrides.tracks && overrides.tracks.length ? overrides.tracks : [track];
  return {
    version: PROJECT_VERSION,
    name: overrides.name || 'Neues Projekt',
    bpm: overrides.bpm || 120,
    bars: overrides.bars || 4,
    quantizeStep: overrides.quantizeStep != null ? overrides.quantizeStep : 120,
    swing: overrides.swing || 0,
    metronome: overrides.metronome !== false,
    master: overrides.master != null ? overrides.master : 0.72,
    modWheel: overrides.modWheel || 0,
    activeTrackId: overrides.activeTrackId || tracks[0].id,
    tracks,
  };
}

/** Gemeinsame Mute/Solo-Regel für Clock und Engine. */
export function trackAudible(track, tracks) {
  if (track.mute) return false;
  const anySolo = tracks.some((t) => t.solo);
  return !anySolo || track.solo;
}

export function loopTicksOf(project) {
  return project.bars * BEATS_PER_BAR * PPQ;
}

export function activeTrackOf(project) {
  return project.tracks.find((t) => t.id === project.activeTrackId) || project.tracks[0] || null;
}

/* ---------------------------------------------------------------- Validierung */

function validatePatch(raw, path, errors, warnings) {
  const patch = buildPatch();
  if (raw === undefined) return patch;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${path}: Objekt erwartet`);
    return null;
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_PATCH_KEYS.has(key)) {
      warnings.push(`${path}.${key}: unbekanntes Feld ignoriert`);
      continue;
    }
    const known = DEFAULT_PATCH[key];
    if (known && typeof known === 'object' && !Array.isArray(known) && raw[key] && typeof raw[key] === 'object') {
      for (const sub of Object.keys(raw[key])) {
        if (!(sub in known)) warnings.push(`${path}.${key}.${sub}: unbekanntes Feld ignoriert`);
      }
    }
  }

  for (const [p, [min, max]] of Object.entries(PATCH_RANGES)) {
    const v = getIn(raw, p);
    if (v === undefined) continue;
    if (!isNum(v)) {
      errors.push(`${path}.${p}: Zahl erwartet`);
      continue;
    }
    if (v < min - 1e-9 || v > max + 1e-9) {
      errors.push(`${path}.${p}: ${v} außerhalb ${min}…${max}`);
      continue;
    }
    const parts = p.split('.');
    const last = parts.pop();
    const target = parts.reduce((o, k) => o[k], patch);
    target[last] = v;
  }

  for (const [p, allowed] of Object.entries(PATCH_ENUMS)) {
    const v = getIn(raw, p);
    if (v === undefined) continue;
    if (typeof v !== 'string' || !allowed.includes(v)) {
      errors.push(`${path}.${p}: "${v}" nicht erlaubt (${allowed.join(' / ')})`);
      continue;
    }
    const parts = p.split('.');
    const last = parts.pop();
    const target = parts.reduce((o, k) => o[k], patch);
    target[last] = v;
  }

  if (raw.matrix !== undefined) {
    if (!raw.matrix || typeof raw.matrix !== 'object' || Array.isArray(raw.matrix)) {
      errors.push(`${path}.matrix: Objekt erwartet`);
    } else {
      const matrix = {};
      for (const [key, amount] of Object.entries(raw.matrix)) {
        const [src, dest] = key.split(':');
        if (!SOURCE_IDS.has(src) || !DEST_IDS.has(dest)) {
          errors.push(`${path}.matrix["${key}"]: unbekannte Route`);
          continue;
        }
        if (!isInt(amount) || amount < -100 || amount > 100) {
          errors.push(`${path}.matrix["${key}"]: ganzzahlig −100…100 erwartet`);
          continue;
        }
        if (amount !== 0) matrix[key] = amount;
      }
      patch.matrix = matrix;
    }
  }

  return patch;
}

function validateEvents(rawTakes, path, loopTicks, errors) {
  const takes = [];
  if (rawTakes === undefined) return takes;
  if (!Array.isArray(rawTakes)) {
    errors.push(`${path}: Array aus Takes erwartet`);
    return takes;
  }
  if (rawTakes.length > LIMITS.maxTakesPerTrack) {
    errors.push(`${path}: mehr als ${LIMITS.maxTakesPerTrack} Takes`);
    return takes;
  }
  let total = 0;
  rawTakes.forEach((events, ti) => {
    if (!Array.isArray(events)) {
      errors.push(`${path}[${ti}]: Array aus Events erwartet`);
      return;
    }
    const out = [];
    events.forEach((ev, ei) => {
      const at = `${path}[${ti}][${ei}]`;
      if (!ev || typeof ev !== 'object') {
        errors.push(`${at}: Objekt erwartet`);
        return;
      }
      const { tick, dur, note, vel } = ev;
      let bad = false;
      if (!isInt(tick) || tick < 0 || tick >= loopTicks) {
        errors.push(`${at}.tick: ganzzahlig 0…${loopTicks - 1} erwartet (${tick})`);
        bad = true;
      }
      if (!isInt(dur) || dur < 1 || dur > loopTicks) {
        errors.push(`${at}.dur: ganzzahlig 1…${loopTicks} erwartet (${dur})`);
        bad = true;
      }
      if (!isInt(note) || note < 0 || note > 127) {
        errors.push(`${at}.note: ganzzahlig 0…127 erwartet (${note})`);
        bad = true;
      }
      if (!isNum(vel) || vel < 0 || vel > 1) {
        errors.push(`${at}.vel: Zahl 0…1 erwartet (${vel})`);
        bad = true;
      }
      if (bad) return;
      total += 1;
      if (total > LIMITS.maxEventsPerTrack) {
        errors.push(`${path}: mehr als ${LIMITS.maxEventsPerTrack} Events`);
        return;
      }
      out.push({ tick, dur, note, vel });
    });
    takes.push(out);
  });
  return takes;
}

/**
 * Prüft ein Rohobjekt (aus JSON) streng und baut daraus ein Laufzeit-Projekt.
 * @returns {{ok: boolean, project: object|null, errors: string[], warnings: string[]}}
 */
export function validateProject(raw) {
  const errors = [];
  const warnings = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, project: null, errors: ['Projektdatei: Objekt erwartet'], warnings };
  }
  if (raw.version !== PROJECT_VERSION) {
    return {
      ok: false,
      project: null,
      errors: [`Projektversion ${JSON.stringify(raw.version)} wird nicht unterstützt (erwartet ${PROJECT_VERSION})`],
      warnings,
    };
  }

  const KNOWN_PROJECT_KEYS = new Set([
    'version', 'name', 'bpm', 'bars', 'quantizeStep', 'swing', 'metronome',
    'master', 'modWheel', 'activeTrackId', 'tracks',
  ]);
  for (const key of Object.keys(raw)) {
    if (!KNOWN_PROJECT_KEYS.has(key)) warnings.push(`${key}: unbekanntes Feld ignoriert`);
  }

  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, LIMITS.maxProjectName) : 'Projekt';
  const bpm = isNum(raw.bpm) ? Math.round(raw.bpm) : 120;
  if (!isNum(raw.bpm) || bpm < LIMITS.minBpm || bpm > LIMITS.maxBpm) {
    errors.push(`bpm: ${raw.bpm} außerhalb ${LIMITS.minBpm}…${LIMITS.maxBpm}`);
  }
  const bars = isNum(raw.bars) ? Math.round(raw.bars) : 4;
  if (!isNum(raw.bars) || bars < LIMITS.minBars || bars > LIMITS.maxBars) {
    errors.push(`bars: ${raw.bars} außerhalb ${LIMITS.minBars}…${LIMITS.maxBars}`);
  }
  const quantizeStep = isNum(raw.quantizeStep) ? raw.quantizeStep : 120;
  if (!QUANTIZE_STEPS.includes(quantizeStep)) errors.push(`quantizeStep: ${raw.quantizeStep} nicht erlaubt`);
  const swing = isNum(raw.swing) ? raw.swing : 0;
  if (swing < 0 || swing > 0.6) errors.push(`swing: ${raw.swing} außerhalb 0…0.6`);
  const master = isNum(raw.master) ? raw.master : 0.72;
  if (master < 0 || master > 1) errors.push(`master: ${raw.master} außerhalb 0…1`);
  const modWheel = isNum(raw.modWheel) ? raw.modWheel : 0;
  if (modWheel < 0 || modWheel > 1) errors.push(`modWheel: ${raw.modWheel} außerhalb 0…1`);

  const loopTicks = (isNum(raw.bars) ? bars : 4) * BEATS_PER_BAR * PPQ;

  if (!Array.isArray(raw.tracks) || raw.tracks.length === 0) {
    errors.push('tracks: mindestens eine Spur erwartet');
  } else if (raw.tracks.length > LIMITS.maxTracks) {
    errors.push(`tracks: mehr als ${LIMITS.maxTracks} Spuren`);
  }

  const tracks = [];
  const ids = new Set();
  if (Array.isArray(raw.tracks)) {
    raw.tracks.forEach((rt, i) => {
      const at = `tracks[${i}]`;
      if (!rt || typeof rt !== 'object' || Array.isArray(rt)) {
        errors.push(`${at}: Objekt erwartet`);
        return;
      }
      let id = typeof rt.id === 'string' && rt.id ? rt.id.slice(0, 64) : newId('trk');
      if (ids.has(id)) {
        warnings.push(`${at}.id: doppelt, neue ID vergeben`);
        id = newId('trk');
      }
      ids.add(id);

      const trackName = (typeof rt.name === 'string' ? rt.name.trim() : '').slice(0, LIMITS.maxTrackName) || `Track ${i + 1}`;
      const patchName = (typeof rt.patchName === 'string' ? rt.patchName.trim() : '').slice(0, LIMITS.maxTrackName) || 'Init';
      const patch = validatePatch(rt.patch, `${at}.patch`, errors, warnings);
      const mute = rt.mute === true;
      const solo = rt.solo === true;
      const gain = isNum(rt.gain) ? rt.gain : 0.8;
      if (gain < 0 || gain > LIMITS.maxGain) errors.push(`${at}.gain: ${rt.gain} außerhalb 0…${LIMITS.maxGain}`);

      const takes = validateEvents(rt.takes, `${at}.takes`, loopTicks, errors);
      const clip = Clip.fromTakes(takes);

      if (patch) tracks.push({ id, name: trackName, patchName, patch, mute, solo, gain, clip });
    });
  }

  let activeTrackId = raw.activeTrackId;
  if (!tracks.some((t) => t.id === activeTrackId)) {
    if (tracks.length) warnings.push('activeTrackId: unbekannt, erste Spur gewählt');
    activeTrackId = tracks.length ? tracks[0].id : null;
  }

  if (errors.length) return { ok: false, project: null, errors, warnings };

  return {
    ok: true,
    errors,
    warnings,
    project: {
      version: PROJECT_VERSION,
      name,
      bpm,
      bars,
      quantizeStep,
      swing,
      metronome: raw.metronome !== false,
      master,
      modWheel,
      activeTrackId,
      tracks,
    },
  };
}

/* -------------------------------------------------------------- (De)Serialisierung */

export function serialize(project) {
  return {
    version: PROJECT_VERSION,
    name: project.name,
    bpm: project.bpm,
    bars: project.bars,
    quantizeStep: project.quantizeStep,
    swing: project.swing,
    metronome: project.metronome,
    master: project.master,
    modWheel: project.modWheel,
    activeTrackId: project.activeTrackId,
    tracks: project.tracks.map((t) => ({
      id: t.id,
      name: t.name,
      patchName: t.patchName || 'Init',
      mute: t.mute,
      solo: t.solo,
      gain: t.gain,
      patch: structuredClone(t.patch),
      takes: t.clip ? t.clip.toTakes() : [],
    })),
  };
}

export function deserialize(input) {
  let raw = input;
  if (typeof input === 'string') {
    if (input.length > LIMITS.maxFileBytes) {
      return { ok: false, project: null, errors: [`Datei größer als ${LIMITS.maxFileBytes} Bytes`], warnings: [] };
    }
    try {
      raw = JSON.parse(input);
    } catch (err) {
      return { ok: false, project: null, errors: ['JSON nicht lesbar: ' + err.message], warnings: [] };
    }
  }
  return validateProject(raw);
}

/* ------------------------------------------------------------------ Speicher */

function storageOrNull() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch (e) {
    return null;
  }
}

export function saveLocal(project, storage = storageOrNull()) {
  if (!storage) return { ok: false, error: 'Kein lokaler Speicher verfügbar' };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(serialize(project)));
    return { ok: true, at: new Date() };
  } catch (err) {
    return { ok: false, error: 'Speichern fehlgeschlagen: ' + err.message };
  }
}

export function loadLocal(storage = storageOrNull()) {
  if (!storage) return { ok: false, empty: true, errors: ['Kein lokaler Speicher verfügbar'] };
  let text;
  try {
    text = storage.getItem(STORAGE_KEY);
  } catch (err) {
    return { ok: false, empty: true, errors: [err.message] };
  }
  if (!text) return { ok: false, empty: true, errors: [] };
  return deserialize(text);
}

export function clearLocal(storage = storageOrNull()) {
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch (e) {
    /* ignore */
  }
}

/* ------------------------------------------------------------------- Browser */

export function downloadBlob(blob, filename) {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return false;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
  return true;
}

export function safeFilename(name, extension) {
  const base = (name || 'sonic-dsp')
    .normalize('NFKD')
    .replace(/[^\w\-. ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'sonic-dsp';
  return `${base}.${extension}`;
}

export async function readTextFile(file) {
  if (!file) return { ok: false, error: 'Keine Datei gewählt' };
  if (file.size > LIMITS.maxFileBytes) {
    return { ok: false, error: `Datei zu groß (${Math.round(file.size / 1024)} KB, max. ${LIMITS.maxFileBytes / 1024} KB)` };
  }
  try {
    const text = await file.text();
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: 'Datei nicht lesbar: ' + err.message };
  }
}

export async function readBinaryFile(file) {
  if (!file) return { ok: false, error: 'Keine Datei gewählt' };
  if (file.size > LIMITS.maxFileBytes) {
    return { ok: false, error: `Datei zu groß (${Math.round(file.size / 1024)} KB, max. ${LIMITS.maxFileBytes / 1024} KB)` };
  }
  try {
    const buf = await file.arrayBuffer();
    return { ok: true, bytes: new Uint8Array(buf) };
  } catch (err) {
    return { ok: false, error: 'Datei nicht lesbar: ' + err.message };
  }
}
