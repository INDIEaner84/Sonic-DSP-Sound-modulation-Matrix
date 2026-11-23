# Plan: Song-Modus (Szenen und Arrangement)

Status: **umgesetzt in Welle 8** (Schema v5). Szenen und Song-Kette sind im Datenmodell,
in der Clock, im MIDI-Export und in der Szenenleiste der Oberfläche implementiert und
getestet; offen ist nur die Browser-Abnahme (Klang/Clip-Wechsel hören) wie bei allen
Audio-Pfaden. Die ursprüngliche Planung bleibt unten als Zuschnitt erhalten, die Abschnitte
„Umsetzung“ beschreiben den tatsächlichen Stand.

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


## Umsetzung (Welle 8)

Abweichungen vom ursprünglichen Vorschlag, jeweils mit Grund:

| Punkt | Plan | Umgesetzt | Grund |
| --- | --- | --- | --- |
| Kette | Szenen-**Namen** (`'A','B'`) | Szenen-**IDs** (`'scn-A'`, `'scn-…'`) | Umbenennen darf die Kette nicht brechen; Namen sind nur Anzeige |
| `loopChain` | geplant | entfällt | `song.enabled` entscheidet Loop ↔ Kette; ein zweites Flag wäre redundant |
| `track.takes` | entfällt | bleibt als toleriertes Altfeld, wird beim Laden ignoriert | v5-Dateien mit `takes` sollen nicht hart scheitern |
| Fehlerfälle | harte Fehler | Reparatur + Warnung | Unbekannte Szene/Ketten-Schritt/fehlender Clip wird repariert, damit ein Projekt nicht durch eine kaputte Referenz unladbar wird |
| WAV der Kette | eigener Offline-Render | Live-Mitschnitt der Wiedergabe (wie bisher) | Der Recorder nimmt die echte Ausgabe; damit ist die Kette automatisch enthalten, ohne zweiten Renderpfad |

Technische Eckpunkte:

- `clipOf(project, track, sceneId)` / `activeClipOf` / `allClipsOf` kapseln jeden Clip-Zugriff.
- `track.clip` bleibt als nicht-enumerierbarer Getter auf die **aktive** Szene erhalten
  (Altcode und alte Tests bleiben gültig, JSON enthält nur `clips`).
- `sceneIdAtLoop(project, k)` liefert die Szene für Loop `k`; die Clock plant damit weiterhin
  pro Fenster, also **im Voraus** und ohne doppelte Noten an der Grenze.
- `playOrder(project)` ist die einzige Quelle für die Abspielreihenfolge (Kette oder aktive
  Szene) und wird von Transport-Position, MIDI-Export und UI genutzt.
- MIDI-Export im Song-Modus: `encodeProject(project, { sequence: playOrder(project) })` schreibt
  einen Loop-Block je Ketten-Schritt (Länge = Schritte × Loop-Länge).

### Status der Pakete

| Paket | Status |
| --- | --- |
| S1 Schema v5 + Migration + Tests | umgesetzt, 6 Projekttests (Roundtrip, v4→v5, Reparaturfälle) |
| S2 Clock: Szenenwechsel, Kettenlauf, Aufnahme in aktive Szene | umgesetzt, 3 Clock-Tests (Loop 0/1/2, Aufnahme, Kettenpflege) |
| S3 UI: Szenenleiste, Song-Schalter, Kettenfeld, Szene löschen | umgesetzt, 3 jsdom-Tests |
| S4 MIDI-Export der Kette | umgesetzt, 3 MIDI-Tests (Reihenfolge, 4 Schritte, Import in Szene A) |
| S5 Doku | dieses Dokument, README, Entscheidungen E-28…E-32 |
