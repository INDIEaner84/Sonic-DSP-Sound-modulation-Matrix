# Plan Welle 6 (Instrumente, Pads, MIDI-Controller)

Stand zu Beginn: Branch `arena/63e00fdc-sonic-dsp-sound-modulation-mat`, HEAD `b162100`,
`origin/main` = `7afa23b`, PR #1 offen, Arbeitsbaum sauber, `npm test` 100/100,
`npm run test:ui` 119/119.

## Auftrag

„… auch ein Klavier, Schlagzeug, und für den Nektar Impact die Möglichkeit, ihn zu
programmieren, sowie Drumpads."

## Auslegung (bewusst, ohne externe Abhängigkeit)

| Begriff aus dem Auftrag | Umsetzung |
| --- | --- |
| „Klavier-VST" | Im Browser gibt es keine nativen VST-Plugins. Umgesetzt als **eingebautes Klavier-Instrument** (Partiale + Hammer-Noise, velocity-abhängig). Sample-/SF2-Klavier bleibt Kategorie C |
| „Schlagzeug" | **Drum-Kit** mit acht synthetischen Stimmen, GM-Noten 36/37/38/39/42/45/46/49 |
| „Drumpads" | **Pad-Raster** im UI, Maus/Tastatur/MIDI, aufnahmefähig in den Loop |
| „Nektar Impact programmieren" | **Web-MIDI-Eingang** mit Geräteliste, MIDI-Monitor und **CC-Learn** auf 15 Ziele (inkl. Transport); Bindungen liegen im Projekt |

## Pakete

| Paket | Ziel | Abnahme | Kategorie |
| --- | --- | --- | --- |
| P6.1 | Schema v3: `track.instrument` (synth/piano/drums), `project.midi.binds[]`; Migration v2 → v3 in der Kette v1 → v2 → v3 | Tests: Migration beider Altstände, ungültiges Instrument, CC/Grenzen/Bindungszahl, `applyControl` inkl. Log-Kurve | A |
| P6.2 | Piano-Stimme (Partiale, Hammer, Velocity-Cutoff, Release) und Drum-Stimme (acht Rezepte) in der Engine, Auswahl über `track.instrument` | Engine-Tests: Stimmentyp, Knoten, Ausklingen, `refreshVoices` ignoriert Nicht-Synth-Stimmen | A |
| P6.3 | `js/midi-input.js`: Parser (Note/CC/Program, Velocity 0 = aus), Router mit Kanal/Omni, Learn, Monitor-Text; Web-MIDI-Zugriff als dünne Schicht | Tests: Parser-Fälle, Routing, Learn, Nicht-Bindungen, fehlende Umgebung | A |
| P6.4 | UI: Instrument-Auswahl je Spur, Pad-Panel, MIDI-Panel (Verbinden, Ziel, Learn, Bindungsliste, Monitor) | UI-Tests: Umschalten, Pad-Aufnahme, MIDI-Panel-Zustand ohne Browser-Unterstützung | A |
| P6.5 | Doku: README (Instrumente, Pads, Nektar-Hinweise), Entscheidungen, dieser Plan | vorhanden, konsistent | A |

## Bewusst nicht in diesem Block

| Punkt | Kategorie | Grund |
| --- | --- | --- |
| Sample-/SF2-Klavier oder `smplr`-SoundFonts | C | Assets + Lizenzfreigabe nötig, nicht autonom nachweisbar |
| Fest geratene Nektar-CC-Belegung | C | CC-Nummern je Modell/Firmware unterschiedlich; Learn + Monitor ersetzt eine geratene Tabelle |
| MIDI-Out/Clock-Sync zum Controller | B | eigenes Paket (Sende-Pfad, Latenztest), kein Blocker für Spielen/Aufnehmen |

## Risiken und Rücknahme

- Schema v3 ist additiv; v1 und v2 bleiben ladbar. Rücknahme = Revert des Schema-Commits,
  alte Dateien bleiben lesbar.
- Klavier/Drums hängen an `track.instrument`; ein Zurückschalten auf `synth` macht die
  Spuren sofort wieder patchbasiert, ohne Datenverlust (Patch bleibt gespeichert).
- Web MIDI ist die einzige Browser-Schnittstelle ohne automatisierbare Abnahme; sie ist
  isoliert (eigenes Modul, eigenes Panel) und ohne Folgen für Spielen, Aufnahme oder Export.

## Ergebnis (Stand nach Umsetzung)

| Paket | Ergebnis |
| --- | --- |
| P6.1–P6.5 | umgesetzt; `npm test` 116/116, `npm run test:ui` 138/138 |

Abweichungen vom Plan: Das MIDI-Panel bekam zusätzlich einen Monitor (zeigt die letzte
Roh-Nachricht) und UI-Aktualisierungen aus CC-Strömen werden per `requestAnimationFrame`
gebündelt. Die Pads sind projektweit eine Kit-Belegung (kein Kit-Wechsel pro Spur).
