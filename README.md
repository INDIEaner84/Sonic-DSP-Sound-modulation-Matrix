<div align="center">
  <h1>SONIC DSP — Modulation Matrix</h1>
  <p>Web-Audio-Studio: Synthesizer, Klavier und Drum-Kit mit Modulationsmatrix, Loop-Recorder, Spuren, Effekten, MIDI-In/Out und WAV-Mitschnitt.</p>
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

Jede Spur hat ein **Instrument**: `SYNTH` (der Patch mit Matrix), `PIANO` (Partiale + Hammer,
velocity-abhängig) oder `DRUMS` (Kit mit acht Pads, GM-Noten 36–49). Klavier und Kit sind
synthetisch erzeugt — keine Sample-Downloads, keine Lizenzfragen.

Jede Spur hat außerdem **Szenen**: bis zu acht Teile (A–H) mit je eigenem Clip. Ein
**Song-Modus** spielt eine Kette (`A A B A …`) automatisch durch; ohne Song-Modus loopt die
aktive Szene. Projektdatei-Schema ist v5, ältere Stände (v1–v4) werden beim Laden migriert.

Ein **Delay- und ein Reverb-Bus** liegen hinter den Spuren; jede Spur hat eigene Sends.
Die Reverb-Impulsantwort wird im Browser erzeugt (kein Sample-Download, keine Assets).
Für Percussion gibt es die Wellenform `NOISE`; fertige Mixe lassen sich in Echtzeit
aufnehmen und als WAV speichern.

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
| **Mix ⤓ WAV** | nimmt die laufende Ausgabe in Echtzeit auf (1/2/4 Loops + Ausklang) und speichert sie als WAV; im Song-Modus zählt ein Loop als **ein Ketten-Durchlauf**, das Metronom ist dabei stumm |
| **INST** in der Spurzeile | Instrument der Spur: SYNTH / PIANO / DRUMS |

Autosave: jede Änderung wird nach 700 ms in `localStorage` geschrieben
(`sonicdsp.project.v1`) und beim nächsten Start automatisch geladen (Statusanzeige neben
dem Projektnamen); beim Schließen wird zusätzlich sofort gespeichert. Ein kaputter
Autosave-Stand wird verworfen und als Toast gemeldet, nicht übernommen. Fehler landen
generell als Toast unten mittig im Bild.

Preset-Auswahl wirkt immer auf die **aktive Spur**:
Init Lead, Wobble Bass, Pluck Lead, Drift Pad, Res Sweep FX, Sub Bass, Noise Hat, Glass Bell.

### Szenen und Song-Modus

Über der Spurenliste sitzt die Szenenleiste: Chips `A B C …`, `+` / `−`, der Schalter
**SONG** und ein Feld für die Kette.

| Element | Wirkung |
| --- | --- |
| Szene-Chip `A B …` | Szene wählen – Aufnahme, Piano-Roll und Loop-Leiste zeigen deren Clip (max. 8 Szenen) |
| **+** | neue Szene (nächster freier Name) mit leerem Clip je Spur; sie hängt sich an die Kette |
| **−** | aktive Szene samt Inhalt löschen (Rückfrage; die letzte Szene bleibt geschützt) |
| **SONG** | Kette abspielen statt Loop der aktiven Szene; der laufende Schritt ist am Chip markiert |
| Kettenfeld | `A A B A` – ein Schritt pro Loop; unbekannte Namen werden mit Toast abgewiesen |
| **MIDI Export** | im Song-Modus eine Notenfolge über die ganze Kette, sonst `Wiederholungen` der aktiven Szene |

Die Loop-Länge (Takte, Tempo) gilt für alle Szenen; nur die Noten unterscheiden sich.
`Speichern (JSON)` enthält Szenen, aktive Szene und Kette; ältere Dateien landen beim Laden
automatisch in Szene A. Details: `docs/PLAN-SONG-MODUS.md`.

### Instrumente und Pads

| Instrument | Klang | Bedienung |
| --- | --- | --- |
| **SYNTH** | der Patch: zwei Oszillatoren, Filter, Hüllkurven, Matrix, LFOs | Rack links/rechts, Preset-Auswahl |
| **PIANO** | fünf verstimmte Partiale + Hammer-Noise, Ausklingen je Lage | Tastatur/Pads/MIDI; velocity steuert Helligkeit und Lautstärke |
| **DRUMS** | Kick, Snare, Clap, Hat zu/open, Tom, Rim, Crash (synthetisch) | die acht Pads im Panel „Pads“ oder Noten 36–49 |

Pads lassen sich mit der Maus, der Rechner-Tastatur und über MIDI spielen; im Aufnahme-Modus
landen Pad-Schläge als Noten im Loop der aktiven Spur. Ist die aktive Spur eine Drum-Spur,
spielt die Rechner-Tastatur (`A S D F …`) direkt die Pads statt Tonhöhen.

### Status-Panel (Browser-Abnahme)

Zeigt live: Audio-Zustand und Samplerate, Projekt (Schema-Version, Spuren, Noten), MIDI
(verbunden/Anzahl), WAV-Mitschnitt (verfügbar) und den Autosave-Zustand. Damit lässt sich
beim manuellen Test in zwei Sekunden sehen, was der Browser tatsächlich kann.

### MIDI-Controller (z. B. Nektar Impact)

| Element | Wirkung |
| --- | --- |
| **Verbinden** | fragt `navigator.requestMIDIAccess()` an (Web MIDI, ohne SysEx) und listet alle Eingänge |
| Noten | spielen die aktive Spur; Drum-Noten schlagen die Pads an (Pad leuchtet) |
| **LERNEN + CC anlernen** | Ziel wählen, Knopf drücken, am Controller einen Regler/eine Taste bewegen → Bindung wird gespeichert |
| Bindungen | `CC x · Kanal y → Ziel`, pro Projekt gespeichert, einzeln löschbar (×) |
| Monitor | zeigt die zuletzt empfangene Nachricht (`CH 1 · CC 74 · Wert 96`) |

Ziele: Master, Mod-Wheel, Delay-Feedback/-Tone, Reverb-Größe/-Damp, Pegel/Sends der aktiven
Spur sowie Play, Stop, Play/Stop, Record, Loop leeren und Panic.

**Nektar Impact (GX/LX/…):** Die Pads senden Noten (üblicherweise Kanal 10) und spielen damit
direkt das Drum-Kit. Transport-, Mixer- und Preset-Tasten senden je nach Modell und Firmware
unterschiedliche CC-Nummern — dafür gibt es keine fest geratene Belegung: einmal
„CC anlernen“ drücken, Taste am Gerät betätigen, fertig. Der Monitor zeigt dabei den
tatsächlichen CC an. Die Bindungen liegen im Projekt (JSON), nicht im Browser-Speicher des
Geräts.

### Effekte (FX-Feld im Tracks-Panel)

| Element | Wirkung |
| --- | --- |
| **DLY / REV** in der Spurzeile | Send-Anteil dieser Spur (post-fader, also von Mute/Solo erfasst) |
| **DRV** in der Spurzeile | Drive-Insert der Spur (Sättigung mit Makeup, wirkt vor dem Fader) |
| **DELAY** (Auswahl) | Raster der Delay-Zeit: 1/16 … 1/2, folgt dem Tempo |
| **FEEDBACK** | Rückkopplung des Delays (0–85 %, höher = riskanter) |
| **TONE** | Tiefpass im Delay-Rückweg (300 Hz … 9 kHz) |
| **REVERB** | Größe der Impulsantwort (0,3 … 8 s) |
| **DAMP** | Dämpfung des Reverb-Rückwegs |

Die Sends liegen hinter dem Fader: ein stumm geschalteter Kanal läuft nicht in die Effekte.
Der Drive-Insert sitzt dagegen **vor** dem Fader (Pan → Drive → Fader), damit der Pegel das
Anzerren nicht wieder herausrechnet.
Ein Wechsel der Wellenform wirkt nur auf neu startende Noten; laufende Rausch-Stimmen
behalten ihre Quelle bis zum Ende der Note.

## Aufbau

```
index.html          Rack-Aufbau (Panels, Matrix, Keyboard, Gate, Spuren/Projekt)
css/style.css       Design (dunkles Hardware-Rack, Amber/Cyan)
js/state.js         Patch-Modell, Bereiche/Enums, Presets, Zufall
js/project.js       Projekt-Schema, Validierung, localStorage, Datei-I/O, Kontext
js/clip.js          Loop-Inhalt als Noten-Events, Takes, Undo
js/midi-io.js       SMF-Encoder/Decoder (Format 0/1), ohne Dependencies
js/midi-input.js    Web-MIDI-Eingang: Parser, CC-Learn, Geräte (ohne DOM testbar)
js/audio.js         Audio-Engine: Spuren-Ketten, Synth-/Piano-/Drum-Stimmen, FX-Busse, Metronom
js/clock.js         Transport, Lookahead-Scheduler, Quantize, Swing, Aufnahme-Logik
js/wav.js           WAV-Encoder (16 Bit PCM), ohne Browser-Abhängigkeit
js/recorder.js      Mix-Mitschnitt (MediaRecorder) und Umkodierung nach WAV
js/ui.js            Knobs, Slider, Matrix, Keyboard, Scope, Loop-Leiste, Spurenliste
js/main.js          Verdrahtung von Projekt, Engine, Clock und UI
server.cjs          Statischer Server (node, ohne Dependencies)
tests/              Testsuite (node, ohne Test-Framework, jsdom nur für UI-Tests)
```

## Signalfluss

```
Spur 1 ─ OSC 1 ─┐
        OSC 2 ─┴─► VCF (LP/BP/HP) ─► VCA (Amp-Env) ─► Pan ─► Gain ─┬─► Bus ─┐
Spur 2 …                                                        │         │
                                                                │         ▼
                                          Send DLY ─► Delay ◄───┘   Master ─► Compressor ─► Analyser ─► Out
                                          Send REV ─► Reverb ◄───┘      ▲
   Matrix: 6 Quellen × 8 Ziele ─────────────────────────────────────────┴─► Pitch / Level / Cutoff / Reso / Pan / LFO-Rate

Clock (Lookahead 25 ms / 120 ms Vorlauf, Ticks 480 PPQ)
   └─► Clip-Events ──► Engine.noteOn(spur, note, vel, when)  (Startzeit exakt im Raster)
```

Mute/Solo werden zentral über `trackAudible()` in den Spur-Gain geschrieben, nicht über
die Note-Logik — dadurch bleiben geplante Releases konsistent.

## Tests

```bash
npm test           # 134 Tests: Projekt/Clip/MIDI/Engine/Clock/WAV/Recorder/MIDI-In
npm run test:ui    # zusätzlich 28 jsdom-Integrationstests (162 gesamt)
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
| E4 | Effekt-Sends (Delay/Reverb), Rausch-Oszillator, zusätzliche Presets | fertig |
| E5 | Mix-Mitschnitt als WAV | fertig (Browser-Teil manuell zu prüfen) |
| E6 | Instrumente je Spur (Klavier, Drum-Kit, Pads), Web-MIDI-Eingang mit CC-Learn | fertig (Web MIDI nur im Browser prüfbar) |
| E7 | Spur-Insert (Drive) und Status-Panel | fertig |
| E8 | Song-Modus: Szenen, Kette, MIDI-Export der Kette (Schema v5) | fertig (Browser-Abnahme des Durchlaufs offen) |
| E9 | SoundFont-/Sample-Instrumente | vorbereitet, Assets und Lizenz extern blockiert – `docs/SOUNDFONT-PLAN.md` |

Details und Begründungen: `docs/KOMPONIEREN-KONZEPT.md`, offene Punkte und
Entscheidungen: `docs/PROBLEME-UND-ENTSCHEIDUNGEN.md`.

## Hinweise

- Kopfhörer oder Monitore empfohlen; Ausgabe läuft über einen Kompressor gegen Clipping.
- Die Engine läuft komplett lokal, es werden keine Daten gesendet.
- `Master` und `Mod-Wheel` bleiben beim Presetwechsel erhalten.
- Ohne Build-Schritt: alle Dateien sind direkt auslieferbar (`index.html` + `js/*` + `css/*`).
- Der WAV-Mitschnitt läuft in Echtzeit (Faktor 1) und braucht eine Audioausgabe; in
  Browsern ohne `MediaRecorder` bleibt der Knopf wirkungslos und meldet das per Toast.
- Projekte aus älteren Ständen (Schema 1 und 2) werden beim Laden automatisch übernommen.
- Web MIDI braucht einen Browser mit `navigator.requestMIDIAccess` (Chrome/Edge; Firefox
  nur mit Freigabe) und eine Nutzeraktion für die Berechtigung — ohne Zugriff bleibt das
  Panel bei „AUS“ und die Tastatur funktioniert unverändert.
- „VST“ im engeren Sinn (native Plugins) gibt es im Browser nicht; Klavier und Kit sind
  eingebaute Synth-Instrumente. Sample-basierte Instrumente (SF2) sind als nächste Stufe
  vorgesehen.
