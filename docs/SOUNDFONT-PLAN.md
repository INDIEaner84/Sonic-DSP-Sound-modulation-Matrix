# Plan: sample-basierte Instrumente (SoundFont / SF2)

Status: **umgesetzt ohne Assets** (Kategorie B, Welle 10). Parser (`js/sf2.js`),
Sample-Bank und -Stimme (`js/sampler.js`), Schema v6 (`track.sample`) und das Panel „SF2“
sind fertig und getestet. Die Audiodateien kommen ausschließlich vom Nutzer; im Repo liegt
weiterhin kein Asset (siehe `docs/LIZENZEN.md`). Offen ist nur die Abnahme mit einer echten
Datei im Browser. Dieses Dokument ist die Vorlage,
damit die Umsetzung später ohne Umbau der bestehenden Architektur möglich ist.

## Warum jetzt nicht

- Ein Klang in Sample-Qualität braucht Audiodateien (SF2/SFZ/WAV). Das Repo enthält
  bewusst keine Binär-Assets, und die Sandbox hat keinen Zugriff auf Instrument-Archive.
- Jede Sammlung braucht eine **Lizenzprüfung** (Weitergabe im Repo, Namensnennung,
  kommerzielle Nutzung). Diese Freigabe kann nur der Nutzer geben.
- Ohne Asset kann ich nur die Anbindung bauen, nicht den Klang abnehmen — genau das
  verbietet die Regel „fehlende Nachweise nicht durch Simulation ersetzen“.

Das eingebaute Klavier (`PianoVoice`) und das Drum-Kit bleiben in jedem Fall erhalten.

## Optionen (Lizenzen aus npm-Metadaten geprüft)

| Bibliothek | Version | Lizenz | Rolle |
| --- | --- | --- | --- |
| `smplr` | 1.2.0 | MIT | Sample-Player mit SF2/SFZ-Unterstützung, schlanke API |
| `soundfont-player` | 0.12.0 | MIT | GM-Soundfonts von öffentlichen Hosts laden (Netz!) |
| `js-synthesizer` | 1.13.0 | BSD-3 | vollständiger SF2-Synth (libfluidsynth als WASM) |
| `spessasynth_lib` | 4.4.10 | Apache-2.0 | SF2/SF3-Synth + Sequencer, größer |
| `webaudio-tinysynth` | 1.1.3 | Apache-2.0 | sehr klein, GM-ROM-Samples eingebettet |

**Empfehlung:** `smplr` (MIT, kleine API) mit **lokal ausgelieferten** Assets. Kein CDN:
die App muss offline und in der Vorschau ohne Fremdhost funktionieren.
`webaudio-tinysynth` ist die günstigste Variante, wenn „irgendwie nach GM“ reicht — die
Samples sind dort eingebettet, was die Lizenzfrage aber nicht automatisch löst.

## Einbau in die bestehende Architektur

1. **Schema v5:** `INSTRUMENTS` bekommt `{ id: 'sf2', label: 'SOUNDFONT' }`; pro Spur
   zusätzlich `sf2: { program: 0 }` (0…127). Migration additiv wie v1→v4, Test dazu.
2. **Stimme:** `Sf2Voice` implementiert dieselbe Schnittstelle wie `PianoVoice`/`DrumVoice`
   (`kind`, `startAt`, `released`, `dead`, `release(at)`, `scheduleRelease(at)`, `tick(now)`,
   `dispose()`); Auswahl in `Engine.noteOn()` über `chain.track.instrument`.
   **Keine zweite Engine, keine parallele Wahrheitsquelle.**
3. **Assets:** `assets/sf2/<name>.sf2` (bzw. SFZ-Ordner), Laden beim ersten Gebrauch,
   Fehler → Toast + automatischer Rückfall auf `piano`. Ladezustand im Status-Panel.
4. **Rechte:** nur Dateien mit dokumentierter Lizenz (z. B. CC0) ins Repo; Quelle und
   Lizenz in `assets/sf2/LICENSES.md`. Kein Nachladen von Fremd-URLs.
5. **Persistenz:** Das Projekt speichert nur Instrument + Programm, nie Samples.

## Abnahmekriterien

- `Engine` erzeugt für `instrument: 'sf2'` Stimmen ohne Oszillatoren; Test prüft die
  Stimmen-Schnittstelle und den Rückfall bei fehlendem Asset.
- Laden einer fehlenden/kaputten Datei führt zu einer klaren Fehlermeldung, nie zu Stille
  ohne Hinweis.
- Startzeit ohne SF2-Nutzung unverändert (Assets werden lazy geladen).
- Bestehende Tests bleiben grün; `npm test` und `npm run test:ui` ohne Netzwerk lauffähig.

## Rücknahme

Der Umbau liegt in einem Commit (Schema + Stimme + Assets). Rücknahme = Revert; alte
Projekte mit `sf2`-Spuren fallen beim Laden auf `piano` zurück, wenn die Migration den Wert
nicht mehr kennt — deshalb muss die Migration **vor** dem Revert geprüft werden.


## Vorbereitet in Welle 8 (ohne Assets)

`js/audio.js` wählt die Stimmen-Klasse nicht mehr über eine `if`-Kette, sondern über eine
Registry:

```js
voiceFactoryFor(instrument)      // unbekannt → 'synth' (nie Stille)
registerVoice('sf2', factory)    // Fabrik: (engine, chain, note, velocity, at) => VoiceLike
unregisterVoice(instrument)
registeredInstruments()           // ['synth', 'piano', 'drums', …]
```

Damit ist der spätere Einbau ein **einziger** Registrierungsaufruf plus die `Sf2Voice`-Klasse;
`Engine.noteOn`, Voice-Stealing, Mute/Solo und Aufnahme bleiben unberührt. Getestet ist:
Registrierung, Rückfall auf den Synth bei unbekanntem Instrument, Wiederherstellung der alten
Fabrik, „Synth bleibt immer registriert“.

Noch offen (braucht Entscheidung/Assets):

1. `INSTRUMENTS` + Schema (v6): `{ id: 'sf2', program: 0…127 }` je Spur, Migration additiv.
2. `Sf2Voice` inkl. `tick/release/scheduleRelease/dispose` und Lazy-Load der Samples.
3. `assets/instruments/<name>/` mit `LICENSES.md` (Quelle, Lizenz, Bearbeitung); kein Nachladen
   von Fremd-URLs, damit Vorschau und Offline-Betrieb gleich funktionieren.
4. Status-Panel: Ladezustand/Sample-Anzahl; Fehler → Toast + Rückfall auf `piano`.


## Stand Welle 9: eigener SF2-Parser

`js/sf2.js` (eigene Implementierung, ~520 Zeilen) liest den RIFF-Baum (`INFO`, `sdta.smpl`,
`pdta` mit `phdr/pbag/pmod/pgen/inst/ibag/imod/igen/shdr`), baut Presets → Preset-Zonen →
Instrument-Zonen → Sample-Köpfe und prüft dabei:

- RIFF/`sfbk`, Chunk-Grenzen, Pflicht-Chunks, Record-Größen (Vielfache der Satzgröße)
- Sample-Bereiche gegen die PCM-Länge, Samplerate 400–192000 Hz, Loop-Grenzen
- Generator-Werte: `keyRange`, `velRange`, `sampleID`, `sampleModes`, `overridingRootKey`,
  `coarseTune`/`fineTune`, `initialAttenuation`, `pan`, `attackVolEnv`/`releaseVolEnv`
- Grenzen: 64 MB Datei, 512 Presets, 8192 Zonen

Ausgabe: `{ info, presets[{name,bank,program,zones}], samples, pcmFrames, pcm }` plus
`sf2Presets`, `findSf2Preset`, `zonesForNote`, `readSf2Zone` (PCM als Float32, Loop-Grenzen,
Grundton, Dämpfung). `sm24` (24 Bit) wird erkannt und gemeldet, aber nicht ausgewertet;
Modulatoren und Datei-Effekte werden bewusst ignoriert (die Engine hat Drive/Sends/Pan).

Getestet wird gegen **selbst erzeugte, spezifikationskonforme SF2-Bytes**
(`tests/support/sf2-fixture.mjs`), nicht gegen eine heruntergeladene Datei: 5 Tests mit
Preset-Listen, Key-Bereichen, Loop-Flags, 24-Bit-Hinweis und Fehlerfällen (kaputter Formtyp,
fehlendes `pdta`, abgeschnittene Datei, Größenlimit).

### Nächste Schritte (weiterhin asset-frei)

1. `SampleVoice`: `readSf2Zone` → `AudioBuffer` (Loop-Punkte, `playbackRate` aus Grundton +
   Feinstimmung), Hüllkurve, `release/tick/dispose` wie die anderen Stimmen, Registrierung
   über `registerVoice('sf2', …)`.
2. Projekt: `track.sample = { presetIndex, presetName, program, bank }` (Schema v6,
   additiv), Datei selbst **nicht** im Projekt; optional Bytes in IndexedDB cachen.
3. UI: „SF2 laden" im Instrument-Panel, Preset-Auswahl, Status im Diagnose-Panel,
   Rückfall auf `piano` ohne Datei — inklusive Fehlermeldung statt Stille.
4. Abnahme: Note aus einer echten, vom Nutzer gelieferten Datei hören; erst dann gilt B als
   fertig.


## Umsetzung (Welle 10)

| Teil | Datei | Verhalten |
| --- | --- | --- |
| Parser | `js/sf2.js` | RIFF/`INFO`/`sdta`/`pdta`, Presets + Zonen, 16-Bit-PCM, Bereichsprüfungen |
| Bank | `js/sampler.js` (`SampleBank`) | AudioBuffers **lazy** je Zone, Wiederverwendung, `resolve({name,program,bank})` |
| Stimme | `js/sampler.js` (`SampleVoice`) | `kind:'sf2'`, `playbackRate` aus Grundton/Feinstimmung, Attack/Release, Loop-Grenzen aus der Datei, Pan aus der Zone, `release/tick/dispose` wie die anderen Stimmen |
| Engine | `js/audio.js` | `registerVoice('sf2', …)`, `Engine.setSampleBank()`; ohne Bank oder ohne passende Zone → **Klavier** |
| Projekt | `js/project.js` | Schema **v6**: `track.sample = {preset, name, program, bank}` (nur Metadaten), Migration v5→v6 additiv |
| UI | `index.html`, `js/main.js` | Panel „SF2“: Datei-Dialog, Preset-Auswahl, Info-Zeile, Diagnose-Zeile; Instrument `SF2` in der Spurzeile |

Bewusste Grenzen:

- Nur 16-Bit-PCM; `sm24` wird erkannt und gemeldet, nicht gespielt.
- Modulatoren, Filter-Hüllkurven und Effekt-Sends der Bank werden ignoriert — dafür gelten
  unsere Spur-Sends, Drive, Pan und Filter.
- Die Bank liegt **nur im Speicher**. Nach dem Neuladen der Seite muss die Datei erneut
  gewählt werden; das Projekt speichert nur Preset/Programm/Bank. (Ein IndexedDB-Cache wäre
  möglich, wurde bewusst zurückgestellt, um keine zweite Datenhaltung zu öffnen.)
- Kein Streaming, kein Preload: der erste Ton je Zone kostet einen Buffer-Aufbau.

Abnahme im Browser (offen): echte CC0-Datei laden, Preset wechseln, Note hören, Spur-Sends
und Drive prüfen, Projekt speichern/laden (Referenz bleibt, Ton braucht erneut die Datei).
