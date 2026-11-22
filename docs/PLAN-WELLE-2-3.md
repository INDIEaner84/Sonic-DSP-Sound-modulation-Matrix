# Plan Welle 2 + 3 (Etappen 2 & 3 aus dem Komponier-Konzept)

Stand zu Beginn: Branch `arena/63e00fdc-sonic-dsp-sound-modulation-mat`, HEAD `3dff86c`,
`origin/main` = `7afa23b`, Arbeitsbaum sauber, keine Repo-Regeln (keine CONTRIBUTING/AGENTS/CI),
kein Testverzeichnis im Repo (Tests lagen bisher nur außerhalb im Sandbox).

## Ausgangslage (belegt)

| Nachweis | Stand |
| --- | --- |
| gebaut | GUI + Synth + Matrix + Transport/Loop-Recorder (Etappe 1) |
| getestet | 48/48 Checks headless (jsdom + Fake-AudioContext), **nicht im Repo** |
| auf GitHub gesichert | lokal committet, **nicht gepusht** |
| in main integriert | nein (nur der Initial-Commit liegt in main) |
| in Vorschau sichtbar | ja (Server läuft auf :3000) |
| extern abgenommen | nein |

## Wellen und Pakete

### Welle 2 — Spuren, Patch pro Spur, Persistenz (A: jetzt ausführbar)

| Paket | Ziel | Abnahme |
| --- | --- | --- |
| P2.1 | `js/project.js`: Projekt-/Spur-Schema, strikte Validierung, v1-Migration, JSON-Export/-Import, `localStorage`-Autosave | Positiv-/Negativtests: gültiges Projekt, falsche Version, Werte außerhalb der Grenzen, unbekannte Matrix-Route, zu viele Spuren/Events |
| P2.2 | Engine wird mehrspurig: pro Spur Kette `input → pan → gain → master`, `noteOn(trackId, …)`, Mute/Solo als gemeinsame Regel | Engine-Test: 2 Spuren, Routing, Mute/Solo-Gain, Notenreihenfolge |
| P2.3 | Clock plant alle Spuren (`trackAudible`), Aufnahme in die **aktive** Spur | Clock-Test: Scheduling nach Spur getrennt, Solo unterdrückt andere Spur, Aufnahme landet in aktiver Spur |
| P2.4 | UI: Spurenliste (wählen, Mute, Solo, Pegel, umbenennen, anlegen, löschen), Rack/Matrix/LFO bearbeiten den Patch der aktiven Spur | UI-Test (jsdom): Spurwechsel ändert Cutoff-Knob-Wert; Mute-Klick setzt `track.mute` |
| P2.5 | Projektleiste: Name, Speichern (JSON), Laden, Neu, Autosave-Status | UI-Test: Save erzeugt Blob (Stub), Load validiert, Autosave schreibt localStorage |
| P2.6 | Tests ins Repo: `npm test` ohne Dependencies lauffähig | `node tests/run.mjs` grün, CI-fähig |

### Welle 3 — MIDI-Export/-Import (A: jetzt ausführbar)

| Paket | Ziel | Abnahme |
| --- | --- | --- |
| P3.1 | `js/midi-io.js`: SMF-Encoder (Format 1, PPQ 480, Tempo-Meta, Spurnamen, Note-On/Off) und Decoder (Running Status, VLQ, Meta, Sysex-Skip) | Roundtrip-Test: Projekt → Bytes → Projekt, Noten/Ticks/Velocity identisch; Golden-Bytes für Header |
| P3.2 | Import in Projekt: Spuren aus MIDI, Loop-Länge anpassen (max. 16 Bars), Grenzen (Dateigröße, Eventzahl) | Negativtests: kaputter Header, SMPTE-Division, abgeschnittenes Chunk, zu groß |
| P3.3 | UI: „MIDI ⤓" Export (Wiederholungen 1/2/4), „MIDI ⤒" Import | UI-Test: Export liefert Blob, Import ersetzt Projekt |

### Welle 4 — Dokumentation und Absicherung (A)

| Paket | Ziel | Abnahme |
| --- | --- | --- |
| P4.1 | `docs/PROBLEME-UND-ENTSCHEIDUNGEN.md` mit Beobachtungen, Entscheidungen, Risiken | vorhanden, verlinkt |
| P4.2 | README/Konzept aktualisieren (Spuren, Speichern, MIDI, Grenzen) | Doku entspricht Code |
| P4.3 | Gesamtlauf: alle Tests + jsdom-UI-Test + Server-Smoke | grün, Ergebnisse dokumentiert |

## Bewusst zurückgestellt

| Punkt | Kategorie | Grund / Wiederaufnahme |
| --- | --- | --- |
| SoundFont-/Sample-Instrumente (`smplr`) | C (extern) | benötigt Sample-Assets inkl. Lizenzprüfung + Netzwerk; nicht autonom verifizierbar. Wiederaufnahme: Asset-Entscheidung + Lizenzfreigabe |
| „In Google Drive sichern" | C (extern) | Browser-OAuth-Flow mit Client-ID/Consent, nicht aus dem Repo heraus einrichtbar. Lokale JSON-Datei + Autosave deckt den Bedarf offline ab |
| WAV-Bounce (OfflineAudioContext) | B | braucht Engine-Aufbau in fremdem Kontext (eigenes Paket), nicht Voraussetzung für Komponieren/Speichern. Wiederaufnahme nach Welle 3 |
| Effekte pro Spur (Delay/Reverb) | B | klarer Zuschnitt, aber kein Blocker; kommt nach MIDI, damit die Spur-Schnittstelle vorher stabil ist |

## Risiken und Rücknahme

- Der Umbau auf Mehrspurigkeit berührt Engine, Clock, UI und Tests. Rücknahme: Commits sind
  klein geschnitten (Projektmodell → Engine → Clock → UI); jeder Schritt bleibt einzeln
  lauffähig, Rücknahme per `git revert` des jeweiligen Commits ohne Datenverlust.
- Persistenz schreibt nur in `localStorage` (Schlüssel `sonicdsp.project.v1`) und in
  heruntergeladene Dateien — keine externen Daten, keine Löschoperationen.
- Validierung lehnt im Zweifel ab (kein stilles Reparieren), Limits verhindern
  Speicher-/Rechenlast durch fehlerhafte Dateien.
