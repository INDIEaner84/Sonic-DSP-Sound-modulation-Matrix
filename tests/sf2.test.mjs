import { test, eq, assert, setFile, near } from './harness.mjs';
import { parseSf2, sf2Presets, findSf2Preset, zonesForNote, readSf2Zone, SF2_LIMITS } from '../js/sf2.js';
import { buildSf2 } from './support/sf2-fixture.mjs';

setFile('sf2');

test('Gültige SF2-Datei liefert Info, Presets, Zonen und PCM', () => {
  const bytes = buildSf2({ infoName: 'Fixturefont' });
  const result = parseSf2(bytes);
  assert(result.ok, result.errors.join(' | '));
  eq(result.warnings, []);
  const { soundfont } = result;
  eq(soundfont.info.name, 'Fixturefont');
  eq(soundfont.info.copyright, 'CC0');
  eq(soundfont.presets.length, 1);
  eq(soundfont.presets[0].name, 'Piano');
  eq(soundfont.presets[0].program, 0);
  eq(soundfont.presets[0].bank, 0);
  eq(soundfont.presets[0].zones.length, 1);

  const zone = soundfont.presets[0].zones[0];
  eq(zone.keyLow, 0);
  eq(zone.keyHigh, 127);
  eq(zone.velLow, 0);
  eq(zone.velHigh, 127);
  eq(zone.rootKey, 60, 'Grundton kommt aus dem Sample-Kopf');
  eq(zone.loop, true, 'sampleModes=1 bedeutet Loop');
  eq(soundfont.pcmFrames, 512);
  eq(soundfont.samples.length, 1);
  eq(soundfont.samples[0].sampleRate, 44100);

  const audio =readZone(soundfont, zone);
  eq(audio.pcm.length, 512);
  eq(audio.sampleRate, 44100);
  eq(audio.rootKey, 60);
  eq(audio.loop, true);
  eq(audio.loopStart, 32);
  eq(audio.loopEnd, 480);
  near(audio.pcm[0], -0.3662109375, 1e-6, 'int16 → Float32');
  assert(audio.pcm.some((v) => v !== audio.pcm[0]), 'PCM darf nicht konstant sein');
});

/* Kleiner Helfer: hält die Zusicherung an einer Stelle. */
function readZone(soundfont, zone) {
  const audio = readSf2Zone(soundfont, zone);
  assert(audio, 'readSf2Zone lieferte null');
  return audio;
}

test('Presets sind über Programm und Bank auffindbar', () => {
  const bytes = buildSf2({
    presets: [
      { name: 'Piano', program: 0, bank: 0 },
      { name: 'Strings', program: 48, bank: 0 },
      { name: 'Kit', program: 0, bank: 128 },
    ],
  });
  const result = parseSf2(bytes);
  assert(result.ok, result.errors.join(' | '));
  const list = sf2Presets(result.soundfont);
  eq(list.map((p) => p.name), ['Piano', 'Strings', 'Kit']);
  eq(list.map((p) => p.program), [0, 48, 0]);
  eq(list.map((p) => p.index), [0, 1, 2]);

  eq(findSf2Preset(result.soundfont, 48).name, 'Strings');
  eq(findSf2Preset(result.soundfont, 0, 128).name, 'Kit', 'Bank 128 ist das Schlagzeug-Preset');
  eq(findSf2Preset(result.soundfont, 7), null);
  eq(sf2Presets(null), []);
  eq(readSf2Zone(null, null), null);
});

test('Key-Bereiche trennen Zonen, Velocity wird geklemmt', () => {
  const bytes = buildSf2({
    samples: [
      { name: 'Low', frames: 128, pitch: 36, keyLow: 0, keyHigh: 47, loop: false },
      { name: 'High', frames: 128, pitch: 72, keyLow: 48, keyHigh: 127, loop: true },
    ],
  });
  const result = parseSf2(bytes);
  assert(result.ok, result.errors.join(' | '));
  const preset = result.soundfont.presets[0];
  eq(preset.zones.length, 2);

  const low = zonesForNote(preset, 40, 0.5);
  eq(low.length, 1);
  eq(low[0].sampleName, 'Low');
  eq(low[0].loop, false);

  const high = zonesForNote(preset, 72, 1.7); // Velocity > 1 wird geklemmt
  eq(high.length, 1);
  eq(high[0].sampleName, 'High');
  eq(high[0].rootKey, 72);
  eq(high[0].loop, true);

  eq(zonesForNote(preset, 40, 0.5).length + zonesForNote(preset, 96, 0.2).length, 2, 'jede Note genau eine Zone');
  eq(zonesForNote(preset, 200, 0.5), [], 'Noten außerhalb MIDI liefern nichts');
  eq(zonesForNote(null, 60), []);
});

test('Strukturfehler werden abgelehnt, nicht stillschweigend akzeptiert', () => {
  eq(parseSf2(new Uint8Array(0)).ok, false);
  eq(parseSf2('kein buffer').ok, false);

  const wrongHeader = buildSf2();
  const wavLike = Uint8Array.from(wrongHeader);
  wavLike[8] = 'W'.charCodeAt(0); // Formtyp kaputt
  const r1 = parseSf2(wavLike);
  assert(!r1.ok);
  assert(r1.errors.join(' ').includes('sfbk'), r1.errors.join(' | '));

  const noPdta = Uint8Array.from(buildSf2());
  const at = String.fromCharCode(...noPdta).indexOf('pdta');
  assert(at > 0, 'pdta nicht gefunden');
  noPdta.set([0x78, 0x78, 0x78, 0x78], at); // 'xxxx'
  const r2 = parseSf2(noPdta);
  assert(!r2.ok);
  assert(r2.errors.join(' ').includes('pdta'), r2.errors.join(' | '));

  const truncated = buildSf2().slice(0, 120);
  const r3 = parseSf2(truncated);
  assert(!r3.ok, 'abgeschnittene Datei muss abgelehnt werden');

  const tooBig = parseSf2(buildSf2(), { maxBytes: 256 });
  assert(!tooBig.ok);
  assert(tooBig.errors[0].includes('größer'), tooBig.errors[0]);

  eq(SF2_LIMITS.maxBytes, 64 * 1024 * 1024);
});

test('24-Bit-Hinweis statt falschem Schweigen, Loop-Flag folgt der Datei', () => {
  const withSm24 = parseSf2(buildSf2({ sm24: true }));
  assert(withSm24.ok, withSm24.errors.join(' | '));
  assert(withSm24.soundfont.has24Bit, 'sm24 muss erkannt werden');
  assert(withSm24.warnings.some((w) => w.includes('24-Bit')), withSm24.warnings.join(' | '));

  const noLoop = parseSf2(
    buildSf2({ samples: [{ name: 'OneShot', frames: 256, pitch: 60, loop: false }] }),
  );
  assert(noLoop.ok, noLoop.errors.join(' | '));
  eq(noLoop.soundfont.presets[0].zones[0].loop, false);
  eq(noLoop.warnings, []);
});
