import { test, eq, assert, setFile, near } from './harness.mjs';
import { createProject, createTrack, serialize, deserialize, PPQ } from '../js/project.js';
import { encodeProject, decodeMidi, decodeToProject, defaultImportPatches } from '../js/midi-io.js';

setFile('midi');

function project2Tracks() {
  const bass = createTrack({ name: 'Bass' });
  const keys = createTrack({ name: 'Keys' });
  bass.clip.addEvents([
    { tick: 0, dur: 240, note: 36, vel: 0.9 },
    { tick: 480, dur: 240, note: 43, vel: 0.7 },
    { tick: 960, dur: 120, note: 39, vel: 0.5 },
  ]);
  keys.clip.addEvents([{ tick: 240, dur: 720, note: 64, vel: 0.6 }]);
  return createProject({ name: 'Test Projekt', tracks: [bass, keys], bpm: 128, bars: 2, activeTrackId: bass.id });
}

test('Header ist ein gültiges SMF Format 1 mit PPQ 480', () => {
  const bytes = encodeProject(project2Tracks());
  eq(String.fromCharCode(...bytes.slice(0, 4)), 'MThd');
  eq([...bytes.slice(8, 14)], [0, 1, 0, 3, 0x01, 0xe0]); // format 1, 3 Tracks, 480 PPQ
});

test('Roundtrip: Noten, Ticks, Velocity', () => {
  const project = project2Tracks();
  const bytes = encodeProject(project);
  const parsed = decodeMidi(bytes);
  assert(parsed.ok, parsed.errors.join(', '));
  eq(parsed.ppq, PPQ);
  eq(parsed.bpm, 128);
  eq(parsed.tracks.length, 2);
  eq(parsed.tracks[0].name, 'Bass');
  eq(parsed.tracks[0].notes.length, 3);
  const first = parsed.tracks[0].notes[0];
  eq(first.tick, 0);
  eq(first.dur, 240);
  eq(first.note, 36);
  near(first.vel, 0.9, 0.01);
  eq(parsed.tracks[1].notes[0].tick, 240);
  eq(parsed.tracks[1].notes[0].note, 64);
});

test('Wiederholungen verschieben Noten um die Loop-Länge', () => {
  const project = project2Tracks();
  const bytes = encodeProject(project, { repeats: 3 });
  const parsed = decodeMidi(bytes);
  assert(parsed.ok, parsed.errors.join(', '));
  eq(parsed.tracks[0].notes.length, 9);
  const loop = project.bars * 4 * PPQ;
  const starts = parsed.tracks[0].notes.map((n) => n.tick).sort((a, b) => a - b);
  assert(starts.includes(loop) && starts.includes(loop * 2), 'Noten in Wiederholung fehlen');
});

test('Note über Loop-Ende wird gekappt', () => {
  const track = createTrack({ name: 'T' });
  track.clip.addEvents([{ tick: 4 * PPQ - 60, dur: 240, note: 60, vel: 0.8 }]);
  const project = createProject({ tracks: [track], bars: 1 });
  const parsed = decodeMidi(encodeProject(project));
  assert(parsed.ok, parsed.errors.join(', '));
  eq(parsed.tracks[0].notes[0].dur, 60);
});

test('Import baut Projekt mit Spuren, Patches und Loop-Länge', () => {
  const bytes = encodeProject(project2Tracks());
  const imported = decodeToProject(bytes, { name: 'Import', patches: defaultImportPatches() });
  assert(imported.ok, imported.errors.join(', '));
  eq(imported.project.tracks.length, 2);
  eq(imported.project.bpm, 128);
  // MIDI kennt keine Loop-Länge: sie wird aus dem Notenmaterial abgeleitet
  eq(imported.project.bars, 1);
  eq(imported.project.tracks[0].clip.count, 3);
  eq(imported.project.name, 'Import');
  assert(imported.project.tracks[1].patch.osc1.wave, 'Patch fehlt');
});

test('Import ist wieder serialisierbar und valide', () => {
  const imported = decodeToProject(encodeProject(project2Tracks()));
  const round = deserialize(JSON.stringify(serialize(imported.project)));
  assert(round.ok, round.errors.join(', '));
  eq(round.project.tracks[0].clip.count, 3);
});

test('Running Status wird gelesen', () => {
  // MThd + eine MTrk: Tempo, dann 2 Noten mit Running Status
  const track = [
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // 120 BPM
    0x00, 0x90, 0x3c, 0x64, // Note 60 an
    0x60, 0x3c, 0x00, // Running Status: Note 60 aus (vel 0)
    0x00, 0x90, 0x40, 0x50, // Note 64 an
    0x60, 0x40, 0x00, // aus
    0x00, 0xff, 0x2f, 0x00,
  ];
  const bytes = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, track.length,
    ...track,
  ]);
  const parsed = decodeMidi(bytes);
  assert(parsed.ok, parsed.errors.join(', '));
  eq(parsed.tracks.length, 1);
  eq(parsed.tracks[0].notes.length, 2);
  eq(parsed.tracks[0].notes[0].note, 60);
  eq(parsed.tracks[0].notes[0].dur, 0x60);
  eq(parsed.bpm, 120);
});

test('Sysex und unbekannte Meta-Events werden übersprungen', () => {
  const track = [
    0x00, 0xf0, 0x03, 0x01, 0x02, 0x03,
    0x00, 0xff, 0x7f, 0x02, 0xaa, 0xbb,
    0x00, 0x90, 0x3c, 0x64,
    0x60, 0x80, 0x3c, 0x40,
    0x00, 0xff, 0x2f, 0x00,
  ];
  const bytes = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, track.length,
    ...track,
  ]);
  const parsed = decodeMidi(bytes);
  assert(parsed.ok, parsed.errors.join(', '));
  eq(parsed.tracks[0].notes.length, 1);
});

test('Fehlerfälle werden abgelehnt', () => {
  eq(decodeMidi(new Uint8Array([])).ok, false);
  eq(decodeMidi(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])).ok, false);

  const badHeader = new Uint8Array(14);
  badHeader.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  const r1 = decodeMidi(badHeader);
  assert(!r1.ok && r1.errors[0].includes('MThd'), r1.errors.join(', '));

  const smpte = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0xe7, 0x28,
  ]);
  const r2 = decodeMidi(smpte);
  assert(!r2.ok && r2.errors[0].includes('SMPTE'), r2.errors.join(', '));
});

test('Abgeschnittener Chunk wird erkannt', () => {
  const bytes = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x10, 0x00, 0x00, 0x90, 0x3c, 0x64,
  ]);
  const parsed = decodeMidi(bytes);
  assert(!parsed.ok, 'sollte fehlschlagen');
  assert(parsed.errors.join(' ').includes('Chunk-Länge'), parsed.errors.join(' '));
});

test('Leere MIDI-Datei (nur Tempo) wird abgelehnt', () => {
  const track = [0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, 0x00, 0xff, 0x2f, 0x00];
  const bytes = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, track.length,
    ...track,
  ]);
  const parsed = decodeMidi(bytes);
  assert(!parsed.ok);
  assert(parsed.errors.join(' ').includes('keine Noten'), parsed.errors.join(' '));
});

test('Große Ticks (VLQ) bleiben exakt', () => {
  const track = createTrack({ name: 'T' });
  track.clip.addEvents([{ tick: 15 * 4 * PPQ - 120, dur: 120, note: 72, vel: 0.8 }]);
  const project = createProject({ tracks: [track], bars: 16 });
  const parsed = decodeMidi(encodeProject(project));
  assert(parsed.ok, parsed.errors.join(', '));
  eq(parsed.tracks[0].notes[0].tick, 15 * 4 * PPQ - 120);
});
