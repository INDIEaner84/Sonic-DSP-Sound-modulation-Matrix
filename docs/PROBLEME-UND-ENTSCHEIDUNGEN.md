# Probleme, Befunde und Entscheidungen (Wellen 2 + 3)

Stand: Branch `arena/63e00fdc-sonic-dsp-sound-modulation-mat`, Basis `7afa23b`.
Bezug: `docs/PLAN-WELLE-2-3.md` (Pakete P2.1–P2.6, P3.1–P3.3, P4.1–P4.3).
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

Speichern = Download einer JSON-Datei; Autosave = `localStorage['sonicdsp.project.v1']`
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
| Unit-/Integrationstests | `npm test` | **71/71** |
| inkl. UI (jsdom) | `npm run test:ui` | **87/87** |
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
2. **Schema-Migration:** `PROJECT_VERSION = 1`. Ältere/neuere Stände werden abgelehnt
   (klare Fehlermeldung, kein Datenverlust). Ein Migrationspfad existiert erst, wenn sich
   das Schema ändert.
3. **`localStorage`-Grenze:** sehr große Projekte (viele Noten) können das 5-MB-Limit
   treffen; dann meldet die Statusanzeige „nicht gespeichert", die JSON-Datei bleibt als
   Ausweg.
4. **MIDI-Import-Fidelity:** Nur Noten und Tempo werden übernommen; Spur-Mute/Solo,
   Effekte und Velocity-Kurven über Controller gehen verloren (dokumentiert).
5. **Kein Push möglich, falls das Remote-Token fehlt** — dann bleibt der Stand lokal
   committet (siehe Abschlussbericht).
