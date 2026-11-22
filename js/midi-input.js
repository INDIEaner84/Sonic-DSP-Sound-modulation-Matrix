/* Sonic DSP — Web-MIDI-Eingang
 * Dünne Schicht um `navigator.requestMIDIAccess()`: Nachrichten parsen, auf
 * Noten/CC abbilden und CC-Bindungen (MIDI-Learn) aus dem Projekt anwenden.
 *
 * Der Parsing-/Routing-Teil ist frei von Browser-Abhängigkeiten und wird mit
 * rohen Byte-Folgen getestet; nur `openMidiAccess()` spricht mit dem Browser.
 */

import { applyControl, isNumericTarget } from './project.js';

export const MIDI_NOTE_ON = 0x90;
export const MIDI_NOTE_OFF = 0x80;
export const MIDI_CC = 0xb0;
export const MIDI_PROGRAM = 0xc0;

/**
 * Zerlegt eine MIDI-Nachricht. Kanal ist 1-basiert (1…16).
 * @param {Uint8Array|number[]} data
 * @returns {{type: string, channel: number, note?: number, velocity?: number, cc?: number, value?: number}|null}
 */
export function parseMidiMessage(data) {
  if (!data || data.length < 2) return null;
  const status = data[0];
  if (status < 0x80) return null; // Datenbytes ohne Statusbyte (Running Status) – hier nicht unterstützt
  const kind = status & 0xf0;
  const channel = (status & 0x0f) + 1;

  switch (kind) {
    case MIDI_NOTE_ON: {
      const note = data[1] & 0x7f;
      const velocity = (data[2] ?? 0) & 0x7f;
      if (velocity === 0) return { type: 'noteOff', channel, note, velocity: 0 };
      return { type: 'noteOn', channel, note, velocity };
    }
    case MIDI_NOTE_OFF:
      return { type: 'noteOff', channel, note: data[1] & 0x7f, velocity: (data[2] ?? 0) & 0x7f };
    case MIDI_CC:
      return { type: 'cc', channel, cc: data[1] & 0x7f, value: (data[2] ?? 0) & 0x7f };
    case MIDI_PROGRAM:
      return { type: 'program', channel, value: data[1] & 0x7f };
    default:
      return { type: 'other', channel };
  }
}

/**
 * Kurze, lesbare Beschreibung einer Nachricht (für den MIDI-Monitor der UI).
 */
export function describeMessage(data) {
  const msg = parseMidiMessage(data);
  if (!msg) return 'unbekannt';
  switch (msg.type) {
    case 'noteOn':
      return `CH ${msg.channel} · Note ${msg.note} · Vel ${msg.velocity}`;
    case 'noteOff':
      return `CH ${msg.channel} · Note ${msg.note} aus`;
    case 'cc':
      return `CH ${msg.channel} · CC ${msg.cc} · Wert ${msg.value}`;
    case 'program':
      return `CH ${msg.channel} · Program ${msg.value}`;
    default:
      return `CH ${msg.channel} · ${msg.type}`;
  }
}

/**
 * Router: verbindet geparste Nachrichten mit Noten-Callbacks und den
 * CC-Bindungen des Projekts. `starteLearn()` fängt die nächste CC-Nachricht ab.
 */
export function createMidiRouter({ getProject, onNoteOn, onNoteOff, onControl } = {}) {
  let learning = null;
  let lastChannel = null;

  return {
    get learning() {
      return learning ? { ...learning } : null;
    },
    get lastChannel() {
      return lastChannel;
    },

    startLearn(target, done) {
      if (!target) return false;
      learning = { target, done };
      return true;
    },

    cancelLearn() {
      learning = null;
    },

    /**
     * Verarbeitet eine rohe MIDI-Nachricht (z. B. `event.data`).
     * @returns {{handled: boolean, type?: string, action?: string, target?: string, amount?: number, learned?: object}}
     */
    handle(data) {
      const msg = parseMidiMessage(data);
      if (!msg) return { handled: false };
      lastChannel = msg.channel;

      if (msg.type === 'noteOn') {
        onNoteOn?.(msg.note, msg.velocity / 127, msg.channel);
        return { handled: true, type: 'noteOn', action: 'note', amount: msg.velocity / 127 };
      }
      if (msg.type === 'noteOff') {
        onNoteOff?.(msg.note, msg.channel);
        return { handled: true, type: 'noteOff', action: 'note' };
      }
      if (msg.type === 'cc') {
        if (learning) {
          const learned = { cc: msg.cc, channel: msg.channel, target: learning.target };
          const done = learning.done;
          learning = null;
          done?.(learned);
          return { handled: true, type: 'cc', action: 'learn', learned };
        }
        const project = getProject ? getProject() : null;
        const binds = (project && project.midi && Array.isArray(project.midi.binds) ? project.midi.binds : []).filter(
          (b) => b && b.cc === msg.cc && (b.channel === 0 || b.channel === msg.channel)
        );
        const bind = binds[binds.length - 1];
        if (!bind) return { handled: false, type: 'cc' };
        const amount = msg.value / 127;
        const numeric = isNumericTarget(bind.target);
        if (numeric && project) applyControl(project, bind.target, amount);
        onControl?.(bind.target, amount, { numeric, cc: msg.cc, channel: msg.channel });
        return { handled: true, type: 'cc', action: 'control', target: bind.target, amount };
      }
      return { handled: false, type: msg.type };
    },
  };
}

/**
 * Öffnet den MIDI-Zugriff und hängt den Router an alle Eingänge.
 * @returns {Promise<{ok: boolean, error?: string, devices?: Function, rescan?: Function, close?: Function}>}
 */
export async function openMidiAccess({ router, onDevices, onInput } = {}) {
  if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
    return { ok: false, error: 'Web MIDI wird von diesem Browser nicht unterstützt' };
  }
  let access;
  try {
    access = await navigator.requestMIDIAccess({ sysex: false });
  } catch (err) {
    return { ok: false, error: 'MIDI-Zugriff abgelehnt: ' + (err && err.message ? err.message : err) };
  }

  const attached = new Set();

  const devices = () => {
    const list = [];
    access.inputs.forEach((input) => {
      list.push({ id: input.id, name: input.name || 'MIDI-Eingang', manufacturer: input.manufacturer || '', state: input.state });
    });
    return list;
  };

  const attach = () => {
    access.inputs.forEach((input) => {
      if (attached.has(input.id)) return;
      input.onmidimessage = (event) => {
        const result = router ? router.handle(event.data) : { handled: false };
        if (onInput) onInput(result, event);
      };
      attached.add(input.id);
    });
    if (onDevices) onDevices(devices());
  };

  attach();
  access.onstatechange = () => attach();

  return {
    ok: true,
    devices,
    rescan: attach,
    close() {
      access.inputs.forEach((input) => {
        input.onmidimessage = null;
      });
      access.onstatechange = null;
      attached.clear();
    },
  };
}
