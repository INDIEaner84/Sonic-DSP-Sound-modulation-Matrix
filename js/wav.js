/* Sonic DSP — WAV-Encoder
 * Reine Funktion ohne DOM/Web-Audio-Abhängigkeit: Float-Kanäle → 16-Bit-PCM-WAV.
 * Wird von `js/recorder.js` genutzt und ist dadurch ohne Browser testbar.
 */

const HEADER_BYTES = 44;

/**
 * Kodiert einen oder mehrere Float-Kanäle als WAV (PCM 16 Bit, little endian).
 * @param {Float32Array[]} channels Kanäle gleicher Länge, Werte −1…1 (werden geklemmt)
 * @param {number} sampleRate Abtastrate in Hz
 * @returns {Uint8Array} vollständige WAV-Datei
 */
export function encodeWav(channels, sampleRate) {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new Error('encodeWav: mindestens ein Kanal nötig');
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('encodeWav: sampleRate muss positiv sein');
  }
  const channelCount = channels.length;
  const frames = channels[0].length;
  for (let c = 1; c < channelCount; c++) {
    if (channels[c].length !== frames) {
      throw new Error('encodeWav: Kanäle müssen gleich lang sein');
    }
  }

  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt-Chunk-Größe
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = HEADER_BYTES;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      const raw = channels[c][i];
      const clamped = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      /* −1 → −32768, +1 → 32767 */
      const value = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
      view.setInt16(offset, value, true);
      offset += bytesPerSample;
    }
  }

  return new Uint8Array(buffer);
}

/** Nur für Anzeige/Tests: Dauer in Sekunden aus Frame-Zahl und Rate. */
export function wavDuration(frames, sampleRate) {
  return sampleRate > 0 ? frames / sampleRate : 0;
}
