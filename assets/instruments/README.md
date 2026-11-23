# Instrument-Assets (noch leer)

Hier liegen später sample-basierte Instrumente (SF2/SFZ/WAV). Das Verzeichnis ist bewusst
**leer**: Das Repo enthält keine Binär-Assets, und ohne dokumentierte Lizenz wird nichts
eingecheckt.

## Ablage

```
assets/instruments/<name>/
  instrument.sf2      (oder *.sfz + Samples)
  LICENSES.md         Quelle, Lizenz, Bearbeitung, Namensnennung
```

`<name>` ist die ID, die später in `registerVoice('sf2:<name>', …)` und im Projekt steht.
Kein Nachladen von Fremd-URLs: die App muss offline und in der Vorschau gleich klingen.

## Mindestangaben in `LICENSES.md`

| Feld | Inhalt |
| --- | --- |
| Quelle | URL/Archiv, Datum des Downloads |
| Lizenz | z. B. CC0-1.0, MIT, eigenes Recht — mit Link zum Lizenztext |
| Bearbeitung | konvertiert/gekürzt/umbenannt? was genau |
| Namensnennung | geforderter Text, falls die Lizenz ihn verlangt |

Ohne diese Angaben wird kein Asset übernommen (siehe `docs/SOUNDFONT-PLAN.md`).
