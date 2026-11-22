import { test, eq, assert, setFile } from './harness.mjs';
import { fakeStorage } from './support/fake-audio.mjs';
import {
  createProject,
  createTrack,
  serialize,
  deserialize,
  validateProject,
  saveLocal,
  loadLocal,
  clearLocal,
  trackAudible,
  loopTicksOf,
  activeTrackOf,
  LIMITS,
  PROJECT_VERSION,
  STORAGE_KEY,
  LEGACY_STORAGE_KEYS,
  SEND_DEFAULTS,
  FX_DEFAULTS,
  DELAY_DIVISIONS,
  delaySeconds,
  PPQ,
} from '../js/project.js';
import { buildPatch } from '../js/state.js';

setFile('project');

function sampleProject() {
  const t1 = createTrack({ name: 'Bass', patchName: 'Wobble Bass', patch: { filter: { cutoff: 420 } } });
  const t2 = createTrack({ name: 'Keys', patchName: 'Drift Pad' });
  t1.clip.addEvents([
    { tick: 0, dur: 240, note: 36, vel: 0.9 },
    { tick: 480, dur: 240, note: 43, vel: 0.7 },
  ]);
  t2.clip.addEvents([{ tick: 240, dur: 480, note: 64, vel: 0.6 }]);
  return createProject({ name: 'Test', tracks: [t1, t2], bpm: 128, bars: 2, activeTrackId: t1.id });
}

test('Projekt serialisiert und validiert verlustfrei', () => {
  const project = sampleProject();
  const round = deserialize(JSON.stringify(serialize(project)));
  assert(round.ok, round.errors.join(', '));
  eq(round.project.tracks.length, 2);
  eq(round.project.bpm, 128);
  eq(round.project.bars, 2);
  eq(round.project.tracks[0].name, 'Bass');
  eq(round.project.tracks[0].patchName, 'Wobble Bass');
  eq(round.project.tracks[0].patch.filter.cutoff, 420);
  eq(round.project.tracks[0].clip.count, 2);
  eq(round.project.tracks[1].clip.events[0].note, 64);
  eq(round.project.activeTrackId, project.activeTrackId);
});

test('Serialisierung ist JSON-sicher und stabil', () => {
  const project = sampleProject();
  const a = JSON.stringify(serialize(project));
  const b = JSON.stringify(serialize(deserialize(a).project));
  eq(a, b, 'Serialisierung nicht idempotent');
});

test('Loop-Länge folgt bars', () => {
  const project = sampleProject();
  eq(loopTicksOf(project), 2 * 4 * PPQ);
});

test('trackAudible: Mute und Solo', () => {
  const a = createTrack({ name: 'A' });
  const b = createTrack({ name: 'B' });
  const tracks = [a, b];
  assert(trackAudible(a, tracks), 'A sollte hörbar sein');
  a.mute = true;
  assert(!trackAudible(a, tracks), 'A ist stumm');
  b.solo = true;
  assert(!trackAudible(a, tracks), 'A bleibt stumm');
  assert(trackAudible(b, tracks), 'B ist solo');
  b.mute = true;
  assert(!trackAudible(b, tracks), 'stumm schlägt solo');
});

test('activeTrackOf fällt auf erste Spur zurück', () => {
  const project = sampleProject();
  project.activeTrackId = 'gibtsnicht';
  eq(activeTrackOf(project).name, 'Bass');
});

test('Unbekannte Version wird abgelehnt', () => {
  const result = validateProject({ version: 99, tracks: [] });
  assert(!result.ok);
  assert(result.errors[0].toLowerCase().includes('version 99'), result.errors[0]);
});

test('Version 1 wird migriert und mit Defaults ergänzt', () => {
  const raw = serialize(sampleProject());
  raw.version = 1;
  delete raw.fx;
  for (const t of raw.tracks) delete t.sends;
  const result = deserialize(JSON.stringify(raw));
  assert(result.ok, result.errors.join(' | '));
  eq(result.migratedFrom, 1);
  eq(result.project.version, 2);
  eq(result.project.fx.delayDivision, '1/8');
  eq(result.project.tracks[0].sends.delay, SEND_DEFAULTS.delay);
  assert(result.warnings.some((w) => w.includes('Projektversion 1')), result.warnings.join(' | '));
});

test('Unbekannte Matrix-Route wird abgelehnt', () => {
  const track = createTrack({ name: 'X' });
  const raw = serialize(createProject({ tracks: [track] }));
  raw.tracks[0].patch.matrix = { 'lfo9:cutoff': 20 };
  const result = validateProject(raw);
  assert(!result.ok, 'sollte fehlschlagen');
  assert(result.errors.join(' ').includes('unbekannte Route'), result.errors.join(' '));
});

test('Matrix-Werte außerhalb −100…100 werden abgelehnt', () => {
  const raw = serialize(createProject({ tracks: [createTrack({ name: 'X' })] }));
  raw.tracks[0].patch.matrix = { 'lfo1:cutoff': 140 };
  const result = validateProject(raw);
  assert(!result.ok);
  assert(result.errors[0].includes('−100…100'), result.errors[0]);
});

test('Patch-Enum und -Bereich werden geprüft', () => {
  const raw = serialize(createProject({ tracks: [createTrack({ name: 'X' })] }));
  raw.tracks[0].patch.osc1.wave = 'saegewerk';
  raw.tracks[0].patch.filter.cutoff = 999999;
  const result = validateProject(raw);
  assert(!result.ok);
  assert(result.errors.some((e) => e.includes('nicht erlaubt')), result.errors.join(' | '));
  assert(result.errors.some((e) => e.includes('außerhalb')), result.errors.join(' | '));
});

test('Note außerhalb des Loops wird abgelehnt', () => {
  const raw = serialize(createProject({ tracks: [createTrack({ name: 'X' })], bars: 1 }));
  raw.tracks[0].takes = [[{ tick: 4 * 480, dur: 10, note: 60, vel: 0.5 }]];
  const result = validateProject(raw);
  assert(!result.ok);
  assert(result.errors[0].includes('tick'), result.errors[0]);
});

test('Ungültige Note/Dauer/Velocity werden abgelehnt', () => {
  const raw = serialize(createProject({ tracks: [createTrack({ name: 'X' })] }));
  raw.tracks[0].takes = [[{ tick: 0, dur: 0, note: 200, vel: 3 }]];
  const result = validateProject(raw);
  assert(!result.ok);
  eq(result.errors.length, 3, 'drei Feldfehler erwartet: ' + result.errors.join(' | '));
});

test('Zu viele Spuren werden abgelehnt', () => {
  const tracks = Array.from({ length: LIMITS.maxTracks + 1 }, (_, i) => createTrack({ name: `T${i}` }));
  const result = validateProject(serialize(createProject({ tracks })));
  assert(!result.ok);
  assert(result.errors.join(' ').includes('mehr als'), result.errors.join(' '));
});

test('Projekt ohne Spuren wird abgelehnt', () => {
  const result = validateProject({ version: PROJECT_VERSION, tracks: [] });
  assert(!result.ok);
  assert(result.errors.join(' ').includes('mindestens eine Spur'), result.errors.join(' '));
});

test('BPM/Bars-Grenzen', () => {
  const base = serialize(createProject({ tracks: [createTrack({ name: 'X' })] }));
  eq(validateProject({ ...base, bpm: 39 }).ok, false);
  eq(validateProject({ ...base, bpm: 241 }).ok, false);
  eq(validateProject({ ...base, bars: 0 }).ok, false);
  eq(validateProject({ ...base, bars: 17 }).ok, false);
  eq(validateProject({ ...base, bpm: 40 }).ok, true);
  eq(validateProject({ ...base, bpm: 240, bars: 16 }).ok, true);
});

test('Kaputtes JSON und zu große Eingaben werden abgelehnt', () => {
  assert(!deserialize('{ kaputt').ok);
  assert(!deserialize('null').ok);
  const big = 'x'.repeat(LIMITS.maxFileBytes + 1);
  const result = deserialize(big);
  assert(!result.ok);
  assert(result.errors[0].includes('größer'), result.errors[0]);
});

test('Unbekannte Felder erzeugen Warnungen statt Fehler', () => {
  const raw = serialize(createProject({ tracks: [createTrack({ name: 'X' })] }));
  raw.zukunft = { foo: 1 };
  raw.tracks[0].patch.osc1.extra = true;
  const result = validateProject(raw);
  assert(result.ok, result.errors.join(', '));
  assert(result.warnings.length >= 1, 'Warnung erwartet');
});

test('Speichern und Laden über Storage', () => {
  const storage = fakeStorage();
  const project = sampleProject();
  const saved = saveLocal(project, storage);
  assert(saved.ok, saved.error);
  const loaded = loadLocal(storage);
  assert(loaded.ok, (loaded.errors || []).join(', '));
  eq(loaded.project.tracks[0].clip.count, 2);
  clearLocal(storage);
  const empty = loadLocal(storage);
  assert(!empty.ok && empty.empty);
});

test('Defekter Storage-Inhalt wird erkannt, nicht übernommen', () => {
  const storage = fakeStorage({ [STORAGE_KEY]: '{"version":1,"tracks":"nein"}' });
  const loaded = loadLocal(storage);
  assert(!loaded.ok);
  assert(loaded.errors.length > 0);
});

test('buildPatch ergänzt fehlende Felder', () => {
  const p = buildPatch({ filter: { cutoff: 1234 } });
  eq(p.filter.cutoff, 1234);
  eq(p.ampEnv.a, 0.01);
  eq(Object.keys(p.matrix).length, 6);
  assert(!('master' in p), 'master gehört ins Projekt, nicht in den Patch');
});

test('Sends und FX überleben den Roundtrip', () => {
  const project = sampleProject();
  project.tracks[0].sends = { delay: 0.65, reverb: 0.1 };
  project.fx = { ...FX_DEFAULTS, delayDivision: '3/8', delayFeedback: 0.5, reverbSize: 4.5 };
  const back = deserialize(JSON.stringify(serialize(project)));
  assert(back.ok, back.errors.join(' | '));
  eq(back.project.tracks[0].sends, { delay: 0.65, reverb: 0.1 });
  eq(back.project.fx.delayDivision, '3/8');
  eq(back.project.fx.delayFeedback, 0.5);
  eq(back.project.fx.reverbSize, 4.5);
  eq(back.project.tracks[1].sends, SEND_DEFAULTS);
});

test('Sends außerhalb 0…1 und unbekannte FX-Werte werden abgelehnt', () => {
  const raw = serialize(sampleProject());
  raw.tracks[0].sends.delay = 1.4;
  raw.fx.delayDivision = '1/3';
  raw.fx.reverbSize = 99;
  const result = validateProject(raw);
  assert(!result.ok);
  const all = result.errors.join(' | ');
  assert(all.includes('sends.delay'), all);
  assert(all.includes('delayDivision'), all);
  assert(all.includes('reverbSize'), all);
});

test('Unbekannte Sends und FX-Felder warnen, ohne abzulehnen', () => {
  const raw = serialize(sampleProject());
  raw.tracks[0].sends.chorus = 0.5;
  raw.fx.phaser = 1;
  const result = validateProject(raw);
  assert(result.ok, result.errors.join(' | '));
  const warnings = result.warnings.join(' | ');
  assert(warnings.includes('sends.chorus'), warnings);
  assert(warnings.includes('fx.phaser'), warnings);
});

test('Alter Autosave-Schlüssel wird gelesen und beim Speichern ersetzt', () => {
  const project = sampleProject();
  const old = serialize(project);
  old.version = 1;
  delete old.fx;
  for (const t of old.tracks) delete t.sends;
  const storage = fakeStorage({ [LEGACY_STORAGE_KEYS[0]]: JSON.stringify(old) });

  const loaded = loadLocal(storage);
  assert(loaded.ok, loaded.errors.join(' | '));
  eq(loaded.legacyKey, true);
  eq(loaded.migratedFrom, 1);

  assert(saveLocal(loaded.project, storage).ok);
  eq(storage.getItem(LEGACY_STORAGE_KEYS[0]), null);
  assert(storage.getItem(STORAGE_KEY), 'neuer Schlüssel fehlt');
});

test('delaySeconds rechnet Raster über das Tempo', () => {
  const project = createProject({ bpm: 120, tracks: [createTrack({ name: 'X' })] });
  eq(delaySeconds(project), 0.25);
  project.fx.delayDivision = '1/4';
  eq(delaySeconds(project), 0.5);
  project.fx.delayDivision = '3/8';
  eq(delaySeconds(project), 0.75);
  project.bpm = 60;
  eq(delaySeconds(project), 1.5);
  project.fx.delayDivision = 'unbekannt';
  eq(delaySeconds(project), 0.5, 'unbekanntes Raster fällt auf 1/8 zurück');
});
