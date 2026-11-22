import { test, eq, assert, setFile, near } from './harness.mjs';
import { FakeAudioContext } from './support/fake-audio.mjs';
import { encodeWav } from '../js/wav.js';
import {
  MIX_TAIL_SECONDS,
  mixSeconds,
  canRecord,
  pickMimeType,
  recordOutput,
  blobToWav,
} from '../js/recorder.js';

setFile('recorder');

test('mixSeconds rechnet Loops, Takt und Tempo', () => {
  const project = { bpm: 120, bars: 4 };
  near(mixSeconds(project, 1), 8 + MIX_TAIL_SECONDS, 1e-9);
  near(mixSeconds(project, 2), 16 + MIX_TAIL_SECONDS, 1e-9);
  near(mixSeconds({ bpm: 60, bars: 1 }, 1), 4 + MIX_TAIL_SECONDS, 1e-9);
  near(mixSeconds({ bpm: 0, bars: 0 }, 1), 8 + MIX_TAIL_SECONDS, 1e-9, 'ungültige Werte → Defaults');
  near(mixSeconds(project, 99), 8 * 8 + MIX_TAIL_SECONDS, 1e-9, 'Loops werden begrenzt');
  near(mixSeconds(project, 0), 8 + MIX_TAIL_SECONDS, 1e-9);
});

test('canRecord erkennt fehlende Umgebung', () => {
  eq(canRecord(null), false);
  eq(canRecord({}), false);
  eq(canRecord(new FakeAudioContext()), false, 'ohne MediaStream-Destination');
});

test('pickMimeType liefert ohne MediaRecorder leeren String', () => {
  eq(pickMimeType(), '');
});

test('recordOutput lehnt fehlende Umgebung sauber ab', async () => {
  const ctx = new FakeAudioContext();
  const result = await recordOutput(ctx, ctx.bus, 0.1);
  assert(!result.ok);
  assert(result.error.includes('nicht unterstützt'), result.error);
});

test('blobToWav dekodiert und kodiert als WAV', async () => {
  const frames = 6;
  const left = Float32Array.from({ length: frames }, (_, i) => i / frames - 0.5);
  const right = Float32Array.from({ length: frames }, (_, i) => 0.5 - i / frames);
  const ctx = {
    async decodeAudioData() {
      return {
        numberOfChannels: 2,
        length: frames,
        sampleRate: 44100,
        duration: frames / 44100,
        getChannelData: (c) => (c === 0 ? left : right),
      };
    },
  };
  const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' });
  const result = await blobToWav(ctx, blob);
  assert(result.ok, result.error);
  eq(result.blob.type, 'audio/wav');
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  eq(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF');
  eq(bytes.length, 44 + frames * 4, 'Stereo, 16 Bit');
  const expected = encodeWav([left, right], 44100);
  eq(bytes.length, expected.length);
  eq(Array.from(bytes.slice(44, 60)), Array.from(expected.slice(44, 60)));
});

test('blobToWav meldet Fehlerfälle', async () => {
  eq((await blobToWav(null, null)).ok, false);
  const noCtx = await blobToWav({}, new Blob([new Uint8Array([0])]));
  assert(!noCtx.ok && noCtx.error.includes('Dekodierung'), noCtx.error);

  const failing = await blobToWav(
    { decodeAudioData: async () => { throw new Error('kaputt'); } },
    new Blob([new Uint8Array([0])])
  );
  assert(!failing.ok && failing.error.includes('nicht dekodierbar'), failing.error);

  const empty = await blobToWav(
    { decodeAudioData: async () => ({ numberOfChannels: 0, sampleRate: 44100, getChannelData: () => new Float32Array(0) }) },
    new Blob([new Uint8Array([0])])
  );
  assert(!empty.ok && empty.error.includes('leer'), empty.error);
});
