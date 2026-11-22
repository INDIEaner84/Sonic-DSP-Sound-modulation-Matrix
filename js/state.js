/* Sonic DSP — Patch-Modell
 * Ein Patch beschreibt nur den Klang (Oszillatoren, Filter, Hüllkurven, LFOs,
 * Modulationsmatrix). Projektweite Werte (Master, Mod-Wheel, Tempo) liegen im
 * Projekt (js/project.js), damit Patches frei zwischen Spuren wandern können.
 */

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const SOURCES = [
  { id: 'lfo1', label: 'LFO 1', color: '#ffb245' },
  { id: 'lfo2', label: 'LFO 2', color: '#54d7c7' },
  { id: 'env2', label: 'ENV 2', color: '#a98bff' },
  { id: 'vel', label: 'VELOCITY', color: '#ff7a9c' },
  { id: 'mw', label: 'MOD WHEEL', color: '#7bd88f' },
  { id: 'key', label: 'KEY TRACK', color: '#8ab4ff' },
];

export const DESTS = [
  { id: 'pitch1', label: 'PITCH 1', unit: 'st' },
  { id: 'pitch2', label: 'PITCH 2', unit: 'st' },
  { id: 'level1', label: 'LEVEL 1', unit: '' },
  { id: 'level2', label: 'LEVEL 2', unit: '' },
  { id: 'cutoff', label: 'CUTOFF', unit: 'oct' },
  { id: 'reso', label: 'RESO', unit: '' },
  { id: 'pan', label: 'PAN', unit: '' },
  { id: 'lfo1rate', label: 'LFO 1 RATE', unit: 'oct' },
];

export const WAVES = [
  { v: 'sawtooth', label: 'SAW' },
  { v: 'square', label: 'SQR' },
  { v: 'triangle', label: 'TRI' },
  { v: 'sine', label: 'SIN' },
];

export const LFO_SHAPES = [
  { v: 'sine', label: 'SIN' },
  { v: 'tri', label: 'TRI' },
  { v: 'saw', label: 'SAW' },
  { v: 'square', label: 'SQR' },
  { v: 'random', label: 'RND' },
];

export const FILTER_TYPES = [
  { v: 'lowpass', label: 'LP' },
  { v: 'bandpass', label: 'BP' },
  { v: 'highpass', label: 'HP' },
];

/** Erlaubte Wertebereiche je Patch-Pfad (auch für die Import-Validierung). */
export const PATCH_RANGES = {
  'osc1.level': [0, 1],
  'osc1.octave': [-2, 2],
  'osc1.detune': [-50, 50],
  'osc2.level': [0, 1],
  'osc2.octave': [-2, 2],
  'osc2.detune': [-50, 50],
  'filter.cutoff': [40, 14000],
  'filter.reso': [0.3, 24],
  'ampEnv.a': [0.001, 4],
  'ampEnv.d': [0.001, 4],
  'ampEnv.s': [0, 1],
  'ampEnv.r': [0.005, 6],
  'modEnv.a': [0.001, 4],
  'modEnv.d': [0.001, 4],
  'modEnv.s': [0, 1],
  'modEnv.r': [0.005, 6],
  'lfo1.rate': [0.05, 24],
  'lfo2.rate': [0.02, 24],
  glide: [0, 0.5],
};

export const PATCH_ENUMS = {
  'osc1.wave': WAVES.map((w) => w.v),
  'osc2.wave': WAVES.map((w) => w.v),
  'filter.type': FILTER_TYPES.map((f) => f.v),
  'lfo1.shape': LFO_SHAPES.map((s) => s.v),
  'lfo2.shape': LFO_SHAPES.map((s) => s.v),
};

export const DEFAULT_PATCH = {
  glide: 0.02,
  osc1: { wave: 'sawtooth', octave: 0, detune: 0, level: 0.55 },
  osc2: { wave: 'square', octave: -1, detune: 8, level: 0.32 },
  filter: { type: 'lowpass', cutoff: 900, reso: 4 },
  ampEnv: { a: 0.01, d: 0.28, s: 0.55, r: 0.35 },
  modEnv: { a: 0.02, d: 0.35, s: 0.18, r: 0.4 },
  lfo1: { shape: 'sine', rate: 4.8 },
  lfo2: { shape: 'tri', rate: 0.22 },
  matrix: {
    'env2:cutoff': 42,
    'vel:cutoff': 22,
    'key:cutoff': 18,
    'lfo1:pitch1': 4,
    'lfo1:pitch2': 4,
    'lfo2:pan': 25,
  },
};

/** Baut einen vollständigen Patch aus Default + Overrides (tief, ohne Mutation). */
export function buildPatch(overrides) {
  const p = structuredClone(DEFAULT_PATCH);
  if (!overrides) return p;
  for (const key of Object.keys(overrides)) {
    const v = overrides[key];
    if (key === 'matrix') {
      p.matrix = { ...v };
    } else if (v && typeof v === 'object' && p[key] && typeof p[key] === 'object') {
      Object.assign(p[key], v);
    } else {
      p[key] = v;
    }
  }
  return p;
}

/* ------------------------------------------------------------- Pfad-Helfer */

export function getIn(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

export function setIn(obj, path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  const target = parts.reduce((o, k) => o[k], obj);
  target[last] = value;
  return obj;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PRESETS = [
  {
    name: 'Init Lead',
    patch: {},
  },
  {
    name: 'Wobble Bass',
    patch: {
      osc1: { wave: 'sawtooth', octave: -1, detune: 0, level: 0.6 },
      osc2: { wave: 'square', octave: -1, detune: 6, level: 0.4 },
      filter: { type: 'lowpass', cutoff: 420, reso: 7.5 },
      ampEnv: { a: 0.005, d: 0.3, s: 0.9, r: 0.15 },
      modEnv: { a: 0.01, d: 0.2, s: 0.2, r: 0.2 },
      lfo1: { shape: 'square', rate: 3.2 },
      lfo2: { shape: 'sine', rate: 0.5 },
      glide: 0.06,
      matrix: {
        'lfo1:cutoff': 78,
        'lfo1:reso': 18,
        'env2:cutoff': 22,
        'vel:cutoff': 14,
        'lfo1:level2': -18,
      },
    },
  },
  {
    name: 'Pluck Lead',
    patch: {
      osc1: { wave: 'sawtooth', octave: 0, detune: 0, level: 0.5 },
      osc2: { wave: 'sawtooth', octave: 0, detune: 9, level: 0.45 },
      filter: { type: 'lowpass', cutoff: 780, reso: 8 },
      ampEnv: { a: 0.002, d: 0.2, s: 0.05, r: 0.22 },
      modEnv: { a: 0.001, d: 0.26, s: 0.0, r: 0.2 },
      lfo1: { shape: 'sine', rate: 5.6 },
      lfo2: { shape: 'tri', rate: 0.3 },
      glide: 0,
      matrix: {
        'env2:cutoff': 68,
        'vel:cutoff': 34,
        'env2:reso': 20,
        'lfo1:pitch1': 3,
        'lfo1:pitch2': 3,
        'key:cutoff': 24,
      },
    },
  },
  {
    name: 'Drift Pad',
    patch: {
      osc1: { wave: 'sawtooth', octave: 0, detune: -6, level: 0.42 },
      osc2: { wave: 'triangle', octave: -1, detune: 11, level: 0.4 },
      filter: { type: 'lowpass', cutoff: 1500, reso: 2.4 },
      ampEnv: { a: 0.85, d: 0.7, s: 0.8, r: 1.9 },
      modEnv: { a: 1.2, d: 1.0, s: 0.6, r: 2.0 },
      lfo1: { shape: 'sine', rate: 0.24 },
      lfo2: { shape: 'tri', rate: 0.13 },
      glide: 0.12,
      matrix: {
        'lfo1:cutoff': 36,
        'lfo2:pan': 58,
        'lfo1:pitch1': 6,
        'lfo2:pitch2': -6,
        'env2:cutoff': 34,
        'mw:cutoff': 60,
        'key:cutoff': 12,
      },
    },
  },
  {
    name: 'Res Sweep FX',
    patch: {
      osc1: { wave: 'sawtooth', octave: 0, detune: 0, level: 0.45 },
      osc2: { wave: 'square', octave: 1, detune: -4, level: 0.22 },
      filter: { type: 'bandpass', cutoff: 1200, reso: 12 },
      ampEnv: { a: 0.4, d: 0.6, s: 0.6, r: 1.6 },
      modEnv: { a: 0.05, d: 2.5, s: 0.0, r: 1.5 },
      lfo1: { shape: 'saw', rate: 0.18 },
      lfo2: { shape: 'random', rate: 6 },
      glide: 0,
      matrix: {
        'lfo1:cutoff': 62,
        'env2:cutoff': 40,
        'lfo1:reso': 24,
        'lfo2:pitch1': 8,
        'lfo2:pan': 44,
        'mw:reso': 30,
      },
    },
  },
];
