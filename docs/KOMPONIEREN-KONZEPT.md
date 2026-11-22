# Vom Klanglabor zum Komponieren

Konzept: Wie aus der aktuellen Modulation-Matrix-GUI ein Werkzeug wird, in dem man
**loopen, drüberspielen, als MIDI speichern und verschiedene Sounds nutzen** kann —
inklusive Empfehlung, welche Open-Source-Bausteine sich lohnen.

---

## 1. Diagnose: warum man damit noch nicht komponieren kann

Die jetzige GUI ist ein **Klanglabor**: ein Zustand (Patch), kein Verlauf. Komponieren
braucht aber Zeit, Wiederholung und Erinnerung.

| Was fehlt | Warum das blockiert | Lösung |
| --- | --- | --- |
| Keine Zeitbasis | Kein Metronom, kein Takt → nichts ist „im Grid" | Transport + Clock |
| Keine Aufnahme | Was du spielst, ist nach dem Loslassen weg | Note-Recorder (Events, **kein** Audio) |
| Keine Wiederholung | Man hört nie eine Idee zweimal | Loop 1–16 Takte |
| Kein Kontext | Einzelklang statt Musik | Spuren mit je eigenem Patch |
| Kein Speichern | Jeder Neustart beginnt bei Null | JSON-Projekt + MIDI-Export |
| Nur ein Synth | „anderer Sound" heißt: alles neu schrauben | Instrument-Presets + SoundFont-Bank |

**Wichtig:** Aufnahme als **MIDI-Events** (Note, Zeit, Velocity, Dauer), nicht als Audio.
Nur so bleibt alles editierbar, quantisierbar, transponierbar und exportierbar.

---

## 2. Drei Ebenen — in dieser Reihenfolge bauen

```
Ebene 1  SOUND   Patch = Wellenformen, Filter, Hüllkurven, Matrix      ← existiert
Ebene 2  ZEIT    Transport, Loop, Aufnahme, Overdub, Quantize          ← als Nächstes
Ebene 3  SONG    Spuren, Szenen/Arrangement, Effekte, Export           ← danach
```

Nicht alles gleichzeitig: Ebene 2 allein macht aus der GUI schon ein Instrument, mit dem
man Ideen festhalten kann.

---

## 3. Die fünf Flows, die es intuitiv machen

### 3.1 Ein-Knopf-Looping (der Kern)

```
[ ● REC ]  →  1 Takt Count-in  →  Loop läuft  →  du spielst  →  Loop wiederholt sich
                                    ↓
                          [ OVERDUB ]  nächste Schicht, nichts wird gelöscht
                                    ↓
                          [ UNDO ]     letzten Take verwerfen
```

- **REC** startet beim ersten Tastendruck („wait for note") oder nach Count-in.
- Beim Loop-Ende werden offene Noten sauber geschlossen (sonst hängt der Ton).
- **Overdub** ist der Default nach dem ersten Take — kein Moduswechsel nötig.
- **Undo** pro Take, nicht global.

### 3.2 Auto-Quantize mit Swing

Note-Ons werden beim Aufnehmen auf ein Raster gelegt: `off · 1/8 · 1/16 · 1/32`,
Swing 50–70 %. Damit klingt der erste Take sofort „tight", ohne Menüstudium.
Die **rohen** Zeiten bleiben im Event erhalten (`tRaw`), Quantize ist umschaltbar.

### 3.3 Sichtbare Zeit

- Transportleiste mit Taktzähler (`3.2.1`) und Loop-Fortschritt.
- Dünne **Loop-Leiste über dem Keyboard**: farbige Punkte = gespielte Noten,
  wandernder Playhead. Das ist ein Mini-Piano-Roll ohne eigene Seite.
- Beim Einspielen leuchten die Tasten — man sieht sofort, was schon drin ist.

### 3.4 Soundwechsel in einem Klick

- Jede **Spur** hat einen Patch (Name + Mini-Matrix-Vorschau).
- Der Preset-Dropdown wird zum **Instrument-Browser** mit Kategorien
  (Bass · Keys · Pad · Lead · Pluck) statt roher Wellenformnamen.
- **A/B-Slot** pro Spur: zwei Patches, ein Klick zum Vergleichen (klassisches
  „welcher klingt besser"-Werkzeug).
- „Anderer Sound" ohne Schrauben: SoundFont-Bank (siehe §7).

### 3.5 Ein-Klick-Export

| Ziel | Format | Inhalt |
| --- | --- | --- |
| DAW weiterarbeiten | `.mid` (SMF Typ 1, PPQ 480) | Tempo, Spuren, Noten, Namen |
| Projekt sichern/teilen | `.json` | Spuren + Patches + Matrix + Loop |
| „Als Audio verschicken" | `.wav` | Offline-Render, 44,1 kHz/16 Bit |

---

## 4. Neue Oberfläche (Wireframe)

Die bestehende Rack-Optik bleibt — es kommen zwei Zeilen dazu und der Keybed wird
zur Aufnahme-Zone.

```
┌ TRANSPORT ───────────────────────────────────────────────────────────────┐
│ ● REC  ⏵ ⏸ ⏹   LOOP 4 Bars   Q 1/16   SWING 54%   BPM 120    3.2.1  ▓▓▓░ │
└──────────────────────────────────────────────────────────────────────────┘
┌ TRACKS ──────────────────────────────────────────────────────────────────┐
│ 1  BASS   Wobble Bass      ▁▃▅▇▅▃   [M] [S] [A/B]   Vol ▓▓▓▓░            │
│ 2  KEYS   Drift Pad        ▁▂▄▆▄▂   [M] [S] [A/B]   Vol ▓▓▓░░            │
│ 3  LEAD   Init Lead        ● live    [M] [S] [A/B]   Vol ▓▓▓▓▓            │
└──────────────────────────────────────────────────────────────────────────┘
┌ RACK (wie bisher) ───────────────────────────────────────────────────────┐
│  OSC 1/2 │ MODULATION MATRIX (6×8) │ FILTER │ ENV 1/2 │ LFO 1/2 │ SCOPE  │
└──────────────────────────────────────────────────────────────────────────┘
┌ KEYS ────────────────────────────────────────────────────────────────────┐
│  ●●● ●  ●●● ● ●●●● ●  ●  ← Noten des Loops als Punkte über den Tasten   │
│  [C3 … B4]                                            MOD ▮  PITCH ▮     │
└──────────────────────────────────────────────────────────────────────────┘
```

**Umsetzung im Code**

| Neu | Datei | Aufgabe |
| --- | --- | --- |
| `js/clock.js` | neu | Transport, BPM, Taktzähler, Loop-Grenzen, Lookahead-Scheduler |
| `js/clip.js` | neu | Event-Aufnahme, Quantize, Overdub, Undo, Loop-Inhalt |
| `js/project.js` | neu | Spuren, Patches, JSON-Import/Export, IndexedDB |
| `js/midi-io.js` | neu | `.mid` schreiben/lesen |
| `js/audio.js` | erweitern | `noteOn(note, vel, when, track)` — Startzeit statt „jetzt" |
| `js/ui.js` | erweitern | Transportleiste, Track-Liste, Loop-Overlay am Keyboard |
| `js/main.js` | erweitern | Verdrahtung REC/OVERDUB/UNDO, Spur-Fokus |

Der Audio-Teil ist schon fast bereit: `Engine.noteOn()` muss nur eine **Startzeit**
akzeptieren, damit geplante Noten exakt im Raster landen.

---

## 5. Datenmodell

```jsonc
{
  "version": 1,
  "bpm": 120,
  "ppq": 480,              // Ticks pro Viertel
  "loop": { "bars": 4, "beatsPerBar": 4, "grid": 0.25, "swing": 0.0 },
  "tracks": [
    {
      "id": "t1",
      "name": "BASS",
      "patch": { /* kompletter Patch wie in js/state.js */ },
      "mute": false,
      "solo": false,
      "gain": 0.8,
      "events": [
        { "tick": 0,   "dur": 240, "note": 36, "vel": 0.9, "tRaw": 0.0021 },
        { "tick": 240, "dur": 240, "note": 36, "vel": 0.7, "tRaw": 0.2504 },
        { "tick": 480, "dur": 240, "note": 43, "vel": 0.9, "tRaw": 0.5012 }
      ]
    }
  ]
}
```

- `tick` = quantisierte Position, `tRaw` = tatsächlich gespielt (für „Quantize aus").
- `dur` in Ticks — ergibt sich aus Note-On/Note-Off, spätestens bei Loop-Ende gekappt.

---

## 6. Clock & Scheduler (der kritische Teil)

**Nicht** mit `requestAnimationFrame` oder nacktem `setInterval` Noten triggern — das
jittert hörbar. Standardlösung: **Lookahead-Scheduler**.

```js
// alle 25 ms prüfen, Noten 100 ms im Voraus planen
const LOOKAHEAD_MS = 25, SCHEDULE_AHEAD = 0.1; // Sekunden

function scheduler() {
  const now = audioCtx.currentTime;
  // Loop-Position in Sekunden = ((now - loopStart) % loopDur)
  for (const ev of clip.eventsInWindow(now, now + SCHEDULE_AHEAD)) {
    const when = loopStart + Math.floor((now - loopStart) / loopDur) * loopDur + ev.timeInLoop;
    engine.noteOn(ev.note, ev.vel, when);        // Startzeit, nicht "jetzt"
  }
  setTimeout(scheduler, LOOKAHEAD_MS);
}
```

- Einzige Zeitbasis ist `AudioContext.currentTime` (monoton, Audio-Clock).
- Der bestehende 15-ms-`tick()` für die **Modulation** bleibt unverändert —
  Clock (Noten) und Control-Rate (Modulation) sind getrennte Aufgaben.
- Taktzähler rein rechnerisch: `Math.floor(pos / secPerBeat)` bzw. Ticks/PPQ.
- Count-in, Loop-Neustart und Tempoänderung wirken erst zum nächsten Taktrand
  („quantized transport start") — sonst klingt es kaputt.

---

## 7. „Andere Sounds" — drei Wege

| Weg | Aufwand | Klang | Wann |
| --- | --- | --- | --- |
| **A) Interne Engine** (heute) | 0 | synthy, aber eigenständig | immer, als Basis |
| **B) Samples / SoundFont-Bank** (`smplr`, `soundfont-player`) | mittel | echtes Piano, Streicher, Drums | wenn es „nach Instrument" klingen soll |
| **C) Echte `.sf2`-Dateien** (`js-synthesizer` = FluidSynth als WASM) | hoch | komplettes GM-Set aus einer Datei | wenn Nutzer eigene SoundFonts laden sollen |

Empfehlung: **A + B**. Interne Engine bleibt der Charakter-Sound; Samples kommen für
Instrumente dazu, die man nicht schrauben will (Piano, Bass, Drums, Strings).
`js-synthesizer` lohnt erst, wenn `.sf2`-Import ein Verkaufsargument ist — WASM + Bank
kosten mehrere MB und Ladezeit.

**Beispiel B (smplr):**

```js
import { Soundfont } from 'smplr';
const ctx = new AudioContext();
const piano = new Soundfont(ctx, { instrument: 'acoustic_grand_piano' });
await piano.load;
piano.start({ note: 60, velocity: 90, time: ctx.currentTime + 0.1 });
// → in Engine.noteOn() als Alternative zum Oszillator-Pfad einhängen
```

**Effekte pro Spur** (macht den Unterschied zwischen „trocken" und „Mix"):
Delay (Feedback 0,25 · Zeit synced 1/8 punktiert), Reverb (Convolver mit synthetisch
erzeugter IR — kein Sample-Download nötig), Sättigung. Entweder selbst mit Web Audio
(Convolver/DelayNode, ~80 Zeilen) oder `Tone.js` (fertige `Reverb`, `FeedbackDelay`,
`Chorus`, `Compressor`).

---

## 8. Open-Source-Bausteine (Lizenzen aus der npm-Registry geprüft)

| Paket | Version | Lizenz | Wofür | Einsatz |
| --- | --- | --- | --- | --- |
| `tone` | 15.1 | **MIT** | Transport, Effekte, fertige Synths | optional: Clock + Effekte statt Eigenbau |
| `@tonejs/midi` | 2.0.28 | **MIT** | `.mid` lesen **und** schreiben, Tempo, PPQ | **MIDI-Export/Import** |
| `midi-writer-js` | 3.2.1 | **MIT** | MIDI schreiben (einfacher, nur Export) | Alternative zu oben |
| `midi-file` | 1.2.4 | **MIT** | Low-Level MIDI-Parser/Writer | wenn Sonderfälle gebraucht werden |
| `smplr` | 1.2.0 | **MIT** | Sample-Instrumente im Browser (Piano, GM) | **Sound-Wechsel** |
| `soundfont-player` | 0.12.0 | **MIT** | SoundFont-Instrumente aus URLs | Alternative zu `smplr` |
| `js-synthesizer` | 1.13.0 | **BSD-3** | FluidSynth (WASM) → echte `.sf2` | nur falls SF2-Import nötig |
| `spessasynth_lib` | 4.4.10 | **Apache-2.0** | SF2/DLS-Playback + MIDI-Rendering | Alternative zu `js-synthesizer` |
| `webaudio-tinysynth` | 1.1.3 | **Apache-2.0** | winziger GM-Synth | wenn es leicht bleiben soll |
| `tonal` | 6.8.0 | **MIT** | Skalen, Akkorde, Transponieren | Akkord-Spur, „Snap to Scale" |
| `webmidi` | 3.3.1 | **Apache-2.0** | Web-MIDI-Helfer (Hardware-Keyboard) | optional, `navigator.requestMIDIAccess` reicht |
| `lz-string` | 1.5.0 | **MIT** | Projekt in URL-Hash komprimieren | Teilen-Link |
| `wavesurfer.js` | 8.1.0 | **BSD-3** | Waveform für Audio-Loops | erst wenn Audio-Loops kommen |
| `vexflow` | 5.9.0 | **MIT** | Notensatz | optional „Notenbild zum Clip" |
| `@magenta/music` | 1.23.1 | **Apache-2.0** | MIDI-Datasets, Melodie-Generierung | Experiment, kein Muss |
| `extendable-media-recorder` | 9.2.40 | **MIT** | Audio-Aufnahme als WAV | nur für Mikro/„Audio-Loop" |

**Bewusst nicht als Code übernehmen** (AGPL/GPL = Copyleft auch für Web-Auslieferung):

| Projekt | Lizenz | Stattdessen |
| --- | --- | --- |
| Strudel / TidalCycles | AGPL-3.0 | Pattern-Ideen nachbauen |
| LMMS, Ardour, Zrythm, Helio | GPL/AGPL | **UX-Referenz** ansehen, nicht Code |
| OpenSheetMusicDisplay | laut npm BSD-3, Projektseite nennt AGPL → prüfen | `vexflow` (MIT) |

Faustregel: **MIT / Apache-2.0 / BSD** dürfen ohne Auflagen in ein Web-Bundle;
GPL/AGPL verlangen, dass dein Quellcode unter derselben Lizenz offen bleibt.

---

## 9. Roadmap in vier Etappen

### Etappe 1 — Loop & Aufnahme (keine neue Dependency)
- Transportleiste: Play/Stop, BPM (60–200), Loop-Länge 1/2/4/8/16 Bars, Metronom
- Note-Recorder mit Count-in, Overdub, Undo, Quantize (1/16 default) + Swing
- Loop-Overlay über dem Keyboard, Playhead, Taktzähler
- `Engine.noteOn(note, vel, when)` um Startzeit erweitern

### Etappe 2 — Spuren & Speichern
- 3–4 Spuren mit eigenem Patch, Mute/Solo, Pegel, Spur-Fokus („welche Spur nehme ich auf")
- Projekt als JSON: Download + `localStorage`/IndexedDB, Auto-Save
- Patch-Browser mit Kategorien; A/B-Slot pro Spur

### Etappe 3 — MIDI rein/raus
- Export: SMF Typ 1, PPQ 480, Tempo-Meta, Spurnamen, Note-On/Off-Paare, Loop 1× oder N×
- Import: `.mid` → Clips (Tracks splitten nach Kanal), Tempo übernehmen
- Optional: Loop als MIDI-Datei mit `N` Wiederholungen für DAW-Import

### Etappe 4 — Andere Sounds & Mix
- SoundFont-Instrumente (`smplr`), Instrument-Auswahl pro Spur
- Effekte: Delay + Reverb pro Spur, Master-Limiter
- WAV-Bounce (OfflineAudioContext + eigener WAV-Encoder, ~60 Zeilen)
- Optional: Szenen/Arrangement, Web-MIDI-Keyboard, Teilen-Link (`lz-string`)

---

## 10. Offene Entscheidungen

1. **Arrangement:** nur ein Loop (einfach) · Szenen wie Ableton (mittel) · lineare Spur (komplex)?
2. **Sounds:** nur interne Engine · + Sample-Bank (Empfehlung) · + `.sf2`-Import?
3. **Speichern:** lokal (IndexedDB) · Datei-Download · Cloud (Google Drive ist als App verbunden)?
4. **Zielgruppe:** „schnell Idee festhalten" (Loop-first) oder „kleiner Song" (Arrangement)?

Empfohlener Start: **Etappe 1 + 2** — danach kann man eine Idee aufnehmen, übereinander
legen, speichern und mit anderem Patch wieder öffnen. MIDI-Export ist danach ein
Nachmittag Arbeit.
