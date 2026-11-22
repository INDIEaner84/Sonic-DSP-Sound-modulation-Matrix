import { test, eq, assert, setFile } from './harness.mjs';
import { Clip } from '../js/clip.js';

setFile('clip');

test('Aufnahme: Take, Note, Dauer', () => {
  const clip = new Clip();
  clip.beginTake();
  clip.startNote(60, 0.8, 0);
  clip.endNote(60, 480, 1920);
  eq(clip.count, 1);
  eq(clip.takeCount, 1);
  eq(clip.events[0].tick, 0);
  eq(clip.events[0].dur, 480);
});

test('Dauer wird am Loop-Ende gekappt', () => {
  const clip = new Clip();
  clip.beginTake();
  clip.startNote(60, 0.8, 1800);
  clip.endNote(60, 10, 1920); // Ende vor Start → bis Loop-Ende
  eq(clip.events[0].dur, 120);
});

test('Offene Note wird beim Take-Ende geschlossen', () => {
  const clip = new Clip();
  clip.beginTake();
  clip.startNote(64, 0.5, 960);
  clip.endTake(1920);
  eq(clip.events[0].dur, 960);
});

test('Overdub: zweiter Take addiert Noten', () => {
  const clip = new Clip();
  clip.beginTake();
  clip.startNote(60, 0.8, 0);
  clip.endNote(60, 240, 1920);
  clip.endTake(1920);

  clip.beginTake();
  clip.startNote(67, 0.7, 480);
  clip.endNote(67, 720, 1920);
  clip.endTake(1920);

  eq(clip.takeCount, 2);
  eq(clip.count, 2);
});

test('Undo entfernt den letzten Take', () => {
  const clip = new Clip();
  for (const note of [60, 62]) {
    clip.beginTake();
    clip.startNote(note, 0.8, 0);
    clip.endNote(note, 240, 1920);
    clip.endTake(1920);
  }
  assert(clip.undo());
  eq(clip.takeCount, 1);
  eq(clip.count, 1);
  eq(clip.events[0].note, 60);
  assert(clip.undo());
  assert(!clip.undo(), 'kein weiterer Take');
  eq(clip.count, 0);
});

test('Clear entfernt alles', () => {
  const clip = new Clip();
  clip.beginTake();
  clip.startNote(60, 0.8, 0);
  clip.clear();
  eq(clip.count, 0);
  eq(clip.takeCount, 0);
  assert(!clip.isRecording);
});

test('toTakes/fromTakes erhält Noten', () => {
  const clip = new Clip();
  clip.addEvents([
    { tick: 0, dur: 120, note: 60, vel: 0.5 },
    { tick: 240, dur: 120, note: 64, vel: 0.9 },
  ]);
  const copy = Clip.fromTakes(clip.toTakes());
  eq(copy.count, 2);
  eq(copy.events[1].note, 64);
  eq(copy.events[1].vel, 0.9);
});

test('eventsInWindow filtert und sortiert', () => {
  const clip = new Clip();
  clip.addEvents([
    { tick: 0, dur: 60, note: 60, vel: 0.5 },
    { tick: 480, dur: 60, note: 62, vel: 0.5 },
    { tick: 960, dur: 60, note: 64, vel: 0.5 },
  ]);
  const res = clip.eventsInWindow(0.4, 2.1, 1 / 480, () => 0);
  eq(res.length, 2);
  eq(res[0].ev.note, 62);
  eq(res[1].ev.note, 64);
});

test('fromTakes toleriert defekte Eingaben', () => {
  const clip = Clip.fromTakes('quatsch');
  eq(clip.count, 0);
  const clip2 = Clip.fromTakes([null, [{ tick: 0, dur: 1, note: 60, vel: 0.5 }], []]);
  eq(clip2.count, 1);
});
