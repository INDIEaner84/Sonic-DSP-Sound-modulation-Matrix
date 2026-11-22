/* UI-Integrationstest (jsdom). Nur mit `npm run test:ui` bzw. `--ui` aktiv,
 * weil jsdom eine devDependency ist. Prüft die echte Verdrahtung von
 * index.html + js/main.js: Spuren, Preset-Bindung, Aufnahme, Autosave, Export.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, eq, assert, setFile, near } from './harness.mjs';
import { FakeAudioContext, stopTimer } from './support/fake-audio.mjs';
import { STORAGE_KEY, DELAY_DIVISIONS, delaySeconds } from '../js/project.js';
import { PRESETS } from '../js/state.js';

setFile('ui');

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (err) {
  /* jsdom optional */
}

if (!JSDOM) {
  test('UI-Tests übersprungen (jsdom fehlt — "npm install")', () => {});
} else {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost:3000/', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;

  /* ------------------------------------------------------------- Stubs */

  const gradient = { addColorStop() {} };
  const ctx2d = new Proxy(
    {},
    {
      get(t, k) {
        if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => gradient;
        if (k === 'measureText') return () => ({ width: 10 });
        if (k in t) return t[k];
        return () => {};
      },
      set(t, k, v) {
        t[k] = v;
        return true;
      },
    }
  );

  window.HTMLCanvasElement.prototype.getContext = () => ctx2d;
  window.AudioContext = FakeAudioContext;
  window.Element.prototype.setPointerCapture = function () {};
  window.Element.prototype.releasePointerCapture = function () {};
  window.Element.prototype.hasPointerCapture = function () {
    return true;
  };

  const downloads = [];
  window.HTMLAnchorElement.prototype.click = function () {
    downloads.push(this.download);
  };
  if (!window.URL.createObjectURL) window.URL.createObjectURL = () => 'blob:test';
  if (!window.URL.revokeObjectURL) window.URL.revokeObjectURL = () => {};
  window.confirm = () => false; // „New" nie bestätigen (kein Zustandsverlust im Test)

  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.message));
  process.on('unhandledRejection', (e) => errors.push(String(e && e.stack ? e.stack : e)));

  const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  def('window', window);
  def('document', doc);
  def('navigator', window.navigator);
  def('HTMLElement', window.HTMLElement);
  def('Element', window.Element);
  def('Node', window.Node);
  def('Event', window.Event);
  def('MouseEvent', window.MouseEvent);
  def('KeyboardEvent', window.KeyboardEvent);
  def('WheelEvent', window.WheelEvent);
  def('localStorage', window.localStorage);
  if (typeof globalThis.URL.createObjectURL !== 'function') {
    globalThis.URL.createObjectURL = () => 'blob:test';
    globalThis.URL.revokeObjectURL = () => {};
  }

  window.localStorage.clear();

  const mod = await import(`${path.join(ROOT, 'js/main.js')}?t=${Date.now()}`);
  const { project, engine, clock } = mod;
  const q = (sel) => doc.querySelectorAll(sel);
  const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  const click = (el, type = 'click') => el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true }));

  /* ------------------------------------------------------------- Aufbau */

  test('Rack wird vollständig aufgebaut', () => {
    eq(q('.knob').length, 24, '20 Rack-Knobs + 4 FX-Knobs');
    eq(q('#fxKnobs .knob').length, 4);
    eq(q('.mx-cell').length, 48);
    eq(q('.key').length, 24);
    eq(q('.seg').length, 7);
    eq(q('.track-row').length, 1);
    eq(doc.getElementById('projectName').value, project.name);
    eq(doc.getElementById('trackTag').textContent, '1 / 8');
  });

  test('Audio startet über das Gate', async () => {
    doc.getElementById('gateBtn').click();
    await wait(30);
    assert(engine.ctx, 'AudioContext fehlt');
    stopTimer(engine);
    assert(doc.body.classList.contains('audio-on'));
    assert(doc.getElementById('gate').classList.contains('hidden'));
  });

  test('Preset wirkt auf die aktive Spur', async () => {
    const select = doc.getElementById('presetSelect');
    select.value = '1';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(10);
    eq(project.tracks[0].patchName, 'Wobble Bass');
    eq(Math.round(project.tracks[0].patch.filter.cutoff), 420);
    const cutoffText = [...q('.knob-wrap')]
      .find((w) => w.querySelector('.k-label') && w.querySelector('.k-label').textContent === 'CUTOFF')
      .querySelector('.k-value').textContent;
    eq(cutoffText, '420 Hz');
    eq(doc.getElementById('presetSelect').options.length, PRESETS.length + 1, 'Presets + Custom');
  });

  test('Send-Regler schreibt in die Spur und ins Autosave', async () => {
    const row = q('.track-row')[0];
    const send = row.querySelector('.track-send-input.reverb');
    assert(send, 'Send-Regler fehlt');
    eq(Number(send.value), project.tracks[0].sends.reverb);
    send.value = '0.42';
    send.dispatchEvent(new window.Event('input', { bubbles: true }));
    await wait(10);
    eq(project.tracks[0].sends.reverb, 0.42);
    await wait(800);
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
    eq(stored.tracks[0].sends.reverb, 0.42);
  });

  test('FX-Auswahl steuert das Delay-Raster', async () => {
    const select = doc.getElementById('fxDivision');
    eq(select.options.length, DELAY_DIVISIONS.length);
    eq(select.value, project.fx.delayDivision);
    select.value = '1/4';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(10);
    eq(project.fx.delayDivision, '1/4');
    eq(delaySeconds(project), 0.5, '1/4 bei 120 BPM');
  });

  test('Neue Spur anlegen und auswählen', async () => {
    doc.getElementById('addTrackBtn').click();
    await wait(10);
    eq(project.tracks.length, 2);
    eq(q('.track-row').length, 2);
    eq(doc.getElementById('trackTag').textContent, '2 / 8');
    eq(project.activeTrackId, project.tracks[1].id);
  });

  test('Spurwechsel bindet das Rack auf den anderen Patch', async () => {
    const rows = q('.track-row');
    click(rows[0], 'pointerdown');
    await wait(10);
    eq(project.activeTrackId, project.tracks[0].id);
    const cutoffText = [...q('.knob-wrap')]
      .find((w) => w.querySelector('.k-label') && w.querySelector('.k-label').textContent === 'CUTOFF')
      .querySelector('.k-value').textContent;
    eq(cutoffText, '420 Hz');
    click(rows[1], 'pointerdown');
    await wait(10);
    eq(project.activeTrackId, project.tracks[1].id);
  });

  test('Mute und Solo schalten den Spurpegel', async () => {
    const row = q('.track-row')[1];
    click(row.querySelector('.track-btn.mute'));
    await wait(10);
    eq(project.tracks[1].mute, true);
    engine.ctx.currentTime += 0.05;
    engine.tick();
    near(engine.chains.get(project.tracks[1].id).gain.gain.value, 0, 0.001);
    click(row.querySelector('.track-btn.mute'));
    await wait(10);
    eq(project.tracks[1].mute, false);

    click(row.querySelector('.track-btn.solo'));
    await wait(10);
    eq(project.tracks[1].solo, true);
    engine.ctx.currentTime += 0.05;
    engine.tick();
    eq(engine.chains.get(project.tracks[0].id).gain.gain.value, 0);
    click(row.querySelector('.track-btn.solo'));
    await wait(10);
  });

  test('Spur umbenennen per Doppelklick', async () => {
    const row = q('.track-row')[1];
    click(row.querySelector('.track-name'), 'dblclick');
    const input = row.querySelector('.track-name-input');
    assert(input, 'Eingabefeld fehlt');
    input.value = 'Keys';
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(10);
    eq(project.tracks[1].name, 'Keys');
    eq(q('.track-row')[1].querySelector('.track-name').textContent, 'Keys');
  });

  test('Aufnahme landet im Loop der aktiven Spur', async () => {
    const track = project.tracks[1];
    doc.getElementById('recBtn').click();
    await wait(20);
    assert(clock.running, 'Transport läuft nicht');
    eq(clock.recording, true);
    if (clock._timer) {
      clearInterval(clock._timer);
      clock._timer = null;
    }
    engine.ctx.currentTime = clock.loopStart + 0.01;
    clock.noteOn(60, 0.9);
    engine.ctx.currentTime = clock.loopStart + 0.25;
    clock.noteOff(60);
    eq(track.clip.count, 1);
    eq(project.tracks[0].clip.count, 0);
    doc.getElementById('recBtn').click();
    await wait(10);
    eq(clock.recording, false);
    eq(doc.querySelectorAll('.track-row')[1].querySelector('.track-notes').textContent, '1 ♪');
  });

  test('Undo entfernt den Take', async () => {
    const track = project.tracks[1];
    doc.getElementById('undoBtn').click();
    await wait(10);
    eq(track.clip.count, 0);
    eq(doc.getElementById('undoBtn').disabled, true);
  });

  test('Autosave schreibt das Projekt in localStorage', async () => {
    doc.getElementById('projectName').value = 'Mein Song';
    doc.getElementById('projectName').dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(850);
    const raw = window.localStorage.getItem(STORAGE_KEY);
    assert(raw, 'kein Autosave-Eintrag');
    const parsed = JSON.parse(raw);
    eq(parsed.version, 2);
    eq(parsed.fx.delayDivision, project.fx.delayDivision);
    eq(parsed.tracks[0].sends.reverb, 0.42);
    eq(parsed.name, 'Mein Song');
    eq(parsed.tracks.length, 2);
  });

  test('JSON-Export löst Download aus', async () => {
    doc.getElementById('saveBtn').click();
    await wait(20);
    assert(downloads.some((d) => d && d.endsWith('.json')), 'kein JSON-Download: ' + downloads.join(', '));
    assert(doc.getElementById('toast').textContent.includes('JSON'));
  });

  test('MIDI-Export erzeugt Datei', async () => {
    doc.getElementById('midiExportBtn').click();
    await wait(20);
    assert(downloads.some((d) => d && d.endsWith('.mid')), 'kein MIDI-Download: ' + downloads.join(', '));
    assert(doc.getElementById('toast').textContent.includes('MIDI'));
  });

  test('MIDI-Import ersetzt das Projekt', async () => {
    const midiMod = await import(`${path.join(ROOT, 'js/midi-io.js')}`);
    // Noten anlegen, damit der Export/Import etwas zu übertragen hat
    project.tracks[0].clip.addEvents([
      { tick: 0, dur: 240, note: 60, vel: 0.8 },
      { tick: 480, dur: 240, note: 64, vel: 0.7 },
    ]);
    const bytes = midiMod.encodeProject(project);
    const file = { name: 'loop.mid', size: bytes.length, arrayBuffer: async () => bytes.buffer };
    const input = doc.getElementById('midiInput');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(60);
    eq(project.name, 'loop');
    eq(project.tracks.length, 1);
    eq(project.tracks[0].clip.count, 2);
    assert(doc.getElementById('toast').textContent.includes('MIDI importiert'),
      'Toast: ' + doc.getElementById('toast').textContent);
  });

  test('Kaputter MIDI-Import wird abgelehnt ohne Zustandsverlust', async () => {
    const before = project.name;
    const bad = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    const file = { name: 'kaputt.mid', size: bad.length, arrayBuffer: async () => bad.buffer };
    const input = doc.getElementById('midiInput');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(60);
    eq(project.name, before);
    assert(doc.getElementById('toast').textContent.includes('abgelehnt'),
      'Toast: ' + doc.getElementById('toast').textContent);
  });

  test('Löschen braucht zwei Klicks und schützt die letzte Spur', async () => {
    // letzte Spur: zweiter Klick darf nichts löschen
    doc.querySelector('.track-row .track-btn.del').click();
    await wait(10);
    doc.querySelector('.track-row .track-btn.del').click();
    await wait(10);
    eq(project.tracks.length, 1);

    // mit zwei Spuren: erst Bestätigung, dann Löschen
    doc.getElementById('addTrackBtn').click();
    await wait(10);
    eq(project.tracks.length, 2);
    const del = doc.querySelectorAll('.track-row')[1].querySelector('.track-btn.del');
    del.click();
    await wait(10);
    eq(project.tracks.length, 2, 'erster Klick darf nicht löschen');
    del.click();
    await wait(10);
    eq(project.tracks.length, 1);
  });

  test('Mix-Export meldet fehlende Browser-Unterstützung statt zu werfen', async () => {
    doc.getElementById('bounceBtn').click();
    await wait(30);
    const text = doc.getElementById('toast').textContent;
    assert(text.includes('nicht unterstützt') || text.includes('AUDIO STARTEN'), 'Toast: ' + text);
    eq(doc.getElementById('bounceBtn').disabled, false);
    assert(doc.getElementById('bounceLoops').options.length >= 2);
  });

  test('Transport, Scope und Loop-Leiste laufen ohne Fehler', async () => {
    doc.getElementById('playBtn').click();
    await wait(40);
    if (clock._timer) {
      clearInterval(clock._timer);
      clock._timer = null;
    }
    doc.getElementById('bpmUp').click();
    doc.getElementById('metroBtn').click();
    doc.getElementById('randBtn').click();
    doc.getElementById('clearBtn').click();
    doc.getElementById('panicBtn').click();
    await wait(80);
    eq(errors, []);
  });
}
