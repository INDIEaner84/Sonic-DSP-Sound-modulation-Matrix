import { test, eq, assert, setFile, near } from './harness.mjs';
import { FakeAudioContext, stopTimer } from './support/fake-audio.mjs';
import { Engine } from '../js/audio.js';
import { createProject, createTrack } from '../js/project.js';
import {
  createSampleBank,
  SampleBank,
  SampleVoice,
  createSf2Voice,
  timecentsToSeconds,
  zoneSemitones,
} from '../js/sampler.js';
import { buildSf2 } from './support/sf2-fixture.mjs';

setFile('sampler');

async function setup({ instrument = 'sf2', sample = null } = {}) {
  const track = createTrack({ name: 'Strings', instrument });
  if (sample) track.sample = { ...track.sample, ...sample };
  const project = createProject({ tracks: [track], activeTrackId: track.id });
  const engine = new Engine();
  engine.setProject(project);
  const ctx = new FakeAudioContext();
  await engine.init({ context: ctx });
  stopTimer(engine);
  return { engine, ctx, project, track };
}

function fixtureBank(ctx, options = {}) {
  const bytes = buildSf2(options);
  const result = createSampleBank(bytes, ctx, { fileName: 'test.sf2' });
  assert(result.ok, result.errors.join(' | '));
  return { bytes, bank: result.bank };
}

test('Bank liest Presets, Zonen und baut AudioBuffers lazy', async () => {
  const { ctx } = await setup();
  const { bank } = fixtureBank(ctx);

  const info = bank.info;
  eq(info.fileName, 'test.sf2');
  eq(info.presets, 1);
  eq(info.zones, 1);
  eq(info.samples, 1);
  eq(info.has24Bit, false);
  eq(bank.presets.map((p) => p.name), ['Piano']);
  eq(bank.created, 0, 'Buffers entstehen erst beim Gebrauch');

  const spec = bank.voiceFor({ name: 'Piano' }, 60, 0.8);
  assert(spec, 'voiceFor lieferte nichts');
  eq(spec.presetName, 'Piano');
  eq(spec.buffer.length, 512);
  eq(spec.buffer.sampleRate, 44100);
  eq(spec.loop, true);
  eq(bank.created, 1);

  bank.voiceFor({ name: 'Piano' }, 61, 0.8);
  eq(bank.created, 1, 'Buffer wird wiederverwendet');

  eq(bank.resolve({ name: 'Gibtsnicht', program: 0 }).preset.name, 'Piano', 'Rückfall auf Programm 0');
  eq(bank.resolve({ name: 'Gibtsnicht', program: 99 }).preset.name, 'Piano', 'Rückfall auf das erste Preset');
  bank.soundfont.presets[0].zones[0].keyLow = 60;
  bank.soundfont.presets[0].zones[0].keyHigh = 72;
  eq(bank.voiceFor({ name: 'Piano' }, 40, 0.8), null, 'Note außerhalb der Zone → keine Stimme');
});

test('Sample-Stimme hängt an der Spurkette und rechnet Tonhöhe/Hüllkurve', async () => {
  const { engine, ctx, track } = await setup();
  const { bank } = fixtureBank(ctx);
  engine.setSampleBank(bank);
  assert(engine.sampleBank === bank, 'Bank wurde nicht gesetzt');

  const voice = engine.noteOn(track.id, 72, 0.5, null);
  assert(voice instanceof SampleVoice, 'Stimme ist keine SampleVoice');
  eq(voice.kind, 'sf2');
  eq(voice.track.id, track.id);
  near(voice.pitchRatio, 2, 1e-9, 'Note 72 gegen Grundton 60 = eine Oktave');
  eq(voice.looping, true);
  assert(voice.src.loop, 'BufferSource muss loopen');
  near(voice.src.loopEnd, 480 / 44100, 1e-9);
  assert(voice.panner, 'Pan-Knoten fehlt');
  eq(voice.dead, false);

  /* Release beendet den Loop, die Stimme stirbt nach der Ausklingzeit. */
  voice.release(ctx.currentTime);
  eq(voice.released, true);
  assert(voice.src.stoppedAt != null, 'Loop-Quelle muss gestoppt werden');
  const end = voice.endAt;
  voice.tick(end + 0.001);
  eq(voice.dead, true);
});

test('Ohne Bank oder ohne passende Zone greift das Klavier (nie Stille)', async () => {
  const { engine, ctx, track } = await setup();
  eq(engine.sampleBank, null);
  const fallback = engine.noteOn(track.id, 60, 0.8);
  eq(fallback.kind, 'piano', 'ohne Bank muss die Engine auf Klavier zurückfallen');

  const { bank } = fixtureBank(ctx, {
    samples: [{ name: 'NurMitte', frames: 256, pitch: 60, keyLow: 60, keyHigh: 60, loop: false }],
  });
  engine.setSampleBank(bank);
  const outside = engine.noteOn(track.id, 90, 0.8);
  eq(outside.kind, 'piano', 'Note außerhalb der Zonen → Klavier');

  const inside = engine.noteOn(track.id, 60, 0.8);
  eq(inside.kind, 'sf2');
  eq(inside.looping, false, 'Ein-Schuss-Sample ohne Loop');
  assert(Number.isFinite(inside.endAt), 'Ein-Schuss braucht ein Ende');

  await engine.allNotesOff ? engine.allNotesOff() : null;
});

test('createSf2Voice und Bank-Grenzen prüfen sauber', async () => {
  const { engine, ctx, track, project } = await setup();
  const chain = engine.chains.get(track.id);
  eq(createSf2Voice(engine, chain, 60, 0.8, null), null, 'ohne Bank keine Stimme');

  const broken = createSampleBank(new Uint8Array([1, 2, 3]), ctx);
  assert(!broken.ok);
  assert(broken.errors.join(' ').includes('RIFF'), broken.errors.join(' | '));

  const noCtx = createSampleBank(buildSf2(), null);
  assert(!noCtx.ok);
  assert(noCtx.errors[0].includes('AudioContext'), noCtx.errors[0]);

  const { bank } = fixtureBank(ctx);
  engine.setSampleBank(bank);
  const voice = createSf2Voice(engine, chain, 60, 0.8, null);
  assert(voice instanceof SampleVoice);

  /* Preset-Referenz der Spur wird benutzt, nicht hart Preset 0. */
  const two = fixtureBank(ctx, {
    presets: [
      { name: 'Piano', program: 0, bank: 0 },
      { name: 'Strings', program: 48, bank: 0 },
    ],
  });
  engine.setSampleBank(two.bank);
  project.tracks[0].sample = { preset: 'Strings', name: 'two.sf2', program: 48, bank: 0 };
  const strings = engine.noteOn(track.id, 60, 0.8);
  eq(strings.spec.presetName, 'Strings');
  eq(strings.spec.presetIndex, 1);
});

test('Zeitcents und Halbton-Rechnung', () => {
  near(timecentsToSeconds(0, 0.5), 1, 1e-9, '0 Zeitcents = 1 s');
  near(timecentsToSeconds(-1200, 0.5), 0.5, 1e-9, '-1200 = 0,5 s');
  eq(timecentsToSeconds(-32768, 0.25), 0.25, 'nicht gesetzt → Rückfall');
  eq(timecentsToSeconds(NaN, 0.1), 0.1);
  near(timecentsToSeconds(20000, 0.1), 8, 1e-9, 'wird auf 8 s begrenzt');

  eq(zoneSemitones({ rootKey: 60, coarseTune: 0, fineTune: 0, pitchCorrection: 0 }, 72), 12);
  near(zoneSemitones({ rootKey: 60, coarseTune: 1, fineTune: 50, pitchCorrection: 0 }, 60), 1.5, 1e-9);
  near(zoneSemitones({ rootKey: 60, coarseTune: 0, fineTune: 0, pitchCorrection: -25 }, 60), -0.25, 1e-9);

  /* Bank-Summary für das Status-Panel */
  eq(new SampleBank(null, null).summary(), 'keine Bank');
});
