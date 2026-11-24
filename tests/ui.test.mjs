/* UI-Integrationstest (jsdom). Nur mit `npm run test:ui` bzw. `--ui` aktiv,
 * weil jsdom eine devDependency ist. Prüft die echte Verdrahtung von
 * index.html + js/main.js: Spuren, Preset-Bindung, Aufnahme, Autosave, Export.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, eq, assert, setFile, near } from './harness.mjs';
import { FakeAudioContext, stopTimer } from './support/fake-audio.mjs';
import { STORAGE_KEY, DELAY_DIVISIONS, delaySeconds, PROJECT_VERSION, INSTRUMENTS } from '../js/project.js';
import { PRESETS } from '../js/state.js';
import { buildSf2 } from './support/sf2-fixture.mjs';

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
    eq(parsed.version, PROJECT_VERSION);
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

  test('Drive-Regler schreibt den Insert der Spur', async () => {
    const row = q('.track-row')[0];
    const drive = row.querySelector('.track-send-input.drive');
    assert(drive, 'Drive-Regler fehlt');
    eq(Number(drive.value), project.tracks[0].insert.drive);
    drive.value = '0.6';
    drive.dispatchEvent(new window.Event('input', { bubbles: true }));
    await wait(10);
    eq(project.tracks[0].insert.drive, 0.6);
    drive.value = '0.6';
    drive.dispatchEvent(new window.Event('input', { bubbles: true }));
    eq(project.tracks[0].insert.drive, 0.6, 'Wert bleibt stabil');
  });

  test('Status-Panel zeigt Audio, Schema und Mitschnitt', async () => {
    const diag = doc.getElementById('diag');
    assert(diag, 'Status-Panel fehlt');
    const text = diag.textContent;
    assert(text.includes('Schema v'), 'Schema fehlt: ' + text);
    assert(text.includes(String(PROJECT_VERSION)), 'Version fehlt: ' + text);
    assert(text.includes('WAV-Mitschnitt'), text);
    assert(text.includes('MIDI'), text);
    assert(diag.querySelectorAll('.diag-row').length >= 4);
  });

  test('Instrument je Spur umschalten (Synth/Piano/Drums)', async () => {
    const row = q('.track-row')[0];
    const select = row.querySelector('.track-instrument-select');
    assert(select, 'Instrument-Auswahl fehlt');
    eq(select.options.length, INSTRUMENTS.length);
    eq(select.value, project.tracks[0].instrument);
    select.value = 'drums';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(10);
    eq(project.tracks[0].instrument, 'drums');
    eq(doc.getElementById('padTag').textContent, 'DRUMS');
    eq(doc.querySelector('.pads').dataset.instrument, 'drums');
  });

  test('Pads spielen Noten der aktiven Spur und werden aufgezeichnet', async () => {
    const pad = doc.querySelectorAll('.pad')[0];
    assert(pad, 'Pad fehlt');
    const note = Number(pad.dataset.note);
    eq(note, 36, 'erstes Pad ist die Kick');
    doc.getElementById('recBtn').click();
    await wait(20);
    if (clock._timer) {
      clearInterval(clock._timer);
      clock._timer = null;
    }
    engine.ctx.currentTime = clock.loopStart + 0.01;
    const before = project.tracks[0].clip.count;
    pad.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    await wait(30);
    eq(project.tracks[0].clip.count, before + 1, 'Pad-Schlag wurde nicht aufgenommen');
    clock.stop();
    await wait(10);
    clock.clearClip();
    await wait(10);
  });

  test('Rechner-Tastatur spielt bei Drum-Spur die Pads', async () => {
    eq(project.tracks[0].instrument, 'drums');
    doc.getElementById('recBtn').click();
    await wait(20);
    if (clock._timer) {
      clearInterval(clock._timer);
      clock._timer = null;
    }
    engine.ctx.currentTime = clock.loopStart + 0.01;
    const before = project.tracks[0].clip.count;
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    await wait(30);
    eq(project.tracks[0].clip.count, before + 1, 'Taste A wurde nicht aufgenommen');
    const events = project.tracks[0].clip.toTakes().flat();
    const last = events[events.length - 1];
    eq(last.note, 36, 'Taste A entspricht der Kick');
    doc.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'a', bubbles: true }));
    clock.stop();
    await wait(10);
    clock.clearClip();
    await wait(10);
  });

  test('Szenenleiste zeigt Szene A, legt B an und wechselt den Clip', async () => {
    const chips = () => [...q('#sceneChips .scene-chip')];
    eq(chips().length, 1, 'startet mit einer Szene');
    eq(chips()[0].textContent, 'A');
    assert(chips()[0].classList.contains('active'), 'Szene A muss aktiv sein');
    assert(doc.getElementById('delSceneBtn').disabled, 'letzte Szene ist nicht löschbar');
    eq(doc.getElementById('songEnabled').checked, false);
    eq(doc.getElementById('songChain').value, 'A');

    const sceneAId = project.activeSceneId;
    const countA = project.tracks[0].clips[sceneAId].count;

    click(doc.getElementById('addSceneBtn'));
    await wait(20);
    eq(chips().length, 2, 'zweite Szene fehlt');
    eq(chips()[1].textContent, 'B');
    const sceneBId = project.activeSceneId;
    assert(sceneBId !== sceneAId, 'neue Szene muss aktiv sein');
    assert(chips()[1].classList.contains('active'));
    eq(project.song.chain.length, 2, 'neue Szene hängt sich an die Kette');
    assert(project.tracks[0].clips[sceneBId], 'Clip für Szene B fehlt');
    eq(project.tracks[0].clips[sceneBId].count, 0, 'Szene B startet leer');
    eq(project.tracks[0].clips[sceneAId].count, countA, 'Szene A bleibt unberührt');
    eq(doc.getElementById('delSceneBtn').disabled, false);
    eq(doc.getElementById('songChain').value, 'A B');

    click(chips()[0]);
    await wait(20);
    eq(project.activeSceneId, sceneAId, 'Klick auf Chip A muss umschalten');
    assert(chips()[0].classList.contains('active'));
    eq(project.tracks[0].clip, project.tracks[0].clips[sceneAId], 'Alias folgt der aktiven Szene');
  });

  test('Song-Modus: Schalter und Kette werden geprüft übernommen', async () => {
    const songEl = doc.getElementById('songEnabled');
    const chainEl = doc.getElementById('songChain');
    const sceneIds = project.scenes.map((s) => s.id);

    songEl.checked = true;
    songEl.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(10);
    eq(project.song.enabled, true, 'Song-Modus muss aktiv sein');

    chainEl.value = 'A B A';
    chainEl.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(10);
    eq([...project.song.chain], [sceneIds[0], sceneIds[1], sceneIds[0]]);
    eq(chainEl.value, 'A B A', 'Kette wird normalisiert angezeigt');

    chainEl.value = 'A X';
    chainEl.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(10);
    eq([...project.song.chain], [sceneIds[0], sceneIds[1], sceneIds[0]], 'ungültige Kette bleibt unverändert');
    eq(chainEl.value, 'A B A', 'Eingabe wird zurückgesetzt');
    assert(doc.getElementById('toast').textContent.includes('Unbekannte Szene'), 'Toast: ' + doc.getElementById('toast').textContent);

    songEl.checked = false;
    songEl.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(10);
    eq(project.song.enabled, false);
    eq(errors, []);
  });

  test('Szene löschen räumt Clips und Kette auf', async () => {
    const chips = () => [...q('#sceneChips .scene-chip')];
    eq(chips().length, 2, 'für den Test müssen zwei Szenen existieren');
    const [sceneA, sceneB] = project.scenes;
    const notesA = project.tracks[0].clips[sceneA.id].count;
    click(chips()[1]);
    await wait(20);
    eq(project.activeSceneId, sceneB.id);

    window.confirm = () => true; // Löschen bestätigen
    click(doc.getElementById('delSceneBtn'));
    await wait(20);
    eq(project.scenes.length, 1, 'Szene B muss weg sein');
    eq(project.activeSceneId, sceneA.id, 'aktive Szene fällt zurück');
    eq(project.song.chain.includes(sceneB.id), false, 'Kette enthält die Szene nicht mehr');
    assert(!(sceneB.id in project.tracks[0].clips), 'Clip der Szene muss entfernt sein');
    eq(project.tracks[0].clips[sceneA.id].count, notesA, 'Noten der verbleibenden Szene bleiben');
    eq(chips().length, 1);
    eq(chips()[0].textContent, 'A');
    assert(doc.getElementById('delSceneBtn').disabled, 'letzte Szene ist wieder geschützt');
    eq(errors, []);
  });

  test('SF2: Datei laden, Preset wählen, Stimme kommt aus der Bank', async () => {
    eq(doc.getElementById('sf2Tag').textContent, 'KEINE DATEI');
    assert(doc.getElementById('sf2Preset').disabled, 'Preset-Auswahl ohne Bank gesperrt');
    assert(doc.getElementById('sf2Info').textContent.includes('keine Bank'), 'Hinweis fehlt');

    const bytes = buildSf2({
      presets: [
        { name: 'Piano', program: 0, bank: 0 },
        { name: 'Strings', program: 48, bank: 0 },
      ],
    });
    const loaded = await mod.importSf2Bytes(bytes, 'test.sf2');
    assert(loaded.ok, (loaded.errors || []).join(' | '));

    eq(doc.getElementById('sf2Tag').textContent, '2 PRESETS');
    eq(doc.getElementById('sf2Preset').options.length, 2);
    eq(doc.getElementById('sf2Preset').disabled, false);
    assert(doc.getElementById('sf2Info').textContent.includes('2 Presets'), doc.getElementById('sf2Info').textContent);
    eq(project.tracks[0].instrument, 'sf2', 'Spur nutzt jetzt SF2');
    eq(project.tracks[0].sample.preset, 'Piano');
    eq(project.tracks[0].sample.name, 'test.sf2');

    const voice = engine.noteOn(project.tracks[0].id, 60, 0.8);
    eq(voice.kind, 'sf2', 'Stimme muss aus der Bank kommen');
    voice.release(engine.ctx.currentTime);

    const presetSelect = doc.getElementById('sf2Preset');
    presetSelect.value = '1';
    presetSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(20);
    eq(project.tracks[0].sample.preset, 'Strings');
    eq(project.tracks[0].sample.program, 48);

    await wait(800); // Autosave ist entprellt
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
    eq(saved.tracks[0].sample.preset, 'Strings', 'Sample-Referenz landet im Autosave');
    eq(saved.tracks[0].instrument, 'sf2');

    const broken = await mod.importSf2Bytes(new Uint8Array([1, 2, 3]), 'kaputt.sf2');
    eq(broken.ok, false);
    assert(doc.getElementById('toast').textContent.includes('SF2 nicht lesbar'), doc.getElementById('toast').textContent);
    eq(doc.getElementById('sf2Tag').textContent, '2 PRESETS', 'kaputte Datei darf die Bank nicht ersetzen');
    eq(errors, []);
  });

  test('MIDI-Panel zeigt Zustand, Learn bleibt ohne Verbindung gesperrt', async () => {
    eq(doc.getElementById('midiStatus').textContent.length > 0, true);
    assert(doc.getElementById('midiLearnBtn').disabled, 'Learn muss ohne Verbindung gesperrt sein');
    eq(doc.getElementById('midiTarget').options.length, 15);
    assert(doc.getElementById('midiBinds').textContent.includes('keine Bindung'));
    doc.getElementById('midiConnectBtn').click();
    await wait(30);
    const toast = doc.getElementById('toast').textContent;
    assert(toast.includes('MIDI') || toast.includes('nicht unterstützt'), 'Toast: ' + toast);
    eq(doc.getElementById('midiStatus').textContent, 'AUS');
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
