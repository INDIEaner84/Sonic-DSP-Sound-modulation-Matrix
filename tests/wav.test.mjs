import { test, eq, assert, setFile, throws } from './harness.mjs';
import { encodeWav, wavDuration } from '../js/wav.js';

setFile('wav');

const ascii = (bytes, offset, length) =>
  String.fromCharCode(...bytes.slice(offset, offset + length));

const u32 = (bytes, offset) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  return view.getUint32(0, true);
};

const i16 = (bytes, offset) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 2);
  return view.getInt16(0, true);
};

function ramp(n, fn) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(i);
  return out;
}

test('WAV-Header ist korrekt (Mono, 16 Bit)', () => {
  const frames = 8;
  const wav = encodeWav([ramp(frames, () => 0)], 48000);
  eq(ascii(wav, 0, 4), 'RIFF');
  eq(ascii(wav, 8, 4), 'WAVE');
  eq(ascii(wav, 12, 4), 'fmt ');
  eq(ascii(wav, 36, 4), 'data');
  eq(u32(wav, 16), 16, 'fmt-Chunk-Größe');
  const view = new DataView(wav.buffer);
  eq(view.getUint16(20, true), 1, 'PCM');
  eq(view.getUint16(22, true), 1, 'Kanäle');
  eq(u32(wav, 24), 48000, 'Samplerate');
  eq(u32(wav, 28), 48000 * 2, 'Byte-Rate');
  eq(view.getUint16(32, true), 2, 'Block-Align');
  eq(view.getUint16(34, true), 16, 'Bits');
  eq(u32(wav, 40), frames * 2, 'Datenlänge');
  eq(wav.length, 44 + frames * 2);
  eq(u32(wav, 4), 36 + frames * 2, 'RIFF-Größe');
});

test('Stereo wird verschachtelt geschrieben', () => {
  const left = ramp(3, (i) => [0, 0.5, -0.5][i]);
  const right = ramp(3, (i) => [1, -1, 0][i]);
  const wav = encodeWav([left, right], 44100);
  const view = new DataView(wav.buffer);
  eq(view.getUint16(22, true), 2, 'Kanäle');
  eq(u32(wav, 40), 3 * 4, 'Datenlänge');
  eq(i16(wav, 44), 0, 'L0');
  eq(i16(wav, 46), 32767, 'R0 (+1)');
  eq(i16(wav, 48), Math.round(0.5 * 32767), 'L1');
  eq(i16(wav, 50), -32768, 'R1 (−1)');
  eq(i16(wav, 52), Math.round(-0.5 * 32768), 'L2');
  eq(i16(wav, 54), 0, 'R2');
});

test('Werte werden geklemmt, NaN wird still zu 0', () => {
  const wav = encodeWav([ramp(3, (i) => [4, -4, NaN][i])], 8000);
  eq(i16(wav, 44), 32767, 'Übersteuerung');
  eq(i16(wav, 46), -32768, 'Untersteuerung');
  eq(i16(wav, 48), 0, 'NaN');
});

test('Ungültige Eingaben werden abgelehnt', () => {
  throws(() => encodeWav([], 48000), /mindestens ein Kanal/);
  throws(() => encodeWav(null, 48000), /mindestens ein Kanal/);
  throws(() => encodeWav([new Float32Array(4)], 0), /sampleRate/);
  throws(() => encodeWav([new Float32Array(4)], NaN), /sampleRate/);
  throws(() => encodeWav([new Float32Array(4), new Float32Array(5)], 48000), /gleich lang/);
});

test('Leerer Kanal ergibt nur den Header', () => {
  const wav = encodeWav([new Float32Array(0)], 48000);
  eq(wav.length, 44);
  eq(u32(wav, 40), 0);
});

test('wavDuration rechnet mit Rate', () => {
  eq(wavDuration(48000, 48000), 1);
  eq(wavDuration(96000, 48000), 2);
  eq(wavDuration(10, 0), 0);
});
