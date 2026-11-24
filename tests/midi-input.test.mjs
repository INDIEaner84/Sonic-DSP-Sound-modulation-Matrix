import { test, eq, assert, setFile } from './harness.mjs';
import { parseMidiMessage, createMidiRouter, openMidiAccess, describeMessage } from '../js/midi-input.js';
import { createProject, createTrack, applyControl } from '../js/project.js';

setFile('midi-input');

function sample() {
  const t = createTrack({ name: 'A' });
  return createProject({ tracks: [t], activeTrackId: t.id });
}

test('parseMidiMessage liest Noten, CC und Programmwechsel', () => {
  eq(parseMidiMessage(new Uint8Array([0x90, 60, 100])), { type: 'noteOn', channel: 1, note: 60, velocity: 100 });
  eq(parseMidiMessage(new Uint8Array([0x91, 64, 0])), { type: 'noteOff', channel: 2, note: 64, velocity: 0 });
  eq(parseMidiMessage(new Uint8Array([0x8f, 36, 0])), { type: 'noteOff', channel: 16, note: 36, velocity: 0 });
  eq(parseMidiMessage(new Uint8Array([0xb0, 7, 127])), { type: 'cc', channel: 1, cc: 7, value: 127 });
  eq(parseMidiMessage(new Uint8Array([0xc3, 5])), { type: 'program', channel: 4, value: 5 });
  eq(parseMidiMessage(new Uint8Array([0xe0, 0, 64])).type, 'other', 'Pitch Bend wird nicht ausgewertet');
  eq(parseMidiMessage(new Uint8Array([0xf8])), null, 'System-Echtzeit ohne Daten');
  eq(parseMidiMessage(new Uint8Array([60, 100])), null, 'Datenbyte ohne Status');
  eq(parseMidiMessage(null), null);
});

test('Router spielt Noten mit Velocity 0…1', () => {
  const project = sample();
  const notes = [];
  const router = createMidiRouter({
    getProject: () => project,
    onNoteOn: (note, vel, ch) => notes.push(['on', note, Math.round(vel * 127), ch]),
    onNoteOff: (note, ch) => notes.push(['off', note, ch]),
  });
  const on = router.handle(new Uint8Array([0x90, 38, 100]));
  eq(on.handled, true);
  eq(on.type, 'noteOn');
  router.handle(new Uint8Array([0x80, 38, 0]));
  eq(notes, [
    ['on', 38, 100, 1],
    ['off', 38, 1],
  ]);
  eq(router.lastChannel, 1);
});

test('CC-Bindungen wirken auf das Projekt (Kanal und Omni)', () => {
  const project = sample();
  project.midi.binds = [
    { cc: 7, channel: 1, target: 'master' },
    { cc: 74, channel: 0, target: 'fx.delayTone' },
  ];
  const controls = [];
  const router = createMidiRouter({
    getProject: () => project,
    onControl: (target, amount, info) => controls.push([target, Math.round(amount * 127), info.numeric]),
  });

  eq(router.handle(new Uint8Array([0xb0, 7, 0])).handled, true);
  eq(project.master, 0);
  router.handle(new Uint8Array([0xb0, 7, 127]));
  eq(project.master, 1);

  /* Kanal 2 passt nicht auf die Kanal-1-Bindung, aber auf die Omni-Bindung. */
  const foreign = router.handle(new Uint8Array([0xb1, 7, 64]));
  eq(foreign.handled, false);
  const omni = router.handle(new Uint8Array([0xb4, 74, 0]));
  eq(omni.handled, true);
  eq(project.fx.delayTone, 300);

  eq(controls.length, 3);
  eq(controls[0][2], true, 'numerisches Ziel');
});

test('Nicht gebundene CCs und Transportziele werden gemeldet, nicht angewendet', () => {
  const project = sample();
  project.midi.binds = [{ cc: 118, channel: 0, target: 'transport.toggle' }];
  const seen = [];
  const router = createMidiRouter({
    getProject: () => project,
    onControl: (target, amount, info) => seen.push([target, info.numeric]),
  });
  const result = router.handle(new Uint8Array([0xb0, 118, 127]));
  eq(result.handled, true);
  eq(result.target, 'transport.toggle');
  eq(seen, [['transport.toggle', false]]);
  eq(project.master, 0.72, 'Transportziel verändert keine Zahl');
  eq(router.handle(new Uint8Array([0xb0, 3, 5])).handled, false);
});

test('Learn fängt die nächste CC-Nachricht und legt keine Bindung an', () => {
  const project = sample();
  const learned = [];
  const router = createMidiRouter({ getProject: () => project });
  router.startLearn('fx.reverbSize', (bind) => learned.push(bind));
  assert(router.learning);
  const result = router.handle(new Uint8Array([0xb5, 91, 33]));
  eq(result.action, 'learn');
  eq(learned, [{ cc: 91, channel: 6, target: 'fx.reverbSize' }]);
  eq(router.learning, null);
  eq(project.midi.binds.length, 0, 'Learn verändert das Projekt nicht selbst');
  eq(router.handle(new Uint8Array([0xb5, 91, 34])).handled, false, 'zweite Nachricht ohne Learn');
});

test('openMidiAccess meldet fehlende Umgebung', async () => {
  const result = await openMidiAccess({});
  assert(!result.ok);
  assert(result.error.includes('nicht unterstützt'), result.error);
});

test('applyControl bleibt die einzige Wertquelle für Bindungen', () => {
  const project = sample();
  const track = project.tracks[0];
  applyControl(project, 'track.gain', 0.5);
  assert(track.gain > 0 && track.gain < 1.5);
  applyControl(project, 'track.sendDelay', 0);
  eq(track.sends.delay, 0);
});

test('describeMessage erklärt Nachrichten für den Monitor', () => {
  eq(describeMessage(new Uint8Array([0x90, 38, 100])), 'CH 1 · Note 38 · Vel 100');
  eq(describeMessage(new Uint8Array([0x80, 38, 0])), 'CH 1 · Note 38 aus');
  eq(describeMessage(new Uint8Array([0xb9, 74, 96])), 'CH 10 · CC 74 · Wert 96');
  eq(describeMessage(new Uint8Array([0xc0, 12])), 'CH 1 · Program 12');
  eq(describeMessage(new Uint8Array([0xe0, 0, 64])), 'CH 1 · other');
  eq(describeMessage(new Uint8Array([0xf8])), 'unbekannt');
  eq(describeMessage(null), 'unbekannt');
});
