/* Sonic DSP — Projektmodell
 * Ein Projekt enthält Spuren (jede mit eigenem Patch und eigenem Loop-Clip),
 * Tempo, Loop-Länge und Performance-Werte. Diese Datei ist die einzige
 * Wahrheitsquelle für Schema, Grenzen, Validierung und Persistenz.
 */

import { Clip } from './clip.js';
import { buildPatch, getIn, PATCH_RANGES, PATCH_ENUMS, SOURCES, DESTS, DEFAULT_PATCH } from './state.js';

export const PROJECT_VERSION = 2;

/** Versionen, die beim Laden übernommen werden (ältere werden migriert). */
export const SUPPORTED_VERSIONS = [1, 2];

/** Schema-2-Felder für die Migration aus Version 1. */
export const SEND_DEFAULTS = { delay: 0.12, reverb: 0.18 };

export const DELAY_DIVISIONS = ['1/16', '1/8', '3/16', '1/4', '3/8', '1/2'];

/** Delay-Raster in Schlägen (1/4 = ein Schlag). */
export const DELAY_DIVISION_BEATS = {
  '1/16': 0.25,
  '1/8': 0.5,
  '3/16': 0.75,
  '1/4': 1,
  '3/8': 1.5,
  '1/2': 2,
};

export const FX_DEFAULTS = {
  delayDivision: '1/8',
  delayFeedback: 0.3,
  delayTone: 3200,
  reverbSize: 2.2,
  reverbDamp: 0.45,
};

export const STORAGE_KEY = 'sonicdsp.project';
/** Frühere Schlüssel; werden beim Laden noch gelesen und dann in den neuen überführt. */
export const LEGACY_STORAGE_KEYS = ['sonicdsp.project.v1'];
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
  maxSend: 1,
  maxDelayFeedback: 0.85,
  minDelayTone: 300,
  maxDelayTone: 9000,
  minReverbSize: 0.3,
  maxReverbSize: 8,
};

export const QUANTIZE_STEPS = [0, 60, 120, 240]; // OFF, 1/32, 1/16, 1/8 (PPQ 480)

const SOURCE_IDS = new Set(SOURCES.map((s) => s.id));
const DEST_IDS = new Set(DESTS.map((d) => d.id));
const KNOWN_TRACK_KEYS = new Set(['id', 'name', 'patchName', 'patch', 'mute', 'solo', 'gain', 'sends', 'takes']);

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

export function createTrack({ name, patch, id, gain = 0.8, patchName = 'Init', sends } = {}) {
  return {
    id: id || newId('trk'),
    name: name || 'Track',
    patchName,
    patch: buildPatch(patch),
    mute: false,
    solo: false,
    gain,
    sends: { ...SEND_DEFAULTS, ...(sends || {}) },
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
    fx: { ...FX_DEFAULTS, ...(overrides.fx || {}) },
    tracks,
  };
}

/** Delay-Zeit in Sekunden aus Raster und Tempo (eine Quelle für Engine und UI). */
export function delaySeconds(project) {
  const beats = DELAY_DIVISION_BEATS[project.fx && project.fx.delayDivision] ?? 0.5;
  return (beats * 60) / project.bpm;
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

/* ------------------------------------------------------- Send-/FX-Validierung */

function validateSends(raw, path, errors, warnings) {
  const sends = { ...SEND_DEFAULTS };
  if (raw === undefined) return sends;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${path}: Objekt erwartet`);
    return sends;
  }
  for (const key of Object.keys(raw)) {
    if (!(key in SEND_DEFAULTS)) {
      warnings.push(`${path}.${key}: unbekanntes Feld ignoriert`);
      continue;
    }
    const v = raw[key];
    if (!isNum(v) || v < 0 || v > LIMITS.maxSend) {
      errors.push(`${path}.${key}: Zahl 0…${LIMITS.maxSend} erwartet (${JSON.stringify(v)})`);
      continue;
    }
    sends[key] = v;
  }
  return sends;
}

function validateFx(raw, errors, warnings) {
  const fx = { ...FX_DEFAULTS };
  if (raw === undefined) return fx;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('fx: Objekt erwartet');
    return fx;
  }
  for (const key of Object.keys(raw)) {
    if (!(key in FX_DEFAULTS)) {
      warnings.push(`fx.${key}: unbekanntes Feld ignoriert`);
      continue;
    }
    const v = raw[key];
    switch (key) {
      case 'delayDivision':
        if (!DELAY_DIVISIONS.includes(v)) {
          errors.push(`fx.delayDivision: "${v}" nicht erlaubt (${DELAY_DIVISIONS.join(' / ')})`);
        } else {
          fx.delayDivision = v;
        }
        break;
      case 'delayFeedback':
        if (!isNum(v) || v < 0 || v > LIMITS.maxDelayFeedback) {
          errors.push(`fx.delayFeedback: Zahl 0…${LIMITS.maxDelayFeedback} erwartet (${v})`);
        } else {
          fx.delayFeedback = v;
        }
        break;
      case 'delayTone':
        if (!isNum(v) || v < LIMITS.minDelayTone || v > LIMITS.maxDelayTone) {
          errors.push(`fx.delayTone: Zahl ${LIMITS.minDelayTone}…${LIMITS.maxDelayTone} Hz erwartet (${v})`);
        } else {
          fx.delayTone = v;
        }
        break;
      case 'reverbSize':
        if (!isNum(v) || v < LIMITS.minReverbSize || v > LIMITS.maxReverbSize) {
          errors.push(`fx.reverbSize: Zahl ${LIMITS.minReverbSize}…${LIMITS.maxReverbSize} s erwartet (${v})`);
        } else {
          fx.reverbSize = v;
        }
        break;
      case 'reverbDamp':
        if (!isNum(v) || v < 0 || v > 1) {
          errors.push(`fx.reverbDamp: Zahl 0…1 erwartet (${v})`);
        } else {
          fx.reverbDamp = v;
        }
        break;
      default:
        break;
    }
  }
  return fx;
}

/**
 * Hebt ein älteres Projekt auf das aktuelle Schema (nur additive Defaults,
 * nichts wird entfernt oder umgedeutet). Unbekannte Versionen bleiben unverändert
 * und werden von `validateProject` abgelehnt.
 */
export function migrate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  if (raw.version === 1) {
    const out = structuredClone(raw);
    out.version = 2;
    out.fx = { ...FX_DEFAULTS, ...(raw.fx && typeof raw.fx === 'object' && !Array.isArray(raw.fx) ? raw.fx : {}) };
    out.tracks = (Array.isArray(raw.tracks) ? raw.tracks : []).map((t) => {
      if (!t || typeof t !== 'object') return t;
      const sends = t.sends && typeof t.sends === 'object' && !Array.isArray(t.sends) ? t.sends : {};
      return { ...t, sends: { ...SEND_DEFAULTS, ...sends } };
    });
    return out;
  }
  return raw;
}

/**
 * Prüft ein Rohobjekt (aus JSON) streng und baut daraus ein Laufzeit-Projekt.
 * @returns {{ok: boolean, project: object|null, errors: string[], warnings: string[], migratedFrom?: number}}
 */
export function validateProject(raw) {
  const errors = [];
  const warnings = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, project: null, errors: ['Projektdatei: Objekt erwartet'], warnings };
  }
  if (!SUPPORTED_VERSIONS.includes(raw.version)) {
    return {
      ok: false,
      project: null,
      errors: [`Projektversion ${JSON.stringify(raw.version)} wird nicht unterstützt (erwartet ${SUPPORTED_VERSIONS.join(' oder ')})`],
      warnings,
    };
  }

  const migratedFrom = raw.version !== PROJECT_VERSION ? raw.version : undefined;
  const data = migratedFrom ? migrate(raw) : raw;
  if (migratedFrom) warnings.push(`Projektversion ${migratedFrom} übernommen, neue Felder mit Standardwerten ergänzt`);

  const KNOWN_PROJECT_KEYS = new Set([
    'version', 'name', 'bpm', 'bars', 'quantizeStep', 'swing', 'metronome',
    'master', 'modWheel', 'activeTrackId', 'fx', 'tracks',
  ]);
  for (const key of Object.keys(data)) {
    if (!KNOWN_PROJECT_KEYS.has(key)) warnings.push(`${key}: unbekanntes Feld ignoriert`);
  }

  const name = typeof data.name === 'string' ? data.name.trim().slice(0, LIMITS.maxProjectName) : 'Projekt';
  const bpm = isNum(data.bpm) ? Math.round(data.bpm) : 120;
  if (!isNum(data.bpm) || bpm < LIMITS.minBpm || bpm > LIMITS.maxBpm) {
    errors.push(`bpm: ${data.bpm} außerhalb ${LIMITS.minBpm}…${LIMITS.maxBpm}`);
  }
  const bars = isNum(data.bars) ? Math.round(data.bars) : 4;
  if (!isNum(data.bars) || bars < LIMITS.minBars || bars > LIMITS.maxBars) {
    errors.push(`bars: ${data.bars} außerhalb ${LIMITS.minBars}…${LIMITS.maxBars}`);
  }
  const quantizeStep = isNum(data.quantizeStep) ? data.quantizeStep : 120;
  if (!QUANTIZE_STEPS.includes(quantizeStep)) errors.push(`quantizeStep: ${data.quantizeStep} nicht erlaubt`);
  const swing = isNum(data.swing) ? data.swing : 0;
  if (swing < 0 || swing > 0.6) errors.push(`swing: ${data.swing} außerhalb 0…0.6`);
  const master = isNum(data.master) ? data.master : 0.72;
  if (master < 0 || master > 1) errors.push(`master: ${data.master} außerhalb 0…1`);
  const modWheel = isNum(data.modWheel) ? data.modWheel : 0;
  if (modWheel < 0 || modWheel > 1) errors.push(`modWheel: ${data.modWheel} außerhalb 0…1`);

  const loopTicks = (isNum(data.bars) ? bars : 4) * BEATS_PER_BAR * PPQ;

  if (!Array.isArray(data.tracks) || data.tracks.length === 0) {
    errors.push('tracks: mindestens eine Spur erwartet');
  } else if (data.tracks.length > LIMITS.maxTracks) {
    errors.push(`tracks: mehr als ${LIMITS.maxTracks} Spuren`);
  }

  const tracks = [];
  const ids = new Set();
  if (Array.isArray(data.tracks)) {
    data.tracks.forEach((rt, i) => {
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

      for (const key of Object.keys(rt)) {
        if (!KNOWN_TRACK_KEYS.has(key)) warnings.push(`${at}.${key}: unbekanntes Feld ignoriert`);
      }
      const sends = validateSends(rt.sends, `${at}.sends`, errors, warnings);
      const takes = validateEvents(rt.takes, `${at}.takes`, loopTicks, errors);
      const clip = Clip.fromTakes(takes);

      if (patch) tracks.push({ id, name: trackName, patchName, patch, mute, solo, gain, sends, clip });
    });
  }

  let activeTrackId = data.activeTrackId;
  if (!tracks.some((t) => t.id === activeTrackId)) {
    if (tracks.length) warnings.push('activeTrackId: unbekannt, erste Spur gewählt');
    activeTrackId = tracks.length ? tracks[0].id : null;
  }

  const fx = validateFx(data.fx, errors, warnings);

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
      metronome: data.metronome !== false,
      master,
      modWheel,
      activeTrackId,
      fx,
      tracks,
    },
    migratedFrom,
  };
}

/* -------------------------------------------------------------- (De)Serialisierung */

export function serialize(project) {
  return {
    version: PROJECT_VERSION,
    fx: { ...FX_DEFAULTS, ...(project.fx || {}) },
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
      sends: { ...SEND_DEFAULTS, ...(t.sends || {}) },
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
  } catch (err) {
    const quota = err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014);
    return {
      ok: false,
      error: quota
        ? 'Speicher voll – Projekt als JSON-Datei sichern'
        : 'Speichern fehlgeschlagen: ' + err.message,
    };
  }
  /* Alt-Schlüssel erst nach erfolgreichem Schreiben aufräumen. */
  for (const legacy of LEGACY_STORAGE_KEYS) {
    try {
      storage.removeItem(legacy);
    } catch (e) {
      /* ignore */
    }
  }
  return { ok: true, at: new Date() };
}

export function loadLocal(storage = storageOrNull()) {
  if (!storage) return { ok: false, empty: true, errors: ['Kein lokaler Speicher verfügbar'] };
  let text = null;
  let key = STORAGE_KEY;
  try {
    text = storage.getItem(STORAGE_KEY);
    if (!text) {
      for (const legacy of LEGACY_STORAGE_KEYS) {
        const candidate = storage.getItem(legacy);
        if (candidate) {
          text = candidate;
          key = legacy;
          break;
        }
      }
    }
  } catch (err) {
    return { ok: false, empty: true, errors: [err.message] };
  }
  if (!text) return { ok: false, empty: true, errors: [] };
  return { ...deserialize(text), key, legacyKey: key !== STORAGE_KEY };
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
