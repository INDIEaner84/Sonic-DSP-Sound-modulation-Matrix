# Plan Welle 4 + 5 (Effekte, Sounds, Mix-Export)

Stand zu Beginn: Branch `arena/63e00fdc-sonic-dsp-sound-modulation-mat`, HEAD `a622117`,
`origin/main` = `7afa23b`, PR #1 offen (Entwurf), Arbeitsbaum sauber, `npm test` 71/71,
`npm run test:ui` 87/87.

## Ziel

Der Nutzer will „andere Sounds" und musikalisches Ergebnis. Welle 2/3 liefern Arrangement
(Spuren, Loops, MIDI). Welle 4 macht den Klang fertig, Welle 5 den Export.

## Pakete

### Welle 4 — Effekte und Sounds

| Paket | Ziel | Abnahme | Kategorie |
| --- | --- | --- | --- |
| P4.1 | Schema v2: `track.sends {delay, reverb}`, `project.fx {delayDivision, delayFeedback, delayTone, reverbSize, reverbDamp}`; Migration v1 → v2; neuer Storage-Schlüssel mit Lesen des Alt-Schlüssels | Tests: v1-Datei wird übernommen und mit Defaults ergänzt, v2-Roundtrip idempotent, unbekannte Version abgelehnt, Alt-Autosave wird gelesen | A |
| P4.2 | Engine: zwei Aux-Busse (Delay mit Feedback/Tone, Reverb mit prozedural erzeugter Impulsantwort), Sends pro Spur post-Fader, Delay-Zeit tempo-/rastergebunden | Engine-Tests: Busse existieren, Send-Gain folgt `track.sends`, Delay-Zeit = Division × Schlagdauer, Mute/Solo senkt auch den Send, IR wird nur bei Größenänderung neu gebaut | A |
| P4.3 | UI: Send-Regler je Spur, FX-Panel (Delay-Raster, Feedback, Tone, Reverb-Größe), Presets wirken weiter auf die aktive Spur | UI-Test (jsdom): Send-Slider schreibt `track.sends.delay`, FX-Auswahl schreibt `project.fx.delayDivision`, Werte überleben Autosave | A |
| P4.4 | Sounds: `'noise'` als Wellenform (Percussion ohne Assets), drei zusätzliche Presets (Sub Bass, Noise Hat, Glass Bell) | Tests: Presets validieren gegen `PATCH_RANGES`/`PATCH_ENUMS`, Noise-Stimme erzeugt Buffer-Quelle statt Oszillator | A |
| P4.5 | Doku: README, Entscheidungen E-10…, dieses Dokument | vorhanden, konsistent zum Code | A |

### Welle 5 — Mix-Export

| Paket | Ziel | Abnahme | Kategorie |
| --- | --- | --- | --- |
| P5.1 | `js/wav.js`: reiner WAV-Encoder (16 Bit PCM, mehrere Kanäle, Clipping) | Tests: Header-Felder, Größen, Interleaving, Clamping, leere Eingabe | A |
| P5.2 | `js/recorder.js`: Mitschnitt der laufenden Ausgabe (`MediaStreamAudioDestinationNode` + `MediaRecorder`) für N Loops, danach Umkodierung nach WAV | Tests: Encoder-Pfad und Fehlerpfade (kein MediaRecorder, keine Stream-Quelle, Abbruch); Browser-Teil nur manuell prüfbar | A/B |
| P5.3 | UI: „Mix ⤓ WAV" mit Loopläufen, Fortschritt als Toast, Sicherheitsabbruch bei fehlender Audio-Ausgabe | UI-Test: Klick ohne Audio meldet Fehler statt zu werfen | A |

## Bewusst nicht in diesem Block

| Punkt | Kategorie | Grund |
| --- | --- | --- |
| SoundFont-/Sample-Instrumente | C | benötigt externe Sample-Assets inkl. Lizenzprüfung und Netzwerk; nicht autonom nachweisbar. Der Noise-Oszillator deckt Percussion ohne Assets ab |
| Google-Drive-Sicherung | C | Browser-OAuth mit Client-ID, nicht aus dem Repo einrichtbar |
| Freies Arrangement (Song-Modus, Spur je Abschnitt) | B | eigenes Modellpaket, kein Blocker für den aktuellen Nutzen |

## Risiken und Rücknahme

- Schema-Änderung ist die riskanteste Stelle: Migration liest v1 und ergänzt nur Defaults,
  Ablehnung bleibt bei unbekannten Versionen. Rücknahme = Revert des Schema-Commits;
  alte JSON-Dateien bleiben lesbar, weil v1 weiter akzeptiert wird.
- Effekte hängen an der Engine, nicht an Clock/Clip — bei Problemen abschaltbar, ohne
  Spuren oder MIDI zu berühren (Sends auf 0).
- Der Mitschnitt (P5.2) ist der einzige Teil, der im Browser manuell geprüft werden muss;
  er ist von der Engine getrennt und kann ohne Folgen für Aufnahme/Export entfernt werden.

## Ergebnis (Stand nach Umsetzung)

| Paket | Ergebnis |
| --- | --- |
| P4.1–P4.5 | umgesetzt; `npm test` 96/96, `npm run test:ui` 115/115 |
| P5.1 | umgesetzt; WAV-Encoder sechs Tests (Header, Stereo, Clamping, Fehlerfälle) |
| P5.2 | umgesetzt; Encoder-/Fehlerpfade getestet, Browser-Mitschnitt offen (manuell) |
| P5.3 | umgesetzt; UI-Fehlerpfad getestet |

Abweichungen vom Plan: Die Sends liegen post-fader (Mute/Solo erfasst sie), und der
Mitschnitt ist ein Echtzeit-Mitschnitt der echten Kette statt eines Offline-Renderings —
Begründung in `docs/PROBLEME-UND-ENTSCHEIDUNGEN.md`, E-12 und E-15.
