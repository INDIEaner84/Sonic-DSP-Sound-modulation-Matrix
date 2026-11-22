/* Sonic DSP — App-Verdrahtung
 * Verbindet Patch-State, Audio-Engine und UI-Bausteine.
 */

import {
  state,
  PRESETS,
  buildPatch,
  SOURCES,
  DESTS,
  WAVES,
  LFO_SHAPES,
  FILTER_TYPES,
  clamp,
  getPath,
  setPath,
  mulberry32,
} from './state.js';
import { Engine } from './audio.js';
import {
  createKnob,
  createSeg,
  createWheel,
  createMatrix,
  createKeyboard,
  Scope,
  LfoPreview,
  fmt,
  noteName,
} from './ui.js';

const engine = new Engine(state);
const knobs = [];
const segs = [];

/* ------------------------------------------------------------- Knob-Helfer */

function addKnob(slot, path, opts) {
  const parent = typeof slot === 'string' ? document.getElementById(slot) : slot;
  if (!parent) return null;
  const knob = createKnob(parent, {
    value: getPath(path),
    def: opts.def != null ? opts.def : getPath(path),
    onChange: (v) => {
      setPath(path, v);
      if (opts.after) opts.after(v);
    },
    ...opts,
  });
  knobs.push({ path, knob });
  return knob;
}

function addSeg(slot, path, options, after) {
  const parent = document.getElementById(slot);
  if (!parent) return null;
  const seg = createSeg(parent, {
    options,
    value: getPath(path),
    onChange: (v) => {
      setPath(path, v);
      if (after) after(v);
    },
  });
  segs.push({ path, seg });
  return seg;
}

/* --------------------------------------------------------- Oszillatoren */

addSeg('segOsc1', 'osc1.wave', WAVES, () => engine.refreshVoices());
addKnob('knobsOsc1', 'osc1.level', { min: 0, max: 1, label: 'LEVEL', format: fmt.pct });
addKnob('knobsOsc1', 'osc1.octave', { min: -2, max: 2, step: 1, label: 'OCTAVE', format: fmt.oct });
addKnob('knobsOsc1', 'osc1.detune', { min: -50, max: 50, label: 'DETUNE', format: fmt.cents, def: 0 });

addSeg('segOsc2', 'osc2.wave', WAVES, () => engine.refreshVoices());
addKnob('knobsOsc2', 'osc2.level', { min: 0, max: 1, label: 'LEVEL', format: fmt.pct });
addKnob('knobsOsc2', 'osc2.octave', { min: -2, max: 2, step: 1, label: 'OCTAVE', format: fmt.oct });
addKnob('knobsOsc2', 'osc2.detune', { min: -50, max: 50, label: 'DETUNE', format: fmt.cents, def: 0 });

/* ------------------------------------------------------------------ Filter */

addSeg('segFilter', 'filter.type', FILTER_TYPES, () => engine.refreshVoices());
addKnob('knobsFilter', 'filter.cutoff', {
  min: 40,
  max: 14000,
  curve: 'log',
  label: 'CUTOFF',
  format: fmt.hz,
  def: 900,
  sensitivity: 220,
});
addKnob('knobsFilter', 'filter.reso', { min: 0.3, max: 24, label: 'RESO', format: fmt.num, def: 4 });

/* -------------------------------------------------------------- Hüllkurven */

const envOpts = [
  { key: 'a', label: 'ATTACK', min: 0.001, max: 4, curve: 'log', format: fmt.sec },
  { key: 'd', label: 'DECAY', min: 0.001, max: 4, curve: 'log', format: fmt.sec },
  { key: 's', label: 'SUSTAIN', min: 0, max: 1, format: fmt.pct },
  { key: 'r', label: 'RELEASE', min: 0.005, max: 6, curve: 'log', format: fmt.sec },
];

envOpts.forEach((o) => {
  addKnob('knobsAmpEnv', `ampEnv.${o.key}`, {
    min: o.min,
    max: o.max,
    curve: o.curve,
    label: o.label,
    format: o.format,
    def: getPath(`ampEnv.${o.key}`),
  });
  addKnob('knobsModEnv', `modEnv.${o.key}`, {
    min: o.min,
    max: o.max,
    curve: o.curve,
    label: o.label,
    format: o.format,
    def: getPath(`modEnv.${o.key}`),
  });
});

/* --------------------------------------------------------------------- LFO */

addSeg('segLfo1', 'lfo1.shape', LFO_SHAPES);
addKnob('knobsLfo1', 'lfo1.rate', { min: 0.05, max: 24, curve: 'log', label: 'RATE', format: fmt.rate, def: 4.8 });
addSeg('segLfo2', 'lfo2.shape', LFO_SHAPES);
addKnob('knobsLfo2', 'lfo2.rate', { min: 0.02, max: 24, curve: 'log', label: 'RATE', format: fmt.rate, def: 0.22 });

/* -------------------------------------------------------------- Performance */

addKnob('knobsPerf', 'glide', {
  min: 0,
  max: 0.5,
  label: 'GLIDE',
  format: (v) => (v < 0.001 ? 'OFF' : Math.round(v * 1000) + ' ms'),
  def: 0.02,
});

const wheel = createWheel(document.getElementById('modWheel'), {
  value: state.modWheel,
  onChange: (v) => {
    state.modWheel = v;
  },
});

/* ------------------------------------------------------------------ Master */

const masterKnob = addKnob('masterKnobSlot', 'master', {
  min: 0,
  max: 1,
  label: 'MASTER',
  format: fmt.pct,
  def: 0.72,
  after: (v) => {
    if (engine.master) engine.master.gain.setTargetAtTime(v, engine.ctx.currentTime, 0.02);
  },
});
if (masterKnob) masterKnob.el.classList.add('master-knob');

/* ------------------------------------------------------------------ Matrix */

const matrix = createMatrix(document.getElementById('matrix'), {
  onChange: () => {
    matrix.refresh();
  },
});

/* ---------------------------------------------------------------- Keyboard */

const keysEl = document.getElementById('keys');
const octLabel = document.getElementById('octLabel');
let baseNote = 48;

const keyboard = createKeyboard(keysEl, {
  base: baseNote,
  octaves: 2,
  onNoteOn: async (note, velocity) => {
    await ensureAudio();
    engine.noteOn(note, velocity);
  },
  onNoteOff: (note) => engine.noteOff(note),
});

function updateOctaveLabel() {
  octLabel.textContent = `${noteName(baseNote)} – ${noteName(baseNote + 23)}`;
}
updateOctaveLabel();

function shiftOctave(delta) {
  const next = clamp(baseNote + delta * 12, 24, 72);
  if (next === baseNote) return;
  baseNote = next;
  keyboard.setBase(baseNote);
  updateOctaveLabel();
}

document.getElementById('octDown').addEventListener('click', () => shiftOctave(-1));
document.getElementById('octUp').addEventListener('click', () => shiftOctave(1));

/* Rechner-Tastatur */
const KEYMAP = {
  a: 0,
  w: 1,
  s: 2,
  e: 3,
  d: 4,
  f: 5,
  t: 6,
  g: 7,
  y: 8,
  h: 9,
  u: 10,
  j: 11,
  k: 12,
  o: 13,
  l: 14,
  p: 15,
  ';': 16,
};
const pressedKeys = new Map(); // keyboard-key -> note

document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  const k = e.key.toLowerCase();
  if (k === 'z') {
    shiftOctave(-1);
    return;
  }
  if (k === 'x') {
    shiftOctave(1);
    return;
  }
  if (!(k in KEYMAP)) return;
  e.preventDefault();
  if (e.repeat || pressedKeys.has(k)) return;

  const note = baseNote + KEYMAP[k];
  pressedKeys.set(k, note);
  keyboard.pressExternal(note);
  ensureAudio().then(() => engine.noteOn(note, 0.82));
});

document.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (!pressedKeys.has(k)) return;
  const note = pressedKeys.get(k);
  pressedKeys.delete(k);
  keyboard.releaseExternal(note);
  engine.noteOff(note);
});

window.addEventListener('blur', () => {
  pressedKeys.clear();
  keyboard.releaseAll();
  engine.allNotesOff();
});

/* ------------------------------------------------------------------ Scope */

const scope = new Scope(document.getElementById('scope'), {
  engine,
  meterFill: document.getElementById('meterFill'),
  stateEl: document.getElementById('scopeState'),
  dbEl: document.getElementById('scopeDb'),
});
const lfo1Preview = new LfoPreview(document.getElementById('lfo1Scope'), engine, 'lfo1', '#ffb245');
const lfo2Preview = new LfoPreview(document.getElementById('lfo2Scope'), engine, 'lfo2', '#54d7c7');

let frame = 0;
function loop() {
  requestAnimationFrame(loop);
  scope.draw();
  lfo1Preview.draw();
  lfo2Preview.draw();
  if ((frame++ & 1) === 0) matrix.setActivity(engine.srcSnapshot, engine.lastSums);
}
requestAnimationFrame(loop);

/* --------------------------------------------------------------- Audio-Start */

const gate = document.getElementById('gate');
const powerBtn = document.getElementById('powerBtn');
const powerLabel = document.getElementById('powerLabel');

function markAudioOn(on) {
  document.body.classList.toggle('audio-on', on);
  powerLabel.textContent = on ? 'Audio On' : 'Audio Start';
  if (on) gate.classList.add('hidden');
}

async function ensureAudio() {
  if (!engine.ctx) {
    gate.classList.add('hidden');
    await engine.init();
    markAudioOn(engine.ctx.state === 'running');
    return;
  }
  if (engine.ctx.state !== 'running') {
    try {
      await engine.ctx.resume();
    } catch (err) {
      /* ignore */
    }
  }
  markAudioOn(engine.ctx.state === 'running');
}

document.getElementById('gateBtn').addEventListener('click', ensureAudio);
powerBtn.addEventListener('click', async () => {
  if (!engine.ctx) {
    await ensureAudio();
    return;
  }
  if (engine.ctx.state === 'running') {
    await engine.suspend();
    markAudioOn(false);
    engine.allNotesOff();
  } else {
    await ensureAudio();
  }
});

engine.onStateChange = (st) => markAudioOn(st === 'running');

/* ---------------------------------------------------------------- Presets */

const select = document.getElementById('presetSelect');
PRESETS.forEach((p, i) => {
  const opt = document.createElement('option');
  opt.value = String(i);
  opt.textContent = p.name;
  select.appendChild(opt);
});
select.value = '0';

function refreshUI() {
  knobs.forEach(({ path, knob }) => knob.set(getPath(path), true));
  segs.forEach(({ path, seg }) => seg.set(getPath(path)));
  wheel.set(state.modWheel);
  matrix.refresh();
  updateOctaveLabel();
}

select.addEventListener('change', () => {
  const index = Number(select.value);
  const preset = PRESETS[index];
  if (!preset) return;
  engine.allNotesOff();
  const prevMaster = state.master;
  const prevWheel = state.modWheel;
  const patch = buildPatch(preset.patch);
  Object.assign(state, patch);
  state.master = prevMaster;
  state.modWheel = prevWheel;
  refreshUI();
  engine.refreshVoices();
});

/* ------------------------------------------------------------- Matrix-Aktionen */

document.getElementById('clearBtn').addEventListener('click', () => {
  state.matrix = {};
  matrix.refresh();
});

document.getElementById('randBtn').addEventListener('click', () => {
  const rnd = mulberry32((Date.now() ^ (Math.random() * 1e9)) >>> 0);
  const next = {};
  for (const s of SOURCES) {
    for (const d of DESTS) {
      if (rnd() < 0.3) {
        const mag = 8 + Math.round(rnd() * 82);
        next[`${s.id}:${d.id}`] = rnd() < 0.22 ? -mag : mag;
      }
    }
  }
  state.matrix = next;
  matrix.refresh();
});

document.getElementById('panicBtn').addEventListener('click', () => {
  engine.allNotesOff();
  pressedKeys.clear();
  keyboard.releaseAll();
});

/* ------------------------------------------------------------------ Start */

refreshUI();
setTimeout(() => scope.resize(), 60);
window.addEventListener('load', () => {
  scope.resize();
  lfo1Preview.resize();
  lfo2Preview.resize();
});

console.info('%cSONIC DSP', 'color:#ffb245;font-weight:700', '— Modulation Matrix bereit.');

export { state, engine };
