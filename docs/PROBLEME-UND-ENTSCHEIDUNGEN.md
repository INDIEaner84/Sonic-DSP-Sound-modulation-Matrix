# Probleme, Befunde und Entscheidungen (Wellen 2–6)

Stand: Branch `arena/63e00fdc-sonic-dsp-sound-modulation-mat`, Basis `7afa23b`.
Bezug: `docs/PLAN-WELLE-2-3.md` (P2.1–P2.6, P3.1–P3.3, P4.1–P4.3),
`docs/PLAN-WELLE-4-5.md` (P4.1–P4.5, P5.1–P5.3) und
`docs/PLAN-WELLE-6.md` (P6.1–P6.5).
Dieses Dokument hält fest, **was entschieden wurde, warum, mit welcher Folge** und
**was noch offen oder nur teilweise geprüft ist**.

## Entscheidungen

### E-01 — `js/project.js` ist die einzige Quelle der Wahrheit

Das Projekt (`{name, bpm, bars, quantizeStep, swing, metronome, master, modWheel,
activeTrackId, tracks[]}`) liegt in genau einem Modul; alles andere (Engine, Clock, UI)
liest und schreibt darüber. Ein Track ist `{id, name, patchName, patch, mute, solo, gain,
clip}`.

**Folge:** Ein neues Feld braucht drei Stellen (Schema, Default, UI) und einen Test im
JSON-Roundtrip — dafür gibt es keinen zweiten Zustand, der auseinanderlaufen kann.
`validateProject` lehnt im Zweifel ab, statt still zu reparieren.

### E-02 — Patch, Matrix und Rack gehören der **aktiven Spur**

Vorher gab es einen globalen Patch. Jetzt hat jede Spur einen eigenen; das Rack
(Oszillatoren, Filter, Hüllkurven, Matrix, Preset-Auswahl, LFO-Vorschauen) zeigt und
bearbeitet immer den Patch der aktiven Spur. `master` und `modWheel` bleiben global.

**Folge:** Presetwechsel wirkt nur auf die aktive Spur (bewusst, sonst würde ein Klick
das ganze Arrangement umschreiben). Aufnahme geht immer in die aktive Spur.

### E-03 — MIDI-Export/-Import ohne Fremdbibliothek

`js/midi-io.js` schreibt/liest Standard-MIDI-Dateien selbst (Format 1, PPQ 480,
Tempo-Meta 4/4, Spurnamen, Note-On/Off, Running Status, VLQ, SysEx wird übersprungen).

**Begründung:** Das Projekt läuft ohne Build-Tools und ohne CDN; `@tonejs/midi` wäre die
einzige Laufzeit-Dependency und im Browser nur per Bundler/Import-Map einzubinden.
Der Codec ist ~300 Zeilen, vollständig testbar und liefert reproduzierbare Bytes.

**Grenzen (bewusst):** SMPTE-Division wird abgelehnt, Format 2 nicht unterstützt,
keine Automation/Controller-Daten (nur Noten + Tempo), Import max. 8 Spuren/20 000 Noten.

### E-04 — Persistenz lokal: JSON-Datei + `localStorage`-Autosave

Speichern = Download einer JSON-Datei; Autosave = `localStorage['sonicdsp.project']`
(seit Schema 2; der alte Schlüssel wird weiter gelesen, siehe E-11)
mit 700 ms Debounce plus Sofortspeicherung bei `beforeunload`. Google Drive ist nicht
angebunden (Browser-OAuth mit Client-ID ist kein Repo-Schritt, Kategorie C).

**Folge:** Alles funktioniert offline; ein Wechsel auf Drive berührt nur
`saveLocal`/`loadLocal`-Aufrufer, nicht das Schema.

### E-05 — Projektobjekt behält seine Identität

`replaceProject()` (Laden/Import/Neu) **mutiert** das bestehende Projektobjekt, statt die
Variable neu zu binden. Grund: UI-Bindings, Engine-, Clock- und Test-Referenzen zeigen
sonst auf einen veralteten Stand — genau dieser Fehler ist beim MIDI-Import-Test
aufgefallen (Import lief, `project.name` blieb alt).

**Folge:** Das exportierte `project` (`js/main.js`) ist über die gesamte Laufzeit dieselbe
Referenz; ein `let`-Rebind ist verboten, ohne alle Halter mitzuziehen.

### E-06 — Mute/Solo wirken auf den Spur-Gain, nicht auf die Notenlogik

Die Engine berechnet pro Spur `audible = trackAudible(project, track)` und rampt den
Gain (20 ms). Die Clock plant weiterhin alle Spuren.

**Folge:** Ein Mute mitten im Ton erzeugt keinen hängenden Ton und keinen Klick; ein
Unmute mitten im Loop funktioniert ohne Neu-Planung. Preis: stumm geschaltete Spuren
kosten weiterhin Stimmen (bei max. 8 Spuren unkritisch).

### E-07 — Taktposition, nicht Phase, ist die Invariante bei Tempo-/Taktwechsel

`Clock.setBpm()`/`setBars()` rechnen über die **Tick-Position** (`loopStart = now −
ticks · secPerTick`); bei Taktwechsel wird `ticks % loopTicks` verwendet.

**Folge:** Ein Tempowechsel bei laufendem Transport verschiebt den Playhead nicht, ein
Taktwechsel schneidet den Loop an der richtigen Stelle. Zwei echte Bugs wurden dadurch
gefunden und behoben (siehe B-02).

### E-08 — Tests im Repo ohne Test-Framework

`tests/run.mjs` ist ein eigener Mini-Runner (`test/eq/near/assert/throws`), `jsdom` ist
die einzige Dev-Dependency (nur für `npm run test:ui`). Audio wird über
`tests/support/fake-audio.mjs` (deterministische Zeit, keine Ausgabe) geprüft.

**Folge:** `npm test` läuft ohne Installation, `npm run test:ui` braucht `npm install`.
Kein CI-Zwang, keine Snapshot-Dateien, keine versteckten Zeitabhängigkeiten.

### E-09 — Explizites ES-Modul-Paket, Server als `.cjs`

`package.json` hat `"type": "module"`; der statische Server heißt deshalb `server.cjs`.
**Folge:** Kein `MODULE_TYPELESS_PACKAGE_JSON`-Warning mehr, `js/*` sind eindeutig ESM,
der Server bleibt `require`-basiert und dependency-frei. `npm start` ist unverändert.

## Befunde (durch Tests gefunden, behoben)

| Nr. | Befund | Beleg | Fix |
| --- | --- | --- | --- |
| B-01 | MIDI-Encoder schrieb `chunks.length + 1` als Trackzahl → Datei mit einem Phantom-Track, Import scheiterte | `midi.test.mjs`: Header-Prüfung nach `encodeProject` | Trackzahl = Anzahl geschriebener Chunks |
| B-02 | `Clock.setBpm/setBars` rechneten über die Phase → Playhead sprang hörbar | `clock.test.mjs`: Position bleibt bei Tempowechsel erhalten | Tick-Position als Invariante (E-07) |
| B-03 | `validateProject` brach beim ersten fehlerhaften Notenfeld ab und warnte nicht bei unbekannten Unterfeldern | `project.test.mjs`: mehrere Fehler werden gesammelt, Tippfehler im Patch warnen | Alle Felder prüfen, `DEFAULT_PATCH`-Abgleich, `KNOWN_PROJECT_KEYS` |
| B-04 | Spurenliste wurde nach Anlegen/Löschen/Auswahl/Aufnahme nicht neu gebaut (Zeile fehlte oder zeigte alte Notenzahl) | `ui.test.mjs`: „Neue Spur anlegen", „Aufnahme landet im Loop der aktiven Spur" | `trackList.build()` in `addTrack`, `deleteTrack`, `onSelect`, `clock.onChange` |
| B-05 | `requestAnimationFrame` wurde ohne Guard aufgerufen → Import in Umgebungen ohne rAF (Node/jsdom-Test, eingebettete Viewer) brach ab | `ui.test.mjs` (Import von `main.js`) | `raf()`-Fallback auf `setTimeout` |

## Prüfstand

| Prüfung | Kommando | Ergebnis |
| --- | --- | --- |
| Unit-/Integrationstests | `npm test` | **116/116** |
| inkl. UI (jsdom) | `npm run test:ui` | **139/139** |
| Syntax aller Module | `node --check js/*.js` | fehlerfrei |
| Server-Smoke | `node server.cjs` + `curl /` | 200, korrekte Content-Types |
| Browser-Verhalten (Klang, Layout) | manuell | **nicht** automatisiert prüfbar (jsdom ohne Canvas/Audio) |

## Status der Pakete

| Paket | Status |
| --- | --- |
| P2.1 Projekt-Schema/Validierung/JSON | umgesetzt, getestet |
| P2.2 Mehrspur-Engine | umgesetzt, getestet |
| P2.3 Clock spurbewusst | umgesetzt, getestet |
| P2.4 Spuren-UI / Rack auf aktiver Spur | umgesetzt, UI-getestet |
| P2.5 Projektleiste + Autosave | umgesetzt, UI-getestet |
| P2.6 Tests im Repo | umgesetzt (71 ohne UI, 87 mit UI) |
| P3.1 SMF-Encoder/Decoder | umgesetzt, Roundtrip + Fehlerfälle getestet |
| P3.2 Import ins Projekt | umgesetzt, Grenzen getestet |
| P3.3 MIDI-Buttons in der UI | umgesetzt, UI-getestet |
| P4.1 dieses Dokument | fertig |
| P4.2 README/Konzept | README aktualisiert; Konzept-Doc bleibt gültig |
| P4.3 Gesamtlauf | grün, Ergebnisse oben |

**Kategorien:** Welle 2 und 3 = **A** (umgesetzt und automatisiert geprüft, im Browser
nur manuell beurteilbar). SoundFont-Sounds und Google-Drive-Sicherung = **C** (extern
blockiert). WAV-Bounce und Spur-Effekte = **B** (bewusst zurückgestellt).

## Offene Punkte / Risiken

1. **Browser-Abnahme steht aus:** Klang, Latenz und Layout sind nur im echten Browser
   beurteilbar; die UI-Tests prüfen Verdrahtung, nicht Optik oder Höreindruck.
2. **Schema-Migration:** `PROJECT_VERSION = 2`, Version 1 wird additiv migriert (E-10).
   Unbekannte künftige Versionen werden abgelehnt (klare Fehlermeldung, kein Datenverlust).
   Jede weitere Schemaänderung braucht wieder einen eigenen Migrationsschritt plus Test.
3. **`localStorage`-Grenze:** sehr große Projekte (viele Noten) können das 5-MB-Limit
   treffen; dann meldet die Statusanzeige „nicht gespeichert", die JSON-Datei bleibt als
   Ausweg.
4. **MIDI-Import-Fidelity:** Nur Noten und Tempo werden übernommen; Spur-Mute/Solo,
   Effekte und Velocity-Kurven über Controller gehen verloren (dokumentiert).
5. **Kein Push möglich, falls das Remote-Token fehlt** — dann bleibt der Stand lokal
   committet (siehe Abschlussbericht).
6. **Web MIDI** ist nur im Browser prüfbar (Berechtigung, Geräteliste). Ohne Zugriff bleibt
   das Panel bei „AUS“; Tastatur, Pads, Aufnahme und Export sind davon unberührt.
7. **Klavier/Drums sind synthetisch**: ein sample-basiertes Instrument (SF2/`smplr`) ist der
   nächste sinnvolle Schritt, braucht aber Assets und eine Lizenzentscheidung (Kategorie C).

## Entscheidungen Welle 4 + 5

### E-10 — Schema v2 mit additiver Migration

Neu: `track.sends {delay, reverb}` und `project.fx {delayDivision, delayFeedback,
delayTone, reverbSize, reverbDamp}`. `PROJECT_VERSION = 2`, `SUPPORTED_VERSIONS = [1, 2]`;
`migrate()` ergänzt bei Version 1 ausschließlich Defaults, alles andere bleibt unverändert.
Unbekannte Versionen werden weiterhin abgelehnt.

**Folge:** Alte JSON-Dateien bleiben ohne Nutzeraktion lesbar, `migratedFrom` und eine
Warnung landen im Ladeergebnis. Ein Entfernen oder Umdeuten von Feldern ist in einer
Migration nicht vorgesehen — dafür bräuchte es einen eigenen, getesteten Schritt.

### E-11 — Storage-Schlüssel gewechselt, alter Stand bleibt erreichbar

Der Schlüssel heißt jetzt `sonicdsp.project` (versionslos), `sonicdsp.project.v1` wird
weiterhin gelesen (`LEGACY_STORAGE_KEYS`) und nach dem nächsten erfolgreichen Speichern
entfernt. `saveLocal()` meldet ein volles Kontingent (QuotaExceededError) als eigenen Text.

**Folge:** Kein Nutzer verliert sein Autosave durch die Schemaänderung; der Schlüssel
muss künftig nicht mehr je Version geändert werden.

### E-12 — Zwei Aux-Busse statt Insert-Effekte pro Spur

Ein Delay- und ein Reverb-Bus, die Sends hängen **hinter** dem Spur-Fader.

**Begründung:** acht Spuren × zwei Inserts wären 16 zusätzliche Knotenketten, hörbar
kaum besser als ein gemeinsamer Bus, aber deutlich teurer und in der Oberfläche
unübersichtlich. Post-Fader bedeutet: Mute/Solo wirkt automatisch auch auf die Effekte,
und es gibt keine zweite Pegel-Wahrheit.

**Grenze:** kein Effekt pro Spur einzeln einstellbar (nur der Anteil). Wenn das gebraucht
wird, ist ein Spur-Insert ein eigenes Paket mit eigener Kette.

### E-13 — Reverb ohne Assets: prozedurale Impulsantwort

`_buildImpulse(seconds)` erzeugt abklingendes, deterministisches Rauschen (Mulberry32),
normalisiert auf gleiche Energie; die IR wird nur bei geänderter Größe neu gebaut.

**Folge:** kein Download, keine Lizenzfrage, offline lauffähig, reproduzierbar in Tests.
Klanglich weniger „Raum" als eine echte IR — für einen Sketch ausreichend.

### E-14 — Rauschen als Wellenform statt Percussion-Samples

`'noise'` ist ein zusätzlicher Wert der Wellenform-Enums; die Stimme nutzt dann eine
geloopte Rausch-Buffer-Quelle statt eines Oszillators.

**Grenze (bewusst):** ein laufender Noise-Ton wechselt seine Quelle nicht, wenn die
Wellenform umgestellt wird (`refreshVoices` überspringt Buffer-Quellen). Der nächste Ton
nutzt die neue Einstellung.

### E-15 — WAV-Export als Echtzeit-Mitschnitt, nicht als Offline-Rendering

`recordOutput()` hängt einen `MediaStreamAudioDestinationNode` an den Analyser und nimmt
mit `MediaRecorder` auf; `blobToWav()` dekodiert und kodiert mit `js/wav.js`.

**Begründung:** Die Engine rechnet ihre Modulation in JS auf Control-Rate und hängt an
`currentTime` des laufenden Kontexts. Ein `OfflineAudioContext` würde einen zweiten,
parallel zu pflegenden Synthesepfad (AudioParam-Automation) erzwingen — genau die zweite
Wahrheitsquelle, die dieses Projekt vermeidet. Der Mitschnitt benutzt deshalb die echte
Kette und kostet Zeit in Echtzeit (1/2/4 Loops + 1,6 s Ausklang).

**Grenzen:** `MediaRecorder` nötig (Chrome/Firefox: ja); das Metronom wird für die Dauer
des Mitschnitts stummgeschaltet (es hängt am Master und wäre sonst im Mix); die Ausgabe
muss hörbar geroutet sein;
das Ergebnis ist so gut wie die laufende Session (keine Offline-Genauigkeit, kein
Sample-Accurate-Bounce bei Überlastung).

### E-16 — Testbarkeit an den Rändern

`throws(fn, /regex/)` prüft jetzt auch die Fehlermeldung; WAV-Kodierung und Dauer-Rechnung
liegen in reinen Funktionen ohne DOM/Web-Audio, die Browser-Teile (`MediaRecorder`,
`decodeAudioData`) werden über schmale Fakes geprüft.

**Folge:** Der einzige nicht automatisierbare Rest ist der echte Mitschnitt im Browser —
er ist isoliert, klein und ohne Folgen für Aufnahme, Speichern oder MIDI abschaltbar.

## Befunde Welle 4 + 5

| Nr. | Befund | Beleg | Behandlung |
| --- | --- | --- | --- |
| B-06 | Schema-2-Wechsel hätte den alten Autosave verwaist (Schlüssel enthielt die Version) | Projekt-Test „Alter Autosave-Schlüssel wird gelesen und ersetzt" | Legacy-Schlüssel wird gelesen, migriert und nach erfolgreichem Speichern entfernt |
| B-07 | Testannahmen, keine App-Fehler: Preset-Auswahl enthält zusätzlich „Custom" (+1 Option); Autosave-Test verglich ein festes Delay-Raster | UI-Tests | Tests an den tatsächlichen Zustand angepasst (Custom-Option, aktuelles Raster statt Literal) |

## Status Welle 4 + 5

| Paket | Status |
| --- | --- |
| P4.1 Schema v2 + Migration | umgesetzt, getestet (Roundtrip, Migration, Grenzen, Legacy-Storage) |
| P4.2 FX-Busse in der Engine | umgesetzt, getestet (Verdrahtung, Sends, Delay-Zeit, IR-Cache, Grenzen) |
| P4.3 UI für Sends und FX | umgesetzt, UI-getestet |
| P4.4 Noise-Wellenform + 3 Presets | umgesetzt, getestet (Quelle, Preset-Validierung) |
| P4.5 Dokumentation | fertig (README, dieses Dokument, Plan) |
| P5.1 WAV-Encoder | umgesetzt, getestet (Header, Interleaving, Clamping, Fehlerfälle) |
| P5.2 Recorder | umgesetzt, Encoder-Pfad und Fehlerfälle getestet; **Browser-Teil manuell zu prüfen** |
| P5.3 UI-Knopf „Mix ⤓ WAV" | umgesetzt, UI-getestet (Fehlerpfad ohne MediaRecorder) |

## Entscheidungen Welle 6

### E-17 — Instrument ist eine Spur-Eigenschaft

`track.instrument` ist `'synth' | 'piano' | 'drums'`; der Patch bleibt bei allen Typen
gespeichert. Die Engine wählt beim `noteOn` die Stimmenklasse über diese Eigenschaft.

**Folge:** Umschalten ist verlustfrei (der Patch bleibt), MIDI-Export, Aufnahme, Mute/Solo
und Effekte gelten unverändert für alle Instrumente. Ein Spur-Instrument ist keine zweite
Wahrheitsquelle neben dem Patch, sondern eine Auswahl, welche Stimme ihn nutzt.

### E-18 — Klavier synthetisch statt Sample-Instrument

`PianoVoice`: fünf verstimmte Sinus-Partiale, Hammer-Rauschimpuls, velocity-abhängiges
Tiefpassfilter, exponentielles Ausklingen (tiefe Lagen länger). Alles über
AudioParam-Automation, ohne Control-Rate-Ticks.

**Begründung:** „VST" im engeren Sinn ist im Browser nicht möglich; ein Sample-Klavier
bräuchte Assets + Lizenzfreigabe (Kategorie C). Die synthetische Stimme ist offline
lauffähig, deterministisch testbar und klingt für Skizzen brauchbar.

**Grenze:** kein echtes Konzertflügel-Sample; ein SF2-/SoundFont-Paket kann später als
zweiter Instrumenttyp daneben treten, ohne diesen zu ersetzen.

### E-19 — Drum-Kit synthetisch mit GM-Belegung

Acht Ein-Schuss-Stimmen (Kick, Snare, Clap, Hat zu/offen, Tom, Rim, Crash), Notennummern
nach General-MIDI: 36, 38, 39, 42, 46, 45, 37, 49. Unbekannte Noten fallen auf die
geschlossene Hat zurück, damit ein Controller-Pad nie stumm bleibt.

**Folge:** Pads, Tastatur und MIDI sprechen dieselben Noten; die Belegung ist eine
projektweite Kit-Definition (`DRUM_KIT` in `js/state.js`), kein Kit-Wechsel pro Spur.

### E-20 — Web MIDI als dünne Schicht plus testbarer Router

`js/midi-input.js` trennt drei Dinge: `parseMidiMessage` (Bytes → Ereignis),
`createMidiRouter` (Ereignis → Noten-/CC-Aktion inkl. Learn) und `openMidiAccess`
(Browser-Zugriff, Geräteliste, Zustandswechsel). Nur der letzte Teil braucht einen Browser.

**Folge:** Parser, Routing, Learn und Fehlerpfade sind in Node vollständig getestet; übrig
bleibt die Berechtigungsabfrage, die nur im Browser beurteilbar ist.

### E-21 — CC-Bindungen liegen im Projekt, mit Kanal und Omni

`project.midi.binds[]` enthält `{cc, channel, target}`; `channel: 0` bedeutet alle Kanäle.
15 Ziele: Master, Mod-Wheel, FX-Werte, Pegel/Sends der aktiven Spur, Play/Stop/Play-Stop/
Record, Loop leeren, Panic. Numerische Ziele laufen über `applyControl()` (eine Stelle für
Bereiche und Log-Kurven), Transportziele über Aktionen in `main.js` mit Flankenerkennung
(CC ≥ 0.5 und vorher < 0.5), damit ein Tastendruck nicht doppelt feuert.

**Folge:** Bindungen wandern mit der Projektdatei, sind versioniert und validiert
(CC 0…127, Kanal 0…16, Ziel aus der Liste, maximal 32 Bindungen). Doppelte CC/Kanal-Kombination:
letzte Bindung gilt, mit Warnung.

### E-22 — Keine geratenen Nektar-CC-Nummern

Der Nektar Impact sendet Pads als Noten (typisch Kanal 10) und Transport-/Mixer-Tasten je
nach Modell und Firmware mit unterschiedlichen CC-Nummern. Deshalb gibt es **keine**
fest eingebaute Belegtabelle, sondern Learn + MIDI-Monitor (`CH 1 · CC 74 · Wert 96`).

**Folge:** „Programmieren" heißt: Ziel im Panel wählen, „CC anlernen", Taste am Gerät
drücken. Das ist ehrlicher als eine Tabelle, die bei anderer Firmware falsch wäre, und
funktioniert für jedes andere Gerät genauso.

### E-23 — Schema v3 in der Migrationskette

`migrate()` arbeitet jetzt als Kette: v1 → v2 (Sends/FX) → v3 (Instrument, MIDI-Bindings).
Jeder Schritt ist additiv und einzeln getestet.

## Befunde Welle 6

| Nr. | Befund | Beleg | Behandlung |
| --- | --- | --- | --- |
| B-08 | Testannahme, kein App-Fehler: `dataset.instrument` sitzt am Pad-Raster (`.pads`), nicht am Container `#pads` | UI-Test „Instrument je Spur umschalten" | Test auf das tatsächliche Element korrigiert |
| B-09 | Testannahme, kein App-Fehler: nach dem MIDI-Import enthält die erste Spur bereits zwei Noten; die Pad-Aufnahme muss als Differenz geprüft werden | UI-Test „Pads spielen Noten …" | Test misst `+1` statt Absolutwert |

## Status Welle 6

| Paket | Status |
| --- | --- |
| P6.1 Schema v3 + Migration | vollständig abgenommen |
| P6.2 Piano-/Drum-Stimmen | vollständig abgenommen (Engine-Tests) |
| P6.3 MIDI-Parser/Router/Learn | vollständig abgenommen (Node-Tests); Browser-Zugriff manuell |
| P6.4 UI (Instrument, Pads, MIDI-Panel) | umgesetzt, UI-getestet |
| P6.5 Doku | fertig |
