# Plan: Song-Modus (Szenen und Arrangement)

Status: **geplant, nicht umgesetzt.** Der aktuelle Stand kann Loop-Musik in mehreren Spuren
aufnehmen, speichern, exportieren und abspielen — aber immer **einen** Loop. Ein Song-Modus
braucht ein eigenes Datenmodell und einen eigenen Umbau von Clip/Clock/UI. Dieses Dokument
hält den Zuschnitt fest, damit die Arbeit nicht zwischen zwei Wellen halbfertig liegt.

## Ziel

- Mehrere **Szenen** (z. B. A, B, C), jede mit eigenem Clip je Spur.
- Eine **Kette** (`A A B A C …`), die der Transport automatisch durchläuft.
- Aufnahme immer in die aktive Szene der aktiven Spur.
- Export: JSON (Schema), MIDI (Kette als Notenfolge), WAV (Mitschnitt der Kette).

## Datenmodell (Vorschlag, Schema v5)

```js
project.scenes = [{ id, name }];            // mind. 1, max. 8
project.song = {
  enabled: false,
  chain: ['A', 'B', 'A'],                    // Szenen-IDs in Reihenfolge
  loopChain: true,
};
track.clips = { [sceneId]: { takes: [...] } }; // statt track.takes
```

- Migration: `track.takes` → `track.clips['A'].takes`, eine Szene „A“ anlegen.
- `loopTicksOf(project)` bleibt global (Loop-Länge gilt für alle Szenen).
- `Clip` bleibt unverändert; nur der Zugriff (`activeClipOf(project, track)`) und die
  Persistenz ändern sich.

## Auswirkungen auf die bestehenden Schichten

| Stelle | Änderung |
| --- | --- |
| `project.js` | Schema/Migration/Validierung, `activeSceneOf`, `clipOf(track, sceneId)` |
| `clip.js` | unverändert |
| `clock.js` | kennt die aktive Szene; beim Kettenwechsel Clip-Wechsel an der Loop-Grenze **im Voraus** geplant (Lookahead), keine Noten doppelt |
| `audio.js` | unverändert (Noten bleiben Noten) |
| `ui.js` | Szenen-Leiste (A/B/C, duplizieren, umbenennen), Ketten-Editor, Loop-Strip je Szene |
| `midi-io.js` | Export der Kette als Notenfolge (Länge = Summe der Szenen), Import erzeugt eine Szene |
| `main.js` | Verdrahtung, Autosave, Status-Panel (Szene/Position) |

## Pakete

| Paket | Inhalt | Abnahme |
| --- | --- | --- |
| S1 | Schema v5 + Migration + Tests (Roundtrip, Altstände, ungültige Szenen/Ketten) | 20+ Tests, alle grün |
| S2 | `Clock`: Szenenwechsel im Lookahead, Kettenlauf, Aufnahme in aktive Szene | Clock-Tests: kein doppelter Trigger, Wechsel exakt an der Loop-Grenze |
| S3 | UI: Szenen-Leiste, Ketten-Editor, Strip je Szene | jsdom-Tests: Szene anlegen/wechseln, Kette bearbeiten |
| S4 | MIDI-/WAV-Export der Kette | Tests: Länge, Notenzahl, Reihenfolge |
| S5 | Doku + Abschlusslauf | README, Entscheidungen, Testzahlen |

## Risiken und Rücknahme

- Der Umbau berührt Clip-Zugriffe an vielen Stellen. Deshalb **eigene Welle**, nicht
  „nebenbei“: zuerst das Schema mit Migration (rückwärts lesbar), dann Clock, dann UI.
- Rücknahme: Schema-Migration ist additiv; ein Revert des Clock-/UI-Commits lässt die
  Szenen-Daten unangetastet, die App fällt auf „eine Szene“ zurück (Daten bleiben in der
  JSON-Datei erhalten).
- Ohne Song-Modus ist die App vollständig benutzbar; es fehlt nur das Arrangement über
  mehrere Teile.

## Empfohlene Reihenfolge mit anderen offenen Punkten

1. SoundFont-Anbindung (`docs/SOUNDFONT-PLAN.md`) — klein, sobald Assets freigegeben sind.
2. Song-Modus (dieses Dokument) — größter Einzelblock.
3. Spur-Inserts über Drive hinaus (Chorus/Filter) — nur wenn gebraucht.
