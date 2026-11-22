import { test, eq, assert, setFile, near } from './harness.mjs';
import { FakeAudioContext, stopTimer } from './support/fake-audio.mjs';
import { Engine } from '../js/audio.js';
import { Clock } from '../js/clock.js';
import { createProject, createTrack, PPQ } from '../js/project.js';

setFile('clock');

async function setup() {
  const a = createTrack({ name: 'A' });
  const b = createTrack({ name: 'B' });
  a.clip.addEvents([{ tick: 0, dur: 240, note: 36, vel: 0.9 }]);
  b.clip.addEvents([{ tick: 0, dur: 240, note: 64, vel: 0.7 }]);
  const project = createProject({ tracks: [a, b], activeTrackId: a.id, bpm: 120, bars: 2 });
  const engine = new Engine();
  engine.setProject(project);
  const ctx = new FakeAudioContext();
  await engine.init({ context: ctx });
  stopTimer(engine);
  const clock = new Clock(engine, project);
  return { clock, engine, ctx, project, a, b };
}

function startManual(clock) {
  clock.start({ countIn: false });
  if (clock._timer) {
    clearInterval(clock._timer);
    clock._timer = null;
  }
}

test('Start/Stop setzt Zustand und Timer', async () => {
  const { clock } = await setup();
  assert(clock.start({ countIn: false }), 'Start fehlgeschlagen');
  eq(clock.running, true);
  if (clock._timer) {
    clearInterval(clock._timer);
    clock._timer = null;
  }
  clock.stop();
  eq(clock.running, false);
});

test('Loop-Länge und Sekunden folgen dem Projekt', async () => {
  const { clock, project } = await setup();
  eq(clock.loopTicks, 2 * 4 * PPQ);
  near(clock.loopDur, 4, 0.0001); // 2 Takte à 4 Beats à 0,5 s
  project.bpm = 60;
  near(clock.loopDur, 8, 0.0001);
});

test('Scheduler plant Noten aller hörbaren Spuren', async () => {
  const { clock, engine, ctx, a, b } = await setup();
  startManual(clock);
  ctx.currentTime = clock.loopStart - 0.01;
  clock.pump();
  const onA = [...engine.voices].filter((v) => v.track.id === a.id);
  const onB = [...engine.voices].filter((v) => v.track.id === b.id);
  eq(onA.length, 1);
  eq(onB.length, 1);
  near(onA[0].startAt, clock.loopStart, 0.001);
  near(onB[0].startAt, clock.loopStart, 0.001);
});

test('Stumme Spur wird nicht geplant', async () => {
  const { clock, engine, ctx, a, b } = await setup();
  b.mute = true;
  startManual(clock);
  ctx.currentTime = clock.loopStart - 0.01;
  clock.pump();
  eq([...engine.voices].filter((v) => v.track.id === b.id).length, 0);
  eq([...engine.voices].filter((v) => v.track.id === a.id).length, 1);
});

test('Solo unterdrückt die andere Spur im Scheduler', async () => {
  const { clock, engine, ctx, a, b } = await setup();
  b.solo = true;
  startManual(clock);
  ctx.currentTime = clock.loopStart - 0.01;
  clock.pump();
  eq([...engine.voices].filter((v) => v.track.id === a.id).length, 0);
  eq([...engine.voices].filter((v) => v.track.id === b.id).length, 1);
});

test('Kein Doppel-Trigger im selben Fenster', async () => {
  const { clock, engine, ctx } = await setup();
  startManual(clock);
  ctx.currentTime = clock.loopStart - 0.01;
  clock.pump();
  const count = engine.voices.size;
  clock.pump();
  eq(engine.voices.size, count);
});

test('Note wird beim nächsten Loop erneut geplant', async () => {
  const { clock, engine, ctx } = await setup();
  startManual(clock);
  ctx.currentTime = clock.loopStart - 0.01;
  clock.pump();
  const first = [...engine.voices].map((v) => v.startAt).sort();
  ctx.currentTime = clock.loopStart + clock.loopDur - 0.01;
  engine.voices.clear();
  clock.pump();
  const second = [...engine.voices].map((v) => v.startAt).sort();
  assert(second[0] >= clock.loopStart + clock.loopDur - 0.001, 'zweiter Loop nicht geplant');
  eq(first.length, second.length);
});

test('Aufnahme landet in der aktiven Spur', async () => {
  const { clock, ctx, a, b } = await setup();
  clock.start({ countIn: false, record: true });
  if (clock._timer) {
    clearInterval(clock._timer);
    clock._timer = null;
  }
  ctx.currentTime = clock.loopStart + 0.01;
  clock.noteOn(60, 0.9);
  ctx.currentTime = clock.loopStart + 0.25;
  clock.noteOff(60);
  eq(a.clip.count, 2, 'Setup-Note + aufgenommene Note');
  eq(b.clip.count, 1, 'fremde Spur unberührt');

  // Spur wechseln: Aufnahme geht in die andere Spur
  const before = a.clip.count;
  clock.project.activeTrackId = b.id;
  ctx.currentTime = clock.loopStart + 0.6;
  clock.noteOn(72, 0.8);
  ctx.currentTime = clock.loopStart + 0.75;
  clock.noteOff(72);
  eq(a.clip.count, before);
  eq(b.clip.count, 2);
});

test('Aufnahme ignoriert Count-in', async () => {
  const { clock, ctx, a } = await setup();
  const base = a.clip.count;
  clock.start({ countIn: true, record: true });
  if (clock._timer) {
    clearInterval(clock._timer);
    clock._timer = null;
  }
  ctx.currentTime = clock.loopStart - 0.5;
  clock.noteOn(60, 0.9);
  clock.noteOff(60);
  eq(a.clip.count, base, 'Count-in darf nicht aufnehmen');
  ctx.currentTime = clock.loopStart + 0.1;
  clock.noteOn(60, 0.9);
  clock.noteOff(60);
  eq(a.clip.count, base + 1);
});

test('Quantize rastet auf das Raster', async () => {
  const { clock, ctx, a } = await setup();
  clock.setQuantize(120);
  clock.start({ countIn: false, record: true });
  if (clock._timer) {
    clearInterval(clock._timer);
    clock._timer = null;
  }
  const secPerTick = clock.secPerTick;
  ctx.currentTime = clock.loopStart + 100 * secPerTick; // zwischen 2 Rastern
  clock.noteOn(60, 0.9);
  ctx.currentTime = clock.loopStart + 260 * secPerTick;
  clock.noteOff(60);
  eq(a.clip.events[0].tick % 120, 0, 'nicht gerastet: ' + a.clip.events[0].tick);
});

test('Swing verschiebt ungerade Rasterpunkte', async () => {
  const { clock } = await setup();
  eq(clock.swingOffset(0), 0);
  eq(clock.swingOffset(120), 0);
  clock.setSwing(0.4);
  near(clock.swingOffset(120), 0.4 * clock.stepDur, 1e-9);
  eq(clock.swingOffset(240), 0);
});

test('BPM- und Taktwechsel erhalten die Loop-Position', async () => {
  const { clock, ctx } = await setup();
  startManual(clock);
  ctx.currentTime = clock.loopStart + clock.loopDur / 2;
  clock.setBpm(60);
  near(clock.position().phase, 0.5, 0.02, 'Tempo-Wechsel erhält die Tick-Position');
  clock.setBars(4);
  near(clock.position().phase, 0.25, 0.02, 'doppelte Loop-Länge halbiert die Phase');
  near(clock.position().ticks, 1920, 1, 'Tick-Position bleibt erhalten');
  eq(clock.bars, 4);
  eq(clock.bpm, 60);
});

test('Metronom-Klicks werden geplant', async () => {
  const { clock, ctx, a, b } = await setup();
  a.clip.clear();
  b.clip.clear();
  startManual(clock);
  const before = ctx.created.oscillators.length;
  ctx.currentTime = clock.loopStart - 0.01;
  clock.pump();
  assert(ctx.created.oscillators.length > before, 'keine Klicks');
});

test('Metronom aus → keine Klicks', async () => {
  const { clock, ctx, a, b } = await setup();
  a.clip.clear();
  b.clip.clear();
  clock.setMetronome(false);
  startManual(clock);
  const before = ctx.created.oscillators.length;
  ctx.currentTime = clock.loopStart - 0.01;
  clock.pump();
  eq(ctx.created.oscillators.length, before);
});

test('Stop schließt offene Noten und Takes', async () => {
  const { clock, ctx, a } = await setup();
  const base = a.clip.count;
  clock.start({ countIn: false, record: true });
  if (clock._timer) {
    clearInterval(clock._timer);
    clock._timer = null;
  }
  ctx.currentTime = clock.loopStart + 0.01;
  clock.noteOn(60, 0.9); // absichtlich ohne noteOff
  clock.stop();
  eq(a.clip.count, base + 1);
  const last = a.clip.events[a.clip.events.length - 1];
  assert(last.dur > 0, 'Dauer nicht gesetzt');
  eq(a.clip.isRecording, false);
});

test('Undo und Clear arbeiten auf der aktiven Spur', async () => {
  const { clock, a, b } = await setup();
  assert(clock.undo(), 'Undo sollte den Take entfernen');
  eq(a.clip.count, 0);
  eq(b.clip.count, 1);
  clock.clearClip();
  eq(a.clip.count, 0);
  eq(b.clip.count, 1);
});

test('Position liefert Takt/Beat/Phase', async () => {
  const { clock, ctx } = await setup();
  startManual(clock);
  ctx.currentTime = clock.loopStart + 1.1; // 2,2 Beats bei 0,5 s/Beat
  const pos = clock.position();
  eq(pos.bar, 1);
  eq(pos.beat, 3);
  near(pos.phase, 1.1 / clock.loopDur, 0.001);
});
