/* Sonic DSP — App-Verdrahtung
 * Verbindet Projektmodell, Audio-Engine, Clock/Recorder, MIDI und UI.
 * Der Rack-Bereich (Knobs, Matrix, LFO) bearbeitet immer den Patch der
 * aktiven Spur; projektweite Werte (Master, Mod-Wheel, Tempo) liegen im Projekt.
 */

import {
  PRESETS,
  DEFAULT_PATCH,
  buildPatch,
  SOURCES,
  DESTS,
  WAVES,
  DRUM_KIT,
  LFO_SHAPES,
  FILTER_TYPES,
  clamp,
  getIn,
  setIn,
  mulberry32,
} from './state.js';
import { Engine } from './audio.js';
import { Clock } from './clock.js';
import {
  LIMITS,
  createProject,
  createTrack,
  activeTrackOf,
  deserialize,
  serialize,
  saveLocal,
  loadLocal,
  downloadBlob,
  safeFilename,
  readTextFile,
  readBinaryFile,
  FX_DEFAULTS,
  DELAY_DIVISIONS,
  INSTRUMENTS,
  MIDI_TARGETS,
  MIDI_TARGET_LABELS,
  isNumericTarget,
  applyControl,
} from './project.js';
import { encodeProject, decodeToProject, defaultImportPatches } from './midi-io.js';
import { mixSeconds, canRecord, recordOutput, blobToWav } from './recorder.js';
import { createMidiRouter, openMidiAccess, describeMessage } from './midi-input.js';
import {
  createKnob,
  createSeg,
  createWheel,
  createMatrix,
  createKeyboard,
  createSlider,
  createTrackList,
  createPads,
  Scope,
  LfoPreview,
  ClipStrip,
  fmt,
  noteName,
} from './ui.js';

/* ------------------------------------------------------------------ Zustand */

function freshProject() {
  const lead = createTrack({ name: 'Lead', patchName: 'Init Lead' });
  return createProject({ name: 'Neues Projekt', tracks: [lead], activeTrackId: lead.id });
}

const restored = loadLocal();
let project = restored.ok ? restored.project : freshProject();

const engine = new Engine();
engine.setProject(project);
const clock = new Clock(engine, project);

const knobs = [];
const segs = [];

const activeTrack = () => activeTrackOf(project);
const getPatch = () => {
  const t = activeTrack();
  return t ? t.patch : DEFAULT_PATCH;
};

/* ------------------------------------------------------------------- Toasts */

let toastTimer = null;
function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = `toast show ${kind}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

/* --------------------------------------------------------------- Autosave */

let saveTimer = null;
let lastSaveAt = null;

function setSaveState(text, kind = '') {
  const el = document.getElementById('saveState');
  if (!el) return;
  el.textContent = text;
  el.className = 'save-state' + (kind ? ' ' + kind : '');
}

function saveNow() {
  const result = saveLocal(project);
  if (result.ok) {
    lastSaveAt = result.at;
    setSaveState(`gespeichert ${lastSaveAt.toLocaleTimeString('de-DE')}`, 'ok');
  } else {
    setSaveState(result.error || 'nicht gespeichert', 'err');
  }
}

function scheduleSave() {
  setSaveState('ungespeichert …', 'dirty');
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 700);
}

/* ------------------------------------------------------------- Knob-Helfer */

function addKnob(slot, path, opts = {}) {
  const parent = document.getElementById(slot);
  if (!parent) return null;
  const knob = createKnob(parent, {
    value: getIn(getPatch(), path),
    def: opts.def != null ? opts.def : getIn(DEFAULT_PATCH, path),
    ...opts,
    onChange: (v) => {
      const patch = getPatch();
      if (patch) setIn(patch, path, v);
      if (opts.after) opts.after(v);
      scheduleSave();
    },
  });
  knobs.push({ path, knob });
  return knob;
}

function addSeg(slot, path, options, after) {
  const parent = document.getElementById(slot);
  if (!parent) return null;
  const seg = createSeg(parent, {
    options,
    value: getIn(getPatch(), path),
    onChange: (v) => {
      const patch = getPatch();
      if (patch) setIn(patch, path, v);
      if (after) after(v);
      scheduleSave();
    },
  });
  segs.push({ path, seg });
  return seg;
}

/* --------------------------------------------------------- Oszillatoren */

addSeg('segOsc1', 'osc1.wave', WAVES, () => engine.refreshVoices(project.activeTrackId));
addKnob('knobsOsc1', 'osc1.level', { min: 0, max: 1, label: 'LEVEL', format: fmt.pct });
addKnob('knobsOsc1', 'osc1.octave', { min: -2, max: 2, step: 1, label: 'OCTAVE', format: fmt.oct });
addKnob('knobsOsc1', 'osc1.detune', { min: -50, max: 50, label: 'DETUNE', format: fmt.cents, def: 0 });

addSeg('segOsc2', 'osc2.wave', WAVES, () => engine.refreshVoices(project.activeTrackId));
addKnob('knobsOsc2', 'osc2.level', { min: 0, max: 1, label: 'LEVEL', format: fmt.pct });
addKnob('knobsOsc2', 'osc2.octave', { min: -2, max: 2, step: 1, label: 'OCTAVE', format: fmt.oct });
addKnob('knobsOsc2', 'osc2.detune', { min: -50, max: 50, label: 'DETUNE', format: fmt.cents, def: 0 });

/* ------------------------------------------------------------------ Filter */

addSeg('segFilter', 'filter.type', FILTER_TYPES, () => engine.refreshVoices(project.activeTrackId));
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
    def: getIn(DEFAULT_PATCH, `ampEnv.${o.key}`),
  });
  addKnob('knobsModEnv', `modEnv.${o.key}`, {
    min: o.min,
    max: o.max,
    curve: o.curve,
    label: o.label,
    format: o.format,
    def: getIn(DEFAULT_PATCH, `modEnv.${o.key}`),
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
  value: project.modWheel,
  onChange: (v) => {
    project.modWheel = v;
    scheduleSave();
  },
});

/* ------------------------------------------------------------------ Master */

const masterKnob = createKnob(document.getElementById('masterKnobSlot'), {
  min: 0,
  max: 1,
  label: 'MASTER',
  format: fmt.pct,
  def: 0.72,
  value: project.master,
  onChange: (v) => {
    project.master = v;
    if (engine.master && engine.ctx) engine.master.gain.setTargetAtTime(v, engine.ctx.currentTime, 0.02);
    scheduleSave();
  },
});
if (masterKnob) masterKnob.el.classList.add('master-knob');

/* ------------------------------------------------------------------ Matrix */

const matrix = createMatrix(document.getElementById('matrix'), {
  getPatch,
  onChange: () => {
    matrix.refresh();
    scheduleSave();
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
    clock.noteOn(note, velocity);
  },
  onNoteOff: (note) => clock.noteOff(note),
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
const pressedKeys = new Map();

document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    clock.panic();
    pressedKeys.clear();
    keyboard.releaseAll();
    return;
  }

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

  /* Bei einer Drum-Spur spielt die Rechner-Tastatur die Pads statt Tonhöhen. */
  const track = activeTrack();
  const note =
    track && track.instrument === 'drums'
      ? DRUM_KIT[KEYMAP[k] % DRUM_KIT.length].note
      : baseNote + KEYMAP[k];
  pressedKeys.set(k, note);
  keyboard.pressExternal(note);
  ensureAudio().then(() => clock.noteOn(note, 0.82));
});

document.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (!pressedKeys.has(k)) return;
  const note = pressedKeys.get(k);
  pressedKeys.delete(k);
  keyboard.releaseExternal(note);
  clock.noteOff(note);
});

window.addEventListener('blur', () => {
  pressedKeys.clear();
  keyboard.releaseAll();
  clock.releaseLive();
});

/* ------------------------------------------------------------------ Scope */

const scope = new Scope(document.getElementById('scope'), {
  engine,
  meterFill: document.getElementById('meterFill'),
  stateEl: document.getElementById('scopeState'),
  dbEl: document.getElementById('scopeDb'),
});
const lfo1Preview = new LfoPreview(document.getElementById('lfo1Scope'), engine, 'lfo1', '#ffb245', getPatch);
const lfo2Preview = new LfoPreview(document.getElementById('lfo2Scope'), engine, 'lfo2', '#54d7c7', getPatch);

const strip = new ClipStrip(document.getElementById('clipCanvas'), {
  clock,
  getClip: () => {
    const t = activeTrack();
    return t ? t.clip : null;
  },
  badgeEl: document.getElementById('clipBadge'),
});

/* ------------------------------------------------------------- Spur-Liste */

const trackList = createTrackList(document.getElementById('tracks'), {
  getTracks: () => project.tracks,
  getActiveId: () => project.activeTrackId,
  onSelect: (id) => {
    if (project.activeTrackId === id) return;
    project.activeTrackId = id;
    trackList.build();
    refreshUI();
    syncTransportUI();
    scheduleSave();
  },
  onMute: (id) => {
    const t = project.tracks.find((x) => x.id === id);
    if (!t) return;
    t.mute = !t.mute;
    trackList.build();
    syncTransportUI();
    scheduleSave();
  },
  onSolo: (id) => {
    const t = project.tracks.find((x) => x.id === id);
    if (!t) return;
    t.solo = !t.solo;
    trackList.build();
    syncTransportUI();
    scheduleSave();
  },
  onGain: (id, value) => {
    const t = project.tracks.find((x) => x.id === id);
    if (!t) return;
    t.gain = clamp(value, 0, LIMITS.maxGain);
    scheduleSave();
  },
  onInstrument: (id, value) => {
    const t = project.tracks.find((x) => x.id === id);
    if (!t || !INSTRUMENTS.some((i) => i.id === value)) return;
    if (t.instrument === value) return;
    clock.panic();
    t.instrument = value;
    trackList.build();
    refreshInstrumentUi();
    scheduleSave();
    toast(`Spur „${t.name}": ${value.toUpperCase()}`, 'info');
  },
  onSend: (id, kind, value) => {
    const t = project.tracks.find((x) => x.id === id);
    if (!t || !(kind in t.sends)) return;
    t.sends[kind] = clamp(value, 0, LIMITS.maxSend);
    scheduleSave();
  },
  onRename: (id, name) => {
    const t = project.tracks.find((x) => x.id === id);
    if (!t) return;
    t.name = name;
    trackList.build();
    scheduleSave();
  },
  onDelete: (id) => deleteTrack(id),
});

/* --------------------------------------------------------------------- FX */

const fxKnobs = [];

function addFxKnob(key, opts) {
  const parent = document.getElementById('fxKnobs');
  if (!parent) return null;
  const knob = createKnob(parent, {
    value: project.fx[key],
    def: FX_DEFAULTS[key],
    ...opts,
    onChange: (v) => {
      project.fx[key] = v;
      scheduleSave();
    },
  });
  fxKnobs.push({ key, knob });
  return knob;
}

addFxKnob('delayFeedback', {
  min: 0,
  max: LIMITS.maxDelayFeedback,
  label: 'FEEDBACK',
  format: fmt.pct,
});
addFxKnob('delayTone', {
  min: LIMITS.minDelayTone,
  max: LIMITS.maxDelayTone,
  curve: 'log',
  label: 'TONE',
  format: fmt.hz,
});
addFxKnob('reverbSize', {
  min: LIMITS.minReverbSize,
  max: LIMITS.maxReverbSize,
  label: 'REVERB',
  format: fmt.sec,
});
addFxKnob('reverbDamp', { min: 0, max: 1, label: 'DAMP', format: fmt.pct });

const fxDivision = document.getElementById('fxDivision');
if (fxDivision) {
  for (const division of DELAY_DIVISIONS) {
    const option = document.createElement('option');
    option.value = division;
    option.textContent = division;
    fxDivision.appendChild(option);
  }
  fxDivision.value = project.fx.delayDivision;
  fxDivision.addEventListener('change', () => {
    if (!DELAY_DIVISIONS.includes(fxDivision.value)) return;
    project.fx.delayDivision = fxDivision.value;
    scheduleSave();
  });
}

function addTrack() {
  if (project.tracks.length >= LIMITS.maxTracks) {
    toast(`Maximal ${LIMITS.maxTracks} Spuren`, 'warn');
    return;
  }
  clock.panic();
  const track = createTrack({ name: `Track ${project.tracks.length + 1}`, patchName: 'Init Lead' });
  project.tracks.push(track);
  project.activeTrackId = track.id;
  engine.syncTracks();
  trackList.build();
  refreshUI();
  syncTransportUI();
  scheduleSave();
  toast(`Spur „${track.name}" angelegt`, 'ok');
}

function deleteTrack(id) {
  if (project.tracks.length <= 1) {
    toast('Die letzte Spur kann nicht gelöscht werden', 'warn');
    return;
  }
  const index = project.tracks.findIndex((t) => t.id === id);
  if (index < 0) return;
  clock.panic();
  const [removed] = project.tracks.splice(index, 1);
  if (project.activeTrackId === id) {
    project.activeTrackId = project.tracks[Math.max(0, index - 1)].id;
  }
  engine.syncTracks();
  trackList.build();
  refreshUI();
  syncTransportUI();
  scheduleSave();
  toast(`Spur „${removed.name}" gelöscht`, 'info');
}

document.getElementById('addTrackBtn').addEventListener('click', addTrack);

/* ------------------------------------------------ Projektleiste / MIDI / Save */

const projectNameInput = document.getElementById('projectName');
projectNameInput.addEventListener('change', () => {
  const value = projectNameInput.value.trim().slice(0, LIMITS.maxProjectName);
  project.name = value || 'Projekt';
  projectNameInput.value = project.name;
  scheduleSave();
});

function downloadJson() {
  const json = JSON.stringify(serialize(project), null, 2);
  const ok = downloadBlob(new Blob([json], { type: 'application/json' }), safeFilename(project.name, 'json'));
  toast(ok ? 'Projekt als JSON gespeichert' : 'Download nicht verfügbar', ok ? 'ok' : 'warn');
  saveNow();
}

async function loadJsonFile(file) {
  const read = await readTextFile(file);
  if (!read.ok) {
    toast(read.error, 'warn');
    return;
  }
  const result = deserialize(read.text);
  if (!result.ok) {
    toast('Import abgelehnt: ' + result.errors.slice(0, 2).join(' · '), 'warn');
    return;
  }
  replaceProject(result.project);
  toast(
    result.warnings.length ? `Projekt geladen (${result.warnings.length} Hinweis(e))` : 'Projekt geladen',
    'ok'
  );
}

function newProject() {
  if (!window.confirm('Neues Projekt starten? Der aktuelle Stand wird verworfen (vorher speichern!).')) return;
  clock.stop();
  replaceProject(freshProject());
  toast('Neues Projekt', 'info');
}

/**
 * Ersetzt das Projekt, ohne die Objektidentität zu wechseln: Das exportierte
 * `project` bleibt dieselbe Referenz (wichtig für UI-Bindings und Tests).
 */
function replaceProject(next) {
  if (next !== project) {
    for (const key of Object.keys(project)) delete project[key];
    Object.assign(project, next);
  }
  engine.setProject(project);
  clock.setProject(project);
  baseNote = 48;
  keyboard.setBase(baseNote);
  updateOctaveLabel();
  refreshUI();
  trackList.build();
  syncTransportUI();
  projectNameInput.value = project.name;
  scheduleSave();
}

document.getElementById('saveBtn').addEventListener('click', downloadJson);


/* ------------------------------------------------------- Pads & Instrument */

const pads = createPads(document.getElementById('pads'), {
  onTrigger: (note) => {
    ensureAudio().then(() => {
      if (!engine.ctx) return;
      clock.noteOn(note, 0.92);
      /* Pads sind Ein-Schuss: kurze Notendauer, damit die Aufnahme sauber bleibt. */
      setTimeout(() => clock.noteOff(note), 160);
    });
  },
});

const padTag = document.getElementById('padTag');

function refreshInstrumentUi() {
  const track = activeTrack();
  const instrument = track ? track.instrument || 'synth' : 'synth';
  if (pads) pads.setInstrument(instrument);
  if (padTag) padTag.textContent = instrument.toUpperCase();
}

/* ------------------------------------------------------------------ MIDI In */

const midiStatusEl = document.getElementById('midiStatus');
const midiDevicesEl = document.getElementById('midiDevices');
const midiTargetEl = document.getElementById('midiTarget');
const midiLearnBtn = document.getElementById('midiLearnBtn');
const midiConnectBtn = document.getElementById('midiConnectBtn');
const midiBindsEl = document.getElementById('midiBinds');
const midiMonitorEl = document.getElementById('midiMonitor');

let midiAccess = null;
const ccState = new Map();

const midiRouter = createMidiRouter({
  getProject: () => project,
  onNoteOn: (note, velocity) => {
    ensureAudio().then(() => {
      if (!engine.ctx) return;
      clock.noteOn(note, velocity);
      if (pads) pads.flash(note);
    });
  },
  onNoteOff: (note) => clock.noteOff(note),
  onControl: (target, amount, info) => handleMidiControl(target, amount, info),
});

/** Transportziele nur beim Hochziehen über 0,5 auslösen (kein Doppel-Feuern). */
function ccTriggered(target, amount, cc) {
  const key = `${cc}:${target}`;
  const previous = ccState.get(key) || 0;
  ccState.set(key, amount);
  return amount >= 0.5 && previous < 0.5;
}

let uiRefreshQueued = false;
/** Viele CC-Nachrichten hintereinander dürfen die UI nicht fluten. */
function scheduleUiRefresh() {
  if (uiRefreshQueued) return;
  uiRefreshQueued = true;
  const run = () => {
    uiRefreshQueued = false;
    refreshUI();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 16);
}

function handleMidiControl(target, amount, info) {
  if (!info || !info.numeric) {
    if (!ccTriggered(target, amount, info && info.cc)) return;
    switch (target) {
      case 'transport.play':
        if (!clock.running) togglePlay();
        break;
      case 'transport.stop':
        if (clock.running) clock.stop();
        syncTransportUI();
        break;
      case 'transport.toggle':
        togglePlay();
        break;
      case 'transport.record':
        toggleRec();
        break;
      case 'clip.clear':
        clock.clearClip();
        trackList.build();
        syncTransportUI();
        scheduleSave();
        break;
      case 'panic':
        clock.panic();
        pressedKeys.clear();
        keyboard.releaseAll();
        break;
      default:
        break;
    }
    return;
  }
  scheduleUiRefresh();
  scheduleSave();
}

function setMidiStatus(text, kind = '') {
  if (!midiStatusEl) return;
  midiStatusEl.textContent = text;
  midiStatusEl.className = 'tag' + (kind ? ' ' + kind : '');
}

function renderMidiDevices(devices) {
  if (!midiDevicesEl) return;
  midiDevicesEl.innerHTML = '';
  if (!devices || !devices.length) {
    const empty = document.createElement('span');
    empty.className = 'midi-empty';
    empty.textContent = 'kein Gerät gefunden';
    midiDevicesEl.appendChild(empty);
    return;
  }
  for (const device of devices) {
    const chip = document.createElement('span');
    chip.className = 'midi-device';
    chip.textContent = device.name + (device.manufacturer ? ` · ${device.manufacturer}` : '');
    chip.title = `ID ${device.id}`;
    midiDevicesEl.appendChild(chip);
  }
}

function renderMidiBinds() {
  if (!midiBindsEl) return;
  midiBindsEl.innerHTML = '';
  const binds = project.midi && Array.isArray(project.midi.binds) ? project.midi.binds : [];
  if (!binds.length) {
    const empty = document.createElement('span');
    empty.className = 'midi-empty';
    empty.textContent = 'noch keine Bindung';
    midiBindsEl.appendChild(empty);
    return;
  }
  binds.forEach((bind, index) => {
    const row = document.createElement('div');
    row.className = 'midi-bind';
    const label = document.createElement('span');
    label.className = 'midi-bind-label';
    const channel = bind.channel === 0 ? 'alle Kanäle' : `Kanal ${bind.channel}`;
    label.textContent = `CC ${bind.cc} · ${channel} → ${MIDI_TARGET_LABELS[bind.target] || bind.target}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'midi-bind-del';
    remove.textContent = '×';
    remove.title = 'Bindung löschen';
    remove.setAttribute('aria-label', `Bindung CC ${bind.cc} löschen`);
    remove.addEventListener('click', () => {
      project.midi.binds.splice(index, 1);
      renderMidiBinds();
      scheduleSave();
    });
    row.append(label, remove);
    midiBindsEl.appendChild(row);
  });
}

function setLearnState(active) {
  if (!midiLearnBtn) return;
  midiLearnBtn.textContent = active ? 'Lernen … (abbrechen)' : 'CC anlernen';
  midiLearnBtn.classList.toggle('on', active);
}

function addMidiBind(bind) {
  const binds = project.midi.binds;
  const existing = binds.findIndex((b) => b.cc === bind.cc && b.channel === bind.channel);
  if (existing >= 0) {
    binds[existing] = bind;
  } else {
    if (binds.length >= LIMITS.maxMidiBinds) {
      toast(`Maximal ${LIMITS.maxMidiBinds} MIDI-Bindungen`, 'warn');
      return false;
    }
    binds.push(bind);
  }
  renderMidiBinds();
  scheduleSave();
  return true;
}

if (midiTargetEl) {
  for (const target of MIDI_TARGETS) {
    const option = document.createElement('option');
    option.value = target;
    option.textContent = MIDI_TARGET_LABELS[target] || target;
    midiTargetEl.appendChild(option);
  }
  midiTargetEl.value = 'master';
}

if (midiLearnBtn) {
  midiLearnBtn.addEventListener('click', () => {
    if (midiRouter.learning) {
      midiRouter.cancelLearn();
      setLearnState(false);
      toast('Anlernen abgebrochen', 'info');
      return;
    }
    if (!midiAccess) {
      toast('Erst MIDI verbinden', 'warn');
      return;
    }
    const target = midiTargetEl ? midiTargetEl.value : 'master';
    midiRouter.startLearn(target, (bind) => {
      setLearnState(false);
      if (addMidiBind(bind)) {
        toast(`CC ${bind.cc} (Kanal ${bind.channel}) → ${MIDI_TARGET_LABELS[bind.target] || bind.target}`, 'ok');
      }
    });
    setLearnState(true);
    toast('Jetzt den Regler bzw. die Taste am Controller bewegen …', 'info');
  });
}

if (midiConnectBtn) {
  midiConnectBtn.addEventListener('click', async () => {
    if (midiAccess) return;
    setMidiStatus('suche …');
    const result = await openMidiAccess({
      router: midiRouter,
      onInput: (result, event) => {
        if (midiMonitorEl && event && event.data) midiMonitorEl.textContent = describeMessage(event.data);
      },
      onDevices: (devices) => {
        renderMidiDevices(devices);
        setMidiStatus(devices.length ? `${devices.length} In` : 'bereit', 'ok');
      },
    });
    if (!result.ok) {
      setMidiStatus('AUS', 'err');
      toast(result.error, 'warn');
      return;
    }
    midiAccess = result;
    const devices = result.devices();
    renderMidiDevices(devices);
    setMidiStatus(devices.length ? `${devices.length} In` : 'bereit', 'ok');
    if (midiLearnBtn) midiLearnBtn.disabled = false;
    midiConnectBtn.disabled = true;
    toast(devices.length ? 'MIDI verbunden: ' + devices.map((d) => d.name).join(', ') : 'MIDI bereit – kein Gerät gefunden', devices.length ? 'ok' : 'warn');
  });
}

renderMidiBinds();

/* --------------------------------------------------------------- Mix-Mitschnitt */

const bounceBtn = document.getElementById('bounceBtn');
const bounceLoops = document.getElementById('bounceLoops');
let bouncing = false;

async function bounceMix() {
  if (bouncing) return;
  if (!engine.ctx) {
    toast('Erst „AUDIO STARTEN" – der Mitschnitt braucht laufendes Audio', 'warn');
    return;
  }
  if (!canRecord(engine.ctx)) {
    toast('Mitschnitt wird von diesem Browser nicht unterstützt', 'warn');
    return;
  }
  const loops = clamp(Number(bounceLoops && bounceLoops.value) || 1, 1, 8);
  const seconds = mixSeconds(project, loops);
  bouncing = true;
  const label = bounceBtn ? bounceBtn.textContent : '';
  if (bounceBtn) bounceBtn.disabled = true;

  /* Metronom gehört nicht in den Mix: während des Mitschnitts stumm schalten. */
  const metroWasOn = project.metronome;
  project.metronome = false;
  clock.stop();
  clock.panic();
  clock.start();

  let result;
  try {
    result = await recordOutput(engine.ctx, engine.analyser, seconds, {
      onProgress: (p) => {
        if (bounceBtn) bounceBtn.textContent = `rec ${Math.round(p * 100)} %`;
      },
    });
  } finally {
    clock.stop();
    project.metronome = metroWasOn;
    if (bounceBtn) {
      bounceBtn.disabled = false;
      bounceBtn.textContent = label || 'Mix ⤓ WAV';
    }
    bouncing = false;
  }

  if (!result || !result.ok) {
    toast('Mitschnitt fehlgeschlagen: ' + ((result && result.error) || 'unbekannt'), 'err');
    return;
  }

  const wav = await blobToWav(engine.ctx, result.blob);
  if (!wav.ok) {
    toast('WAV-Export fehlgeschlagen: ' + wav.error, 'err');
    return;
  }
  downloadBlob(wav.blob, safeFilename(`${project.name}-mix`, 'wav'));
  toast(`Mix als WAV gespeichert (${seconds.toFixed(1)} s) · Transport gestoppt`, 'ok');
}

if (bounceBtn) bounceBtn.addEventListener('click', bounceMix);

const fileInput = document.getElementById('fileInput');
document.getElementById('loadBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = '';
  if (file) await loadJsonFile(file);
});

document.getElementById('newBtn').addEventListener('click', newProject);

document.getElementById('midiExportBtn').addEventListener('click', () => {
  const repeats = Number(document.getElementById('midiRepeats').value) || 1;
  try {
    const bytes = encodeProject(project, { repeats });
    const ok = downloadBlob(new Blob([bytes], { type: 'audio/midi' }), safeFilename(project.name, 'mid'));
    toast(ok ? `MIDI exportiert (${Math.round(bytes.length / 1024)} KB, ${repeats}× Loop)` : 'Download nicht verfügbar', ok ? 'ok' : 'warn');
  } catch (err) {
    toast('MIDI-Export fehlgeschlagen: ' + err.message, 'warn');
  }
});

const midiInput = document.getElementById('midiInput');
document.getElementById('midiImportBtn').addEventListener('click', () => midiInput.click());
midiInput.addEventListener('change', async () => {
  const file = midiInput.files && midiInput.files[0];
  midiInput.value = '';
  if (!file) return;
  const read = await readBinaryFile(file);
  if (!read.ok) {
    toast(read.error, 'warn');
    return;
  }
  const imported = decodeToProject(read.bytes, {
    name: file.name.replace(/\.(mid|midi)$/i, '') || 'MIDI-Import',
    patches: defaultImportPatches(),
  });
  if (!imported.ok) {
    toast('MIDI-Import abgelehnt: ' + imported.errors.slice(0, 2).join(' · '), 'warn');
    return;
  }
  clock.stop();
  replaceProject(imported.project);
  toast(`MIDI importiert: ${imported.project.tracks.length} Spuren, ${imported.project.bars} Bars`, 'ok');
});

/* ------------------------------------------------------------------ Transport */

const recBtn = document.getElementById('recBtn');
const playBtn = document.getElementById('playBtn');
const recLabel = document.getElementById('recLabel');
const playLabel = document.getElementById('playLabel');
const posDisplay = document.getElementById('posDisplay');
const loopProgress = document.getElementById('loopProgress');
const takeInfo = document.getElementById('takeInfo');
const undoBtn = document.getElementById('undoBtn');
const clearClipBtn = document.getElementById('clearClipBtn');
const metroBtn = document.getElementById('metroBtn');
const bpmVal = document.getElementById('bpmVal');

const loopSeg = createSeg(document.getElementById('segLoop'), {
  options: ['1', '2', '4', '8', '16'].map((v) => ({ v, label: v })),
  value: String(clock.bars),
  onChange: (v) => {
    clock.setBars(Number(v));
    syncTransportUI();
    scheduleSave();
  },
});

const quantSeg = createSeg(document.getElementById('segQuant'), {
  options: [
    { v: '0', label: 'OFF' },
    { v: '60', label: '1/32' },
    { v: '120', label: '1/16' },
    { v: '240', label: '1/8' },
  ],
  value: String(clock.quantizeStep),
  onChange: (v) => {
    clock.setQuantize(Number(v));
    scheduleSave();
  },
});

const swingSlider = createSlider(document.getElementById('swingSlider'), {
  label: 'SWING',
  min: 0,
  max: 0.6,
  value: clock.swing,
  format: (v) => Math.round(v * 100) + '%',
  onChange: (v) => {
    clock.setSwing(v);
    scheduleSave();
  },
});

function syncTransportUI() {
  const track = activeTrack();
  document.body.classList.toggle('is-playing', clock.running);
  document.body.classList.toggle('is-recording', clock.recording);
  recBtn.classList.toggle('on', clock.recording);
  playBtn.classList.toggle('on', clock.running);
  recLabel.textContent = clock.recording ? 'Rec…' : 'Rec';
  playLabel.textContent = clock.running ? 'Stop' : 'Play';
  undoBtn.disabled = !track || track.clip.takeCount === 0;
  clearClipBtn.disabled = !track || track.clip.count === 0;
  metroBtn.classList.toggle('on', clock.metronome);
  bpmVal.textContent = String(clock.bpm);
  takeInfo.textContent = track
    ? `${track.clip.count} Noten · ${track.clip.takeCount} ${track.clip.takeCount === 1 ? 'Take' : 'Takes'}`
    : '–';
  const tag = document.getElementById('trackTag');
  if (tag) tag.textContent = `${project.tracks.length} / ${LIMITS.maxTracks}`;
  loopSeg.set(String(clock.bars));
  quantSeg.set(String(clock.quantizeStep));
  swingSlider.set(clock.swing);
}

clock.onChange(() => {
  trackList.build();
  syncTransportUI();
  scheduleSave();
});

async function togglePlay() {
  await ensureAudio();
  if (!engine.ctx) return;
  if (clock.running) clock.stop();
  else clock.start({ countIn: false });
  syncTransportUI();
}

async function toggleRec() {
  await ensureAudio();
  if (!engine.ctx) return;
  clock.toggleRecord();
  syncTransportUI();
}

playBtn.addEventListener('click', togglePlay);
recBtn.addEventListener('click', toggleRec);

undoBtn.addEventListener('click', () => {
  clock.undo();
  syncTransportUI();
  scheduleSave();
});

clearClipBtn.addEventListener('click', () => {
  if (clock.recording) clock.endRecording();
  clock.clearClip();
  syncTransportUI();
  scheduleSave();
});

metroBtn.addEventListener('click', () => {
  clock.setMetronome(!clock.metronome);
  syncTransportUI();
  scheduleSave();
});

function nudgeBpm(delta) {
  clock.setBpm(clock.bpm + delta);
  bpmVal.textContent = String(clock.bpm);
  scheduleSave();
}
document.getElementById('bpmUp').addEventListener('click', (e) => nudgeBpm(e.shiftKey ? 5 : 1));
document.getElementById('bpmDown').addEventListener('click', (e) => nudgeBpm(e.shiftKey ? -5 : -1));
document.querySelector('.bpm').addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    nudgeBpm(e.deltaY > 0 ? -1 : 1);
  },
  { passive: false }
);

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
    try {
      await engine.init();
      markAudioOn(engine.ctx.state === 'running');
    } catch (err) {
      toast('Audio konnte nicht gestartet werden: ' + err.message, 'warn');
    }
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
    clock.panic();
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
const customOption = document.createElement('option');
customOption.value = '-1';
customOption.textContent = 'Custom';
select.appendChild(customOption);

function syncPresetSelect() {
  const track = activeTrack();
  const index = track ? PRESETS.findIndex((p) => p.name === track.patchName) : 0;
  select.value = String(index >= 0 ? index : -1);
}

function refreshUI() {
  knobs.forEach(({ path, knob }) => knob.set(getIn(getPatch(), path), true));
  segs.forEach(({ path, seg }) => seg.set(getIn(getPatch(), path)));
  masterKnob.set(project.master, true);
  wheel.set(project.modWheel);
  fxKnobs.forEach(({ key, knob }) => knob.set(project.fx[key], true));
  if (fxDivision) fxDivision.value = project.fx.delayDivision;
  matrix.refresh();
  syncPresetSelect();
  updateOctaveLabel();
  refreshInstrumentUi();
  projectNameInput.value = project.name;
}

select.addEventListener('change', () => {
  const index = Number(select.value);
  const preset = PRESETS[index];
  const track = activeTrack();
  if (!preset || !track) return;
  clock.panic();
  track.patch = buildPatch(preset.patch);
  track.patchName = preset.name;
  refreshUI();
  engine.refreshVoices(track.id);
  trackList.build();
  scheduleSave();
  toast(`Patch „${preset.name}" auf ${track.name}`, 'ok');
});

/* ------------------------------------------------------------- Matrix-Aktionen */

document.getElementById('clearBtn').addEventListener('click', () => {
  const patch = getPatch();
  if (patch) patch.matrix = {};
  matrix.refresh();
  scheduleSave();
});

document.getElementById('randBtn').addEventListener('click', () => {
  const patch = getPatch();
  if (!patch) return;
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
  patch.matrix = next;
  matrix.refresh();
  scheduleSave();
});

document.getElementById('panicBtn').addEventListener('click', () => {
  clock.panic();
  pressedKeys.clear();
  keyboard.releaseAll();
});

/* ------------------------------------------------------------------ Loop */

const raf =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(() => cb(0), 16);

let frame = 0;
function loop() {
  raf(loop);
  scope.draw();
  lfo1Preview.draw();
  lfo2Preview.draw();
  strip.draw();
  if ((frame++ & 1) === 0) {
    const activity = engine.activity.get(project.activeTrackId);
    if (activity) matrix.setActivity(activity.src, activity.sums);
    const p = clock.position();
    posDisplay.textContent = p.counting ? '·' + p.countdown : `${p.bar}.${p.beat}.${p.sixteenth}`;
    loopProgress.style.width = (p.running ? p.phase * 100 : 0).toFixed(1) + '%';
  }
}
raf(loop);

/* ------------------------------------------------------------------ Start */

refreshUI();
trackList.build();
syncTransportUI();
renderMidiBinds();
if (restored.ok) {
  setSaveState(`wiederhergestellt ${new Date().toLocaleTimeString('de-DE')}`, 'ok');
} else if (restored.errors && restored.errors.length && !restored.empty) {
  toast('Gespeichertes Projekt verworfen: ' + restored.errors[0], 'warn');
  setSaveState('kein Projekt geladen', 'err');
} else {
  setSaveState('Autosave bereit');
}

setTimeout(() => {
  scope.resize();
  strip.resize();
}, 60);
window.addEventListener('load', () => {
  scope.resize();
  lfo1Preview.resize();
  lfo2Preview.resize();
  strip.resize();
});
window.addEventListener('beforeunload', () => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveNow();
});

console.info('%cSONIC DSP', 'color:#ffb245;font-weight:700', '— Projekt, Spuren und MIDI bereit.');

export { project, engine, clock };
