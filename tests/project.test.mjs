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
  applyControl,
  isNumericTarget,
  MIDI_TARGETS,
  INSTRUMENTS,
  PPQ,
  createScene,
  ensureSceneClips,
  activeClipOf,
  clipOf,
  playOrder,
  sceneIdAtLoop,
  SCENE_NAMES,
  SAMPLE_DEFAULTS,
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
  eq(result.project.version, PROJECT_VERSION);
  eq(result.project.fx.delayDivision, '1/8');
  eq(result.project.tracks[0].sends.delay, SEND_DEFAULTS.delay);
  eq(result.project.tracks[0].instrument, 'synth');
  eq(result.project.tracks[0].insert, { drive: 0 });
  eq(result.project.midi.binds, []);
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
  raw.tracks[0].clips[raw.activeSceneId] = [[{ tick: 4 * 480, dur: 10, note: 60, vel: 0.5 }]];
  const result = validateProject(raw);
  assert(!result.ok);
  assert(result.errors[0].includes('tick'), result.errors[0]);
});

test('Ungültige Note/Dauer/Velocity werden abgelehnt', () => {
  const raw = serialize(createProject({ tracks: [createTrack({ name: 'X' })] }));
  raw.tracks[0].clips[raw.activeSceneId] = [[{ tick: 0, dur: 0, note: 200, vel: 3 }]];
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

/* ------------------------------------------------- Instrumente & MIDI (v3) */

test('Instrumente werden validiert und serialisiert', () => {
  const drums = createTrack({ name: 'Drums', instrument: 'drums' });
  const piano = createTrack({ name: 'Keys', instrument: 'piano' });
  const project = createProject({ tracks: [drums, piano], activeTrackId: drums.id });
  const back = deserialize(JSON.stringify(serialize(project)));
  assert(back.ok, back.errors.join(' | '));
  eq(back.project.tracks.map((t) => t.instrument), ['drums', 'piano']);

  const raw = serialize(project);
  raw.tracks[0].instrument = 'theremin';
  const bad = validateProject(raw);
  assert(!bad.ok);
  assert(bad.errors.join(' ').includes('instrument'), bad.errors.join(' | '));

  const missing = serialize(project);
  delete missing.tracks[0].instrument;
  const defaults = validateProject(missing);
  assert(defaults.ok, defaults.errors.join(' | '));
  eq(defaults.project.tracks[0].instrument, 'synth', 'fehlendes Instrument → synth');
});

test('MIDI-Bindungen werden geprüft', () => {
  const base = () => serialize(sampleProject());

  const ok = base();
  ok.midi = { binds: [{ cc: 7, channel: 1, target: 'master' }, { cc: 74, channel: 0, target: 'fx.delayTone' }] };
  const good = validateProject(ok);
  assert(good.ok, good.errors.join(' | '));
  eq(good.project.midi.binds.length, 2);
  eq(good.project.midi.binds[1].channel, 0);

  const bad = base();
  bad.midi = {
    binds: [
      { cc: 200, channel: 1, target: 'master' },
      { cc: 7, channel: 99, target: 'master' },
      { cc: 8, channel: 1, target: 'gibtsnicht' },
    ],
  };
  const badResult = validateProject(bad);
  assert(!badResult.ok);
  const all = badResult.errors.join(' | ');
  assert(all.includes('cc'), all);
  assert(all.includes('channel'), all);
  assert(all.includes('gibtsnicht'), all);

  const dup = base();
  dup.midi = { binds: [{ cc: 7, channel: 0, target: 'master' }, { cc: 7, channel: 0, target: 'modWheel' }] };
  const dupResult = validateProject(dup);
  assert(dupResult.ok, dupResult.errors.join(' | '));
  assert(dupResult.warnings.some((w) => w.includes('doppelt')), dupResult.warnings.join(' | '));
  eq(dupResult.project.midi.binds.length, 2);

  const tooMany = base();
  tooMany.midi = { binds: Array.from({ length: LIMITS.maxMidiBinds + 1 }, (_, i) => ({ cc: i, channel: 0, target: 'master' })) };
  assert(!validateProject(tooMany).ok);
});

test('applyControl rechnet CC-Werte auf Ziele', () => {
  const project = sampleProject();
  const master = applyControl(project, 'master', 0.5);
  assert(master.ok);
  eq(project.master, 0.5);

  applyControl(project, 'fx.delayFeedback', 1);
  eq(project.fx.delayFeedback, LIMITS.maxDelayFeedback);
  applyControl(project, 'fx.delayFeedback', 0);
  eq(project.fx.delayFeedback, 0);

  applyControl(project, 'fx.delayTone', 0);
  eq(project.fx.delayTone, LIMITS.minDelayTone);
  applyControl(project, 'fx.delayTone', 1);
  eq(project.fx.delayTone, LIMITS.maxDelayTone);
  const mid = applyControl(project, 'fx.delayTone', 0.5).value;
  assert(mid > LIMITS.minDelayTone && mid < LIMITS.maxDelayTone, 'log-Kurve liegt dazwischen');
  assert(Math.abs(mid - (LIMITS.minDelayTone + LIMITS.maxDelayTone) / 2) > 100, 'log ≠ linear');

  const active = activeTrackOf(project);
  applyControl(project, 'track.gain', 1);
  eq(active.gain, LIMITS.maxGain);
  applyControl(project, 'track.sendReverb', 0.25);
  eq(active.sends.reverb, 0.25);

  eq(applyControl(project, 'gibtsnicht', 0.5).ok, false);
  eq(isNumericTarget('transport.play'), false);
  eq(isNumericTarget('master'), true);
  assert(applyControl(project, 'master', 5).value === 1, 'Werte über 1 werden geklemmt');
});

test('Insert (Drive) wird validiert, migriert und serialisiert', () => {
  const track = createTrack({ name: 'Crunch', insert: { drive: 0.35 } });
  const project = createProject({ tracks: [track], activeTrackId: track.id });
  const back = deserialize(JSON.stringify(serialize(project)));
  assert(back.ok, back.errors.join(' | '));
  eq(back.project.tracks[0].insert.drive, 0.35);

  const raw = serialize(project);
  raw.tracks[0].insert.drive = 2;
  const bad = validateProject(raw);
  assert(!bad.ok);
  assert(bad.errors.join(' ').includes('insert.drive'), bad.errors.join(' | '));

  const warn = serialize(project);
  warn.tracks[0].insert.chorus = 1;
  const warned = validateProject(warn);
  assert(warned.ok, warned.errors.join(' | '));
  assert(warned.warnings.some((w) => w.includes('insert.chorus')), warned.warnings.join(' | '));

  const v3 = serialize(project);
  v3.version = 3;
  delete v3.tracks[0].insert;
  const migrated = deserialize(JSON.stringify(v3));
  assert(migrated.ok, migrated.errors.join(' | '));
  eq(migrated.migratedFrom, 3);
  eq(migrated.project.tracks[0].insert.drive, 0);
});


test('Projekt startet mit Szene A im Loop-Modus', () => {
  const track = createTrack({ name: 'Lead' });
  const project = createProject({ tracks: [track] });
  eq(project.scenes.length, 1);
  eq(project.scenes[0].name, 'A');
  eq(project.activeSceneId, project.scenes[0].id);
  eq(project.song.enabled, false);
  eq([...project.song.chain], [project.activeSceneId]);
  assert(track.clips[project.activeSceneId], 'Clip für Szene A fehlt');
  eq(track.clip, track.clips[project.activeSceneId], 'clip-Alias zeigt auf die aktive Szene');
  eq(SCENE_NAMES.length, 8);
});

test('Szenen halten getrennte Clips und teilen sich das Tempo', () => {
  const track = createTrack({ name: 'Lead' });
  const project = createProject({ tracks: [track], bars: 1 });
  const sceneB = createScene('B');
  project.scenes.push(sceneB);
  ensureSceneClips(track, project.scenes);

  const clipA = activeClipOf(project, track);
  clipA.addEvents([{ tick: 0, dur: 120, note: 60, vel: 0.8 }]);
  const clipB = clipOf(project, track, sceneB.id);
  clipB.addEvents([{ tick: 240, dur: 120, note: 67, vel: 0.6 }]);

  eq(clipA.count, 1);
  eq(clipB.count, 1);
  eq(clipA.events[0].note, 60);
  eq(clipB.events[0].note, 67);

  project.activeSceneId = sceneB.id;
  eq(track.clip, clipB, 'Alias folgt der aktiven Szene');
  eq(activeClipOf(project, track).events[0].note, 67);
});

test('Song-Kette bestimmt die Loop-Reihenfolge', () => {
  const track = createTrack({ name: 'Lead' });
  const project = createProject({ tracks: [track] });
  const sceneB = createScene('B');
  project.scenes.push(sceneB);
  ensureSceneClips(track, project.scenes);

  eq(sceneIdAtLoop(project, 0), project.scenes[0].id, 'ohne Song nur aktive Szene');
  eq(sceneIdAtLoop(project, 5), project.scenes[0].id);
  eq([...playOrder(project)], [project.activeSceneId], 'playOrder ohne Song = eine Szene');

  project.song.enabled = true;
  project.song.chain = [project.scenes[0].id, sceneB.id, sceneB.id];
  eq(sceneIdAtLoop(project, 0), project.scenes[0].id);
  eq(sceneIdAtLoop(project, 1), sceneB.id);
  eq(sceneIdAtLoop(project, 2), sceneB.id);
  eq(sceneIdAtLoop(project, 3), project.scenes[0].id, 'Kette läuft weiter');
  eq([...playOrder(project)], project.song.chain);
});

test('Szenen und Song überleben Serialisierung und Validierung', () => {
  const track = createTrack({ name: 'Lead' });
  const project = createProject({ tracks: [track], bars: 1 });
  const sceneB = createScene('B');
  project.scenes.push(sceneB);
  ensureSceneClips(track, project.scenes);
  clipOf(project, track, sceneB.id).addEvents([{ tick: 0, dur: 240, note: 62, vel: 0.5 }]);

  const raw = serialize(project);
  eq(raw.version, PROJECT_VERSION);
  eq(raw.scenes.length, 2);
  eq(raw.tracks[0].takes, undefined, 'v5 schreibt kein takes-Feld mehr');
  assert(Array.isArray(raw.tracks[0].clips[sceneB.id]));

  const back = deserialize(JSON.stringify(raw));
  assert(back.ok, back.errors.join(' | '));
  const reloaded = back.project;
  eq(reloaded.scenes.length, 2);
  eq(activeClipOf(reloaded, reloaded.tracks[0]).count, 0);
  eq(clipOf(reloaded, reloaded.tracks[0], sceneB.id).count, 1);
  eq(reloaded.tracks[0].clip.count, 0);
});

test('Ungültige Szenen und Ketten werden abgelehnt', () => {
  const track = createTrack({ name: 'Lead' });
  const project = createProject({ tracks: [track] });

  const noScene = serialize(project);
  noScene.scenes = [];
  noScene.activeSceneId = 'scn-Z';
  const r1 = validateProject(noScene);
  assert(!r1.ok, 'leere Szenenliste muss abgelehnt werden');

  const unknownActive = serialize(project);
  unknownActive.activeSceneId = 'scn-Z';
  const r2 = validateProject(unknownActive);
  assert(r2.ok, r2.errors.join(' | '));
  eq(r2.project.activeSceneId, r2.project.scenes[0].id, 'unbekannte aktive Szene fällt auf die erste zurück');
  assert(r2.warnings.some((w) => w.includes('activeSceneId')), r2.warnings.join(' | '));

  const badChain = serialize(project);
  badChain.song = { enabled: true, chain: ['scn-Z'] };
  const r3 = validateProject(badChain);
  assert(r3.ok, r3.errors.join(' | '));
  eq([...r3.project.song.chain], [r3.project.activeSceneId], 'unbekannte Ketten-Schritte fliegen raus');
  assert(r3.warnings.some((w) => w.includes('song.chain')), r3.warnings.join(' | '));

  const tooMany = serialize(project);
  tooMany.scenes = SCENE_NAMES.concat(['I']).map((name, i) => ({ id: `scn-${name}`, name }));
  const r4 = validateProject(tooMany);
  assert(!r4.ok, 'mehr als 8 Szenen müssen abgelehnt werden');

  const missingClip = serialize(project);
  delete missingClip.tracks[0].clips[project.activeSceneId];
  const r5 = validateProject(missingClip);
  assert(r5.ok, r5.errors.join(' | '));
  eq(r5.project.tracks[0].clips[project.activeSceneId].count, 0, 'fehlender Szenen-Clip wird leer ergänzt');
});

test('v4 (takes) wird auf v5 (clips) migriert', () => {
  const track = createTrack({ name: 'Lead' });
  const project = createProject({ tracks: [track], bars: 1 });
  const v4 = serialize(project);
  v4.version = 4;
  v4.tracks[0].takes = [[{ tick: 0, dur: 240, note: 64, vel: 0.8 }]];
  delete v4.tracks[0].clips;
  delete v4.scenes;
  delete v4.activeSceneId;
  delete v4.song;

  const back = deserialize(JSON.stringify(v4));
  assert(back.ok, back.errors.join(' | '));
  eq(back.migratedFrom, 4);
  eq(back.project.version, PROJECT_VERSION);
  eq(back.project.scenes.length, 1);
  eq(back.project.song.enabled, false);
  eq([...back.project.song.chain], [back.project.activeSceneId]);
  eq(back.project.tracks[0].clips[back.project.activeSceneId].count, 1);
  eq(back.project.tracks[0].clip.count, 1);
  eq(back.project.tracks[0].clip.events[0].note, 64);
});


test('SF2-Sample-Referenz wird gespeichert, geprüft und migriert', () => {
  assert(INSTRUMENTS.some((i) => i.id === 'sf2'), 'SF2 muss ein wählbares Instrument sein');

  const track = createTrack({ name: 'Strings', instrument: 'sf2' });
  eq(track.sample, { ...SAMPLE_DEFAULTS }, 'neue Spur startet ohne Sample-Referenz');
  track.sample = { preset: 'Strings', name: 'MeinFont.sf2', program: 48, bank: 0 };

  const project = createProject({ tracks: [track] });
  const raw = serialize(project);
  eq(raw.tracks[0].instrument, 'sf2');
  eq(raw.tracks[0].sample.preset, 'Strings');
  eq(raw.tracks[0].sample.program, 48);

  const back = deserialize(JSON.stringify(raw));
  assert(back.ok, back.errors.join(' | '));
  eq(back.project.tracks[0].sample.preset, 'Strings');
  eq(back.project.tracks[0].sample.name, 'MeinFont.sf2');
  eq(back.project.tracks[0].instrument, 'sf2');

  const bad = serialize(project);
  bad.tracks[0].sample.program = 200;
  const badResult = validateProject(bad);
  assert(!badResult.ok, 'Programm außerhalb 0…127 muss abgelehnt werden');
  assert(badResult.errors.join(' ').includes('sample.program'), badResult.errors.join(' | '));

  const unknown = serialize(project);
  unknown.tracks[0].sample.attack = 1;
  const warned = validateProject(unknown);
  assert(warned.ok, warned.errors.join(' | '));
  assert(warned.warnings.some((w) => w.includes('sample.attack')), warned.warnings.join(' | '));

  /* v5 → v6: Sample-Feld wird additiv ergänzt, Szenen bleiben. */
  const v5 = serialize(project);
  v5.version = 5;
  delete v5.tracks[0].sample;
  const migrated = deserialize(JSON.stringify(v5));
  assert(migrated.ok, migrated.errors.join(' | '));
  eq(migrated.migratedFrom, 5);
  eq(migrated.project.version, PROJECT_VERSION);
  eq(migrated.project.tracks[0].sample, { ...SAMPLE_DEFAULTS });
  eq(migrated.project.tracks[0].instrument, 'sf2', 'Instrument bleibt erhalten');
  eq(migrated.project.scenes.length, 1);
});
