<div align="center">
  <h1>SONIC DSP — Modulation Matrix</h1>
  <p>Polyphoner Web-Audio-Synthesizer mit Modulationsmatrix, Loop-Recorder, Spuren und MIDI-Import/Export.</p>
</div>

## Was ist das?

Eine komplette GUI + Sound-Engine im Browser — ohne Build-Tools, ohne Laufzeit-Dependencies.
Acht Spuren mit eigenem Patch laufen durch je einen eigenen Filter- und Amp-Zweig; zwei
Oszillatoren pro Spur, sechs Modulationsquellen werden über eine 6 × 8 Matrix auf acht
Ziele geroutet.

Dazu ein **Loop-Recorder mit Transport**: Metronom, Count-in, Quantize, Swing, Overdub in
Takes und Undo. Aufgenommen werden MIDI-Events (Note/Zeit/Velocity/Dauer), kein Audio —
damit bleibt alles editierbar, als JSON speicherbar und als Standard-MIDI-Datei
exportierbar.

**Quellen:** LFO 1 · LFO 2 · ENV 2 · Velocity · Mod-Wheel · Key-Track
**Ziele:** Pitch 1 · Pitch 2 · Level 1 · Level 2 · Cutoff · Resonanz · Pan · LFO-1-Rate

Jede Zelle ist bipolar (−100 … +100). Die Summe aller Zellen wird pro Stimme auf
Control-Rate (60 Hz) berechnet und geglättet in die AudioParams geschrieben.

## Starten

```bash
npm start          # http://localhost:3000
# oder
node server.cjs
# oder mit anderem Port
PORT=8080 node server.cjs
```

Danach im Browser öffnen und **AUDIO STARTEN** klicken (Browser verlangen eine
Nutzerinteraktion, bevor Web Audio laufen darf).

## Bedienung

| Aktion | Wirkung |
| --- | --- |
| Knob ziehen (vertikal) | Wert ändern, `Shift` = fein |
| Mausrad über Knob | Wert ändern |
| Doppelklick auf Knob/Zelle | Reset |
| Matrix-Zelle ziehen | Betrag −100 … +100 |
| Tasten `A W S E D F T G Y H U J K` | Noten in der aktiven Spur spielen |
| `Z` / `X` | Oktave runter / rauf |
| Mod-Wheel ziehen | Modulationsquelle `MOD WHEEL` |
| Random / Clear | Matrix zufällig belegen / leeren |
| Panic | Alle Stimmen freigeben |
| `Space` | Play / Stop |
| `Esc` | Alles aus (Panic) |

**Wichtig:** Das Rack (Oszillatoren, Filter, Matrix, Preset-Auswahl) bearbeitet immer den
Patch der **aktiven Spur**. Aktive Spur wechseln = Zeile in der Spurenliste anklicken.

### Loop-Recorder (Transportleiste)

| Element | Wirkung |
| --- | --- |
| **Rec** | startet den Transport mit 1 Takt Count-in und scharf geschalteter Aufnahme |
| **Play / Stop** | Transport ohne Aufnahme starten/stoppen |
| **Loop 1 · 2 · 4 · 8 · 16** | Loop-Länge in Takten (live umschaltbar) |
| **Quantize** | OFF · 1/8 · 1/16 · 1/32 – rastet aufgenommene Noten ein |
| **Swing** | verschiebt ungerade Zählzeiten (0–60 %) |
| **Tempo** | 120 BPM Default, ±1 (Shift ±5), Mausrad über dem Feld |
| **Metro** | Metronom an/aus (Klick synthetisch, kein Sample) |
| **Undo** | letzten Take verwerfen |
| **Clear Clip** | Loop der aktiven Spur leeren |

Ablauf: `Rec` → Count-in → spielen → der Loop wiederholt sich, jede weitere Runde
kannst du mit `Rec` eine neue Schicht (Take) drüberlegen. Die Leiste über dem Keyboard
zeigt die Noten farbig pro Take und den Playhead.

### Spuren und Projekt

| Element | Wirkung |
| --- | --- |
| **+ Spur** | neue Spur mit eigenem Patch (max. 8) |
| Spurname doppelklicken | umbenennen |
| **M** / **S** | Mute / Solo (Solo hat Vorrang; Pegel werden zentral berechnet) |
| Pegelregler in der Zeile | Spur-Lautstärke |
| **×** | löschen – zwei Klicks (erster Klick fragt nach, letzte Spur bleibt geschützt) |
| **Projektname** | frei editierbar, wird mitgespeichert |
| **Speichern (JSON)** | Download der Projektdatei |
| **Laden (JSON)** | Projekt aus Datei übernehmen |
| **Neu** | leeres Projekt (mit Rückfrage) |
| **MIDI Export** | Standard-MIDI-Datei (Format 1), Wiederholungen 1–16 wählbar |
| **MIDI Import** | MIDI-Datei als Projekt übernehmen (max. 8 Spuren) |

Autosave: jede Änderung wird nach 700 ms in `localStorage` geschrieben
(`sonicdsp.project.v1`) und beim nächsten Start automatisch geladen (Statusanzeige neben
dem Projektnamen); beim Schließen wird zusätzlich sofort gespeichert. Ein kaputter
Autosave-Stand wird verworfen und als Toast gemeldet, nicht übernommen. Fehler landen
generell als Toast unten mittig im Bild.

Presets: Init Lead, Wobble Bass, Pluck Lead, Drift Pad, Res Sweep FX.

## Aufbau

```
index.html          Rack-Aufbau (Panels, Matrix, Keyboard, Gate, Spuren/Projekt)
css/style.css       Design (dunkles Hardware-Rack, Amber/Cyan)
js/state.js         Patch-Modell, Bereiche/Enums, Presets, Zufall
js/project.js       Projekt-Schema, Validierung, localStorage, Datei-I/O, Kontext
js/clip.js          Loop-Inhalt als Noten-Events, Takes, Undo
js/midi-io.js       SMF-Encoder/Decoder (Format 0/1), ohne Dependencies
js/audio.js         Audio-Engine: Spuren-Ketten, Voices, ADSR, LFOs, Matrix, Metronom
js/clock.js         Transport, Lookahead-Scheduler, Quantize, Swing, Aufnahme-Logik
js/ui.js            Knobs, Slider, Matrix, Keyboard, Scope, Loop-Leiste, Spurenliste
js/main.js          Verdrahtung von Projekt, Engine, Clock und UI
server.cjs          Statischer Server (node, ohne Dependencies)
tests/              Testsuite (node, ohne Test-Framework, jsdom nur für UI-Tests)
```

## Signalfluss

```
Spur 1 ─ OSC 1 ─┐
        OSC 2 ─┴─► VCF (LP/BP/HP) ─► VCA (Amp-Env) ─► Pan ─► Gain ─┐
Spur 2 …                                                        │
                                                                ▼
                                   Bus ─► Master ─► Compressor ─► Analyser ─► Out
                                    ▲
   Matrix: 6 Quellen × 8 Ziele ─────┴─► Pitch / Level / Cutoff / Reso / Pan / LFO-Rate

Clock (Lookahead 25 ms / 120 ms Vorlauf, Ticks 480 PPQ)
   └─► Clip-Events ──► Engine.noteOn(spur, note, vel, when)  (Startzeit exakt im Raster)
```

Mute/Solo werden zentral über `trackAudible()` in den Spur-Gain geschrieben, nicht über
die Note-Logik — dadurch bleiben geplante Releases konsistent.

## Tests

```bash
npm test           # 71 Tests: Projekt/Clip/MIDI/Engine/Clock
npm run test:ui    # zusätzlich 16 jsdom-Integrationstests (87 gesamt)
```

Die Tests laufen ohne Framework (`node:test`-frei, eigener Mini-Runner in
`tests/run.mjs`). jsdom ist die einzige Dev-Dependency und wird nur für `test:ui`
gebraucht. Geprüft werden u. a. JSON-Roundtrip mit Idempotenz, MIDI-Roundtrip inklusive
Running Status/SysEx/VLQ, Voice-Stealing, Scheduler-Fenster, Quantize/Swing und der
komplette UI-Fluss (Spur anlegen, umbenennen, aufnehmen, exportieren, importieren).

## Roadmap

| Etappe | Inhalt | Stand |
| --- | --- | --- |
| E1 | Transport, Loop-Recorder, Overdub, Quantize, Swing, Playhead | fertig |
| E2 | Spuren mit eigenem Patch, Projekt-JSON, localStorage-Autosave | fertig |
| E3 | MIDI-Export/Import (Standard-MIDI-Datei) | fertig |
| E4 | SoundFont-Instrumente (`smplr`), Delay/Reverb-Sends, WAV-Bounce | offen |

Details und Begründungen: `docs/KOMPONIEREN-KONZEPT.md`, offene Punkte und
Entscheidungen: `docs/PROBLEME-UND-ENTSCHEIDUNGEN.md`.

## Hinweise

- Kopfhörer oder Monitore empfohlen; Ausgabe läuft über einen Kompressor gegen Clipping.
- Die Engine läuft komplett lokal, es werden keine Daten gesendet.
- `Master` und `Mod-Wheel` bleiben beim Presetwechsel erhalten.
- Ohne Build-Schritt: alle Dateien sind direkt auslieferbar (`index.html` + `js/*` + `css/*`).
