/* Sonic DSP — Mix-Mitschnitt
 * Nimmt die laufende Ausgabe der Engine über `MediaStreamAudioDestinationNode`
 * und `MediaRecorder` auf und wandelt sie danach in eine WAV-Datei um.
 *
 * Der Mitschnitt verwendet die echte Audio-Kette (kein zweiter Synth-Pfad), ist
 * also zwangsläufig in Echtzeit. Die reinen Teile (Dauer, WAV-Kodierung) liegen
 * getrennt und sind ohne Browser testbar.
 */

import { encodeWav } from './wav.js';

/** Tail nach dem letzten Loop, damit Delay/Reverb ausklingen können. */
export const MIX_TAIL_SECONDS = 1.6;

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', ''];

export function mixSeconds(project, loops = 1) {
  const bpm = project && Number.isFinite(project.bpm) && project.bpm > 0 ? project.bpm : 120;
  const bars = project && Number.isFinite(project.bars) && project.bars > 0 ? project.bars : 4;
  const loopSeconds = (bars * 4 * 60) / bpm;
  const count = Math.max(1, Math.min(8, Math.round(loops) || 1));
  return loopSeconds * count + MIX_TAIL_SECONDS;
}

/** Kann in dieser Umgebung überhaupt aufgenommen werden? */
export function canRecord(ctx) {
  const hasStream = !!ctx && typeof ctx.createMediaStreamDestination === 'function';
  const hasRecorder = typeof MediaRecorder !== 'undefined';
  return hasStream && hasRecorder;
}

/** Erstes vom Browser unterstütztes Container-Format. */
export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
  for (const candidate of MIME_CANDIDATES) {
    if (candidate === '') return '';
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch (e) {
      /* ignorieren, nächsten Kandidaten prüfen */
    }
  }
  return '';
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Nimmt den Ausgang eines Knotens für `seconds` Sekunden auf.
 * @returns {Promise<{ok: boolean, blob?: Blob, mimeType?: string, error?: string}>}
 */
export async function recordOutput(ctx, sourceNode, seconds, { onProgress, signal } = {}) {
  if (!canRecord(ctx)) {
    return { ok: false, error: 'Mitschnitt wird von diesem Browser nicht unterstützt' };
  }
  if (!sourceNode || typeof sourceNode.connect !== 'function') {
    return { ok: false, error: 'Keine Audioquelle für den Mitschnitt' };
  }
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { ok: false, error: 'Ungültige Aufnahmedauer' };
  }

  const dest = ctx.createMediaStreamDestination();
  const tap = ctx.createGain();
  sourceNode.connect(tap);
  tap.connect(dest);

  const mimeType = pickMimeType();
  let recorder;
  try {
    recorder = new MediaRecorder(dest.stream, mimeType ? { mimeType } : undefined);
  } catch (err) {
    sourceNode.disconnect?.(tap);
    return { ok: false, error: 'Mitschnitt nicht startbar: ' + err.message };
  }

  const chunks = [];
  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = (event) => reject(new Error((event && event.error && event.error.message) || 'Aufnahmefehler'));
  });

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size) chunks.push(event.data);
  };

  try {
    recorder.start(250);
  } catch (err) {
    sourceNode.disconnect?.(tap);
    return { ok: false, error: 'Mitschnitt nicht startbar: ' + err.message };
  }

  const started = Date.now();
  let aborted = false;
  while (Date.now() - started < seconds * 1000) {
    if (signal && signal.aborted) {
      aborted = true;
      break;
    }
    if (onProgress) onProgress(Math.min(1, (Date.now() - started) / (seconds * 1000)));
    await wait(100);
  }

  try {
    recorder.stop();
    await stopped;
  } catch (err) {
    return { ok: false, error: 'Aufnahme fehlgeschlagen: ' + err.message };
  } finally {
    try {
      sourceNode.disconnect(tap);
    } catch (e) {
      /* ignore */
    }
  }

  if (aborted) return { ok: false, error: 'Aufnahme abgebrochen' };
  if (!chunks.length) return { ok: false, error: 'Keine Audiodaten aufgenommen' };
  const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
  return { ok: true, blob, mimeType: blob.type };
}

/**
 * Dekodiert einen Mitschnitt und kodiert ihn als WAV.
 * @returns {Promise<{ok: boolean, blob?: Blob, error?: string}>}
 */
export async function blobToWav(ctx, blob) {
  if (!blob) return { ok: false, error: 'Keine Aufnahme vorhanden' };
  if (!ctx || typeof ctx.decodeAudioData !== 'function') {
    return { ok: false, error: 'Audio-Dekodierung nicht verfügbar' };
  }
  let buffer;
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    buffer = await ctx.decodeAudioData(bytes.buffer);
  } catch (err) {
    return { ok: false, error: 'Aufnahme nicht dekodierbar: ' + err.message };
  }
  if (!buffer || !buffer.numberOfChannels) return { ok: false, error: 'Aufnahme ist leer' };

  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c));
  }
  try {
    const wav = encodeWav(channels, buffer.sampleRate);
    return { ok: true, blob: new Blob([wav], { type: 'audio/wav' }), duration: buffer.duration };
  } catch (err) {
    return { ok: false, error: 'WAV-Kodierung fehlgeschlagen: ' + err.message };
  }
}
