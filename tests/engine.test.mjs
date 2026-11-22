import { test, eq, assert, setFile, near } from './harness.mjs';
import { FakeAudioContext, stopTimer } from './support/fake-audio.mjs';
import { Engine } from '../js/audio.js';
import { createProject, createTrack } from '../js/project.js';

setFile('engine');

async function setup() {
  const a = createTrack({ name: 'A' });
  const b = createTrack({ name: 'B' });
  b.patch.filter.cutoff = 3000;
  const project = createProject({ tracks: [a, b], activeTrackId: a.id });
  const engine = new Engine();
  engine.setProject(project);
  const ctx = new FakeAudioContext();
  await engine.init({ context: ctx });
  stopTimer(engine);
  return { engine, ctx, project, a, b };
}

test('Engine initialisiert ohne window/DOM', async () => {
  const { engine, ctx } = await setup();
  assert(engine.ctx === ctx);
  assert(ctx.created.analysers === 1, 'Analyser fehlt');
  eq(engine.chains.size, 2);
});

test('Spurkette wird angelegt und verbunden', async () => {
  const { engine, ctx, a } = await setup();
  const chain = engine.chains.get(a.id);
  assert(chain, 'Kette fehlt');
  assert(chain.gain.connections.includes(engine.bus), 'Spur nicht am Bus');
  assert(chain.input.connections.includes(chain.pan), 'input→pan fehlt');
});

test('noteOn trifft die richtige Spur', async () => {
  const { engine, ctx, a, b } = await setup();
  const v1 = engine.noteOn(a.id, 60, 0.8);
  const v2 = engine.noteOn(b.id, 72, 0.6);
  assert(v1 && v2);
  eq(v1.track.id, a.id);
  eq(v2.track.id, b.id);
  ctx.advance(0.02);
  engine.tick();
  assert(engine.activity.has(a.id) && engine.activity.has(b.id), 'Aktivität je Spur fehlt');
  assert(v1.vca.gain.value > 0, 'VCA offen');
});

test('Unbekannte Spur liefert keine Stimme', async () => {
  const { engine } = await setup();
  eq(engine.noteOn('gibtsnicht', 60, 0.8), null);
});

test('Geplante Note startet erst zur Startzeit', async () => {
  const { engine, ctx, a } = await setup();
  const v = engine.noteOn(a.id, 60, 0.8, ctx.currentTime + 0.5);
  ctx.advance(0.1);
  engine.tick();
  eq(v.triggered, false);
  eq(v.osc1.startedAt, 0.5);
  ctx.advance(0.45);
  engine.tick();
  eq(v.triggered, true);
});

test('scheduleRelease beendet die Note zur geplanten Zeit', async () => {
  const { engine, ctx, a } = await setup();
  const v = engine.noteOn(a.id, 60, 0.8, 0);
  engine.scheduleRelease(v, 0.2);
  ctx.advance(0.05);
  engine.tick();
  eq(v.released, false);
  ctx.advance(0.3);
  engine.tick();
  eq(v.released, true);
});

test('Mute setzt den Spurgain auf 0', async () => {
  const { engine, ctx, a } = await setup();
  a.mute = true;
  ctx.advance(0.05);
  engine.tick();
  near(engine.chains.get(a.id).gain.gain.value, 0, 0.0001);
});

test('Solo unterdrückt andere Spuren, aber nicht die Solo-Spur', async () => {
  const { engine, ctx, a, b } = await setup();
  b.solo = true;
  ctx.advance(0.05);
  engine.tick();
  near(engine.chains.get(a.id).gain.gain.value, 0, 0.0001);
  near(engine.chains.get(b.id).gain.gain.value, 0.8, 0.0001);
});

test('Spurpegel wird angewendet', async () => {
  const { engine, ctx, a } = await setup();
  a.gain = 0.35;
  ctx.advance(0.05);
  engine.tick();
  near(engine.chains.get(a.id).gain.gain.value, 0.35, 0.0001);
});

test('Master-Pegel folgt dem Projekt', async () => {
  const { engine, ctx, project } = await setup();
  project.master = 0.4;
  ctx.advance(0.05);
  engine.tick();
  near(engine.master.gain.value, 0.4, 0.0001);
});

test('Gelöschte Spur wird entfernt und gibt Stimmen frei', async () => {
  const { engine, ctx, project, b } = await setup();
  const voice = engine.noteOn(b.id, 60, 0.8);
  project.tracks = project.tracks.filter((t) => t.id !== b.id);
  engine.syncTracks();
  ctx.advance(0.01);
  eq(engine.chains.has(b.id), false);
  eq(voice.released, true);
});

test('Stimmen-Deckel greift und stiehlt die älteste Stimme', async () => {
  const { engine, ctx, a } = await setup();
  engine.maxVoices = 3;
  const voices = [];
  for (let i = 0; i < 4; i++) {
    voices.push(engine.noteOn(a.id, 60 + i, 0.8));
    ctx.advance(0.01);
  }
  eq(voices[0].released, true, 'älteste Stimme sollte freigegeben sein');
  eq(voices[3].released, false, 'neueste Stimme muss klingen');
});

test('Metronom erzeugt Klick-Knoten', async () => {
  const { engine, ctx } = await setup();
  const before = ctx.created.oscillators.length;
  engine.click(ctx.currentTime + 0.1, true);
  eq(ctx.created.oscillators.length, before + 1);
});

test('refreshVoices setzt Wellenform je Spur', async () => {
  const { engine, ctx, a, b } = await setup();
  const v = engine.noteOn(a.id, 60, 0.8);
  a.patch.osc1.wave = 'square';
  b.patch.osc1.wave = 'sine';
  engine.noteOn(b.id, 64, 0.8);
  engine.refreshVoices(a.id);
  eq(v.osc1.type, 'square');
});
