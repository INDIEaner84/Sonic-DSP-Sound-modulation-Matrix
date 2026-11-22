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
  eq(v.src1.startedAt, 0.5);
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
  eq(v.src1.type, 'square');
});

/* --------------------------------------------------------------- Effekte */

test('FX-Busse werden aufgebaut, Spuren hängen an den Sends', async () => {
  const { engine, a, b } = await setup();
  const chain = engine.chains.get(a.id);
  assert(engine.delay && engine.convolver, 'FX-Busse fehlen');
  assert(chain.sendDelay.connections.includes(engine.delayIn), 'Delay-Send nicht verbunden');
  assert(chain.sendReverb.connections.includes(engine.reverbIn), 'Reverb-Send nicht verbunden');
  assert(chain.gain.connections.includes(chain.sendDelay), 'Send nicht hinter dem Fader');
  assert(engine.delayOut.connections.includes(engine.master), 'Delay-Return nicht am Master');
  assert(engine.reverbOut.connections.includes(engine.master), 'Reverb-Return nicht am Master');
  eq(engine.chains.size, 2);
  assert(engine.chains.get(b.id).sendDelay, 'zweite Spur ohne Send');
});

test('Send-Pegel folgt track.sends, Mute wirkt über den Fader', async () => {
  const { engine, ctx, a } = await setup();
  const chain = engine.chains.get(a.id);
  a.sends.delay = 0.7;
  a.sends.reverb = 0.05;
  ctx.advance(0.02);
  engine.tick();
  near(chain.sendDelay.gain.value, 0.7, 1e-6);
  near(chain.sendReverb.gain.value, 0.05, 1e-6);

  a.mute = true;
  ctx.advance(0.02);
  engine.tick();
  eq(chain.gain.gain.value, 0);
  near(chain.sendDelay.gain.value, 0.7, 1e-6, 'Send bleibt gesetzt (post-fader)');
});

test('Delay-Zeit folgt Raster und Tempo', async () => {
  const { engine, ctx, project } = await setup();
  near(engine.delay.delayTime.value, 0.25, 1e-6, '1/8 bei 120 BPM');
  project.fx.delayDivision = '1/4';
  ctx.advance(0.02);
  engine.tick();
  near(engine.delay.delayTime.value, 0.5, 1e-6);
  project.bpm = 90;
  project.fx.delayDivision = '1/2';
  ctx.advance(0.02);
  engine.tick();
  near(engine.delay.delayTime.value, (2 * 60) / 90, 1e-6);
});

test('Feedback und Tone werden begrenzt', async () => {
  const { engine, ctx, project } = await setup();
  project.fx.delayFeedback = 2;
  project.fx.delayTone = 99999;
  ctx.advance(0.02);
  engine.tick();
  eq(engine.delayFb.gain.value, 0.85);
  eq(engine.delayTone.frequency.value, 9000);
});

test('Impulsantwort wird nur bei Größenänderung neu gebaut', async () => {
  const { engine, ctx, project } = await setup();
  const first = engine.convolver.buffer;
  assert(first && first.numberOfChannels === 2, 'IR fehlt oder ist nicht stereo');
  ctx.advance(0.02);
  engine.tick();
  assert(engine.convolver.buffer === first, 'IR wurde ohne Änderung neu gebaut');
  project.fx.reverbSize = 5;
  ctx.advance(0.02);
  engine.tick();
  assert(engine.convolver.buffer !== first, 'IR wurde bei Änderung nicht neu gebaut');
  near(engine.convolver.buffer.duration, 5, 0.05);
});

test('Rausch-Wellenform nutzt eine Buffer-Quelle statt Oszillator', async () => {
  const { engine, ctx, a } = await setup();
  a.patch.osc1.wave = 'noise';
  const before = ctx.created.bufferSources.length;
  const voicesBefore = ctx.created.oscillators.length;
  const v = engine.noteOn(a.id, 60, 0.8);
  assert(v, 'Stimme fehlt');
  eq(ctx.created.bufferSources.length, before + 1);
  eq(ctx.created.oscillators.length, voicesBefore + 1, 'nur osc2 bleibt Oszillator');
  assert(v.src1.buffer, 'Buffer fehlt');
  eq(v.src2.type, 'square');
  ctx.advance(0.05);
  engine.tick();
  assert(v.triggered, 'Noise-Stimme wird nicht getriggert');
});

test('Presets der Bibliothek sind gültig und nutzen erlaubte Wellen', async () => {
  const { PRESETS, PATCH_ENUMS, PATCH_RANGES } = await import('../js/state.js');
  const { getIn } = await import('../js/state.js');
  assert(PRESETS.length >= 8, 'zu wenige Presets');
  for (const preset of PRESETS) {
    for (const [path, allowed] of Object.entries(PATCH_ENUMS)) {
      const v = getIn(preset.patch, path);
      if (v === undefined) continue;
      assert(allowed.includes(v), `${preset.name}: ${path}=${v} nicht erlaubt`);
    }
    for (const [path, [min, max]] of Object.entries(PATCH_RANGES)) {
      const v = getIn(preset.patch, path);
      if (v === undefined) continue;
      assert(v >= min && v <= max, `${preset.name}: ${path}=${v} außerhalb ${min}…${max}`);
    }
    for (const key of Object.keys(preset.patch.matrix || {})) {
      const [src, dest] = key.split(':');
      assert(src && dest, `${preset.name}: Matrix-Route ${key} unvollständig`);
    }
  }
});

test('FX-Parameter werden nur bei Änderung geschrieben', async () => {
  const { engine, ctx, project } = await setup();
  ctx.advance(0.02);
  engine.tick();
  const writes = engine.delay.delayTime.writes;
  ctx.advance(0.02);
  engine.tick();
  ctx.advance(0.02);
  engine.tick();
  eq(engine.delay.delayTime.writes, writes, 'kein Schreiben ohne Änderung');
  project.fx.delayDivision = '1/2';
  ctx.advance(0.02);
  engine.tick();
  eq(engine.delay.delayTime.writes, writes + 1, 'genau ein Schreiben nach Änderung');
  near(engine.delay.delayTime.value, 1, 1e-6, '1/2 bei 120 BPM');
});

/* ------------------------------------------------------------ Instrumente */

test('Piano-Stimme nutzt Partiale, Hammer und Velocity-Cutoff', async () => {
  const { engine, ctx, a } = await setup();
  a.instrument = 'piano';
  const oscBefore = ctx.created.oscillators.length;
  const noiseBefore = ctx.created.bufferSources.length;
  const v = engine.noteOn(a.id, 60, 0.9);
  assert(v, 'Stimme fehlt');
  eq(v.kind, 'piano');
  eq(ctx.created.oscillators.length, oscBefore + 5, 'fünf Partiale');
  eq(ctx.created.bufferSources.length, noiseBefore + 1, 'Hammer-Noise');
  assert(v.filter.frequency.value > 4000, 'Cutoff folgt Velocity');
  assert(v.out.gain.value >= 0, 'Gain vorhanden');
});

test('Klavier-Noten werden per Release geplant und enden', async () => {
  const { engine, ctx, a } = await setup();
  a.instrument = 'piano';
  const v = engine.noteOn(a.id, 48, 0.8);
  engine.scheduleRelease(v, 0.4);
  near(v.releaseAt, 0.4, 1e-6);
  assert(v.endAt <= 0.9, 'Ausklang zu lang: ' + v.endAt);
  ctx.advance(0.45);
  engine.tick();
  eq(v.released, true);
  ctx.advance(1);
  engine.tick();
  eq(v.dead, true);
});

test('Drum-Pads nutzen eigene Stimmen und GM-Noten', async () => {
  const { engine, ctx, a } = await setup();
  a.instrument = 'drums';
  const v = engine.noteOn(a.id, 36, 0.9);
  eq(v.kind, 'drums');
  eq(v.pad.id, 'kick');
  assert(ctx.created.oscillators.length > 0, 'Kick braucht einen Oszillator');

  const hat = engine.noteOn(a.id, 42, 0.7);
  eq(hat.pad.id, 'hatClosed');
  const unbekannt = engine.noteOn(a.id, 99, 0.7);
  eq(unbekannt.pad.id, 'hatClosed', 'unbekannte Note fällt auf geschlossene Hat zurück');
  eq(unbekannt.kind, 'drums');
});

test('Drum-Stimme endet nach ihrem Ausklang ohne Note-Off', async () => {
  const { engine, ctx, a } = await setup();
  a.instrument = 'drums';
  const v = engine.noteOn(a.id, 49, 0.8);
  eq(v.pad.id, 'crash');
  v.release(); // absichtlich wirkungslos
  eq(v.released, false);
  ctx.advance(1.5);
  engine.tick();
  eq(v.released, true);
  eq(v.dead, true);
});

test('refreshVoices lässt Piano- und Drum-Stimmen unangetastet', async () => {
  const { engine, ctx, a } = await setup();
  a.instrument = 'piano';
  const piano = engine.noteOn(a.id, 60, 0.8);
  a.instrument = 'drums';
  const drum = engine.noteOn(a.id, 38, 0.8);
  a.patch.osc1.wave = 'square';
  engine.refreshVoices(a.id);
  eq(piano.kind, 'piano');
  eq(drum.kind, 'drums');
  ctx.advance(0.1);
  engine.tick();
  assert(!piano.dead || piano.triggered, 'Piano-Stimme darf nicht abrupt enden');
});

test('Drive-Insert sitzt zwischen Pan und Fader und folgt dem Spurwert', async () => {
  const { engine, ctx, a } = await setup();
  const chain = engine.chains.get(a.id);
  assert(chain.shaper, 'Waveshaper fehlt');
  assert(chain.pan.connections.includes(chain.driveIn), 'pan→driveIn fehlt');
  assert(chain.driveOut.connections.includes(chain.gain), 'driveOut→gain fehlt');
  assert(Array.isArray(chain.shaper.curve) || chain.shaper.curve instanceof Float32Array, 'Kurve fehlt');

  a.insert.drive = 0;
  ctx.advance(0.02);
  engine.tick();
  near(chain.driveIn.gain.value, 1, 1e-6);
  near(chain.driveOut.gain.value, 1, 1e-6);

  a.insert.drive = 0.5;
  ctx.advance(0.02);
  engine.tick();
  near(chain.driveIn.gain.value, 4.5, 1e-6, 'Vorverstärkung');
  near(chain.driveOut.gain.value, 1 / (1 + 0.5 * 2.4), 1e-6, 'Makeup');
});

test('Drive-Kurve bleibt innerhalb ±1', async () => {
  const { engine, a } = await setup();
  const curve = engine.chains.get(a.id).shaper.curve;
  assert(curve.length > 1000, 'Kurve zu klein');
  assert(Math.abs(curve[0]) <= 1 && Math.abs(curve[curve.length - 1]) <= 1, 'Kurve überschreitet ±1');
  const mid = curve[Math.floor(curve.length / 2)];
  assert(Math.abs(mid) < 0.05, 'Mitte muss nahe 0 liegen');
});
