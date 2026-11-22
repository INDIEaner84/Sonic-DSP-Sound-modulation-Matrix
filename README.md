<div align="center">
  <h1>SONIC DSP — Modulation Matrix</h1>
  <p>Polyphoner Web-Audio-Synthesizer mit frei verschaltbarer Modulationsmatrix.</p>
</div>

## Was ist das?

Eine komplette GUI + Sound-Engine im Browser — ohne Build-Tools, ohne Dependencies.
Zwei Oszillatoren laufen durch ein Filter mit Hüllkurven; sechs Modulationsquellen
werden über eine 6 × 8 Matrix auf acht Ziele geroutet.

**Quellen:** LFO 1 · LFO 2 · ENV 2 · Velocity · Mod-Wheel · Key-Track
**Ziele:** Pitch 1 · Pitch 2 · Level 1 · Level 2 · Cutoff · Resonanz · Pan · LFO-1-Rate

Jede Zelle ist bipolar (−100 … +100). Die Summe aller Zellen wird pro Stimme auf
Control-Rate (60 Hz) berechnet und geglättet in die AudioParams geschrieben.

## Starten

```bash
npm start          # http://localhost:3000
# oder
node server.js
# oder mit anderem Port
PORT=8080 node server.js
```

Danach im Browser öffnen und **AUDIO STARTEN** klicken (Browser verlangen eine
Nutzerinteraktion, bevor Web Audio laufen darf).

## Bedienung

| Aktion | Wirkung |
| --- | --- |
| Knob ziehen (vertikal) | Wert ändern, `Shift` = fein |
| Mausrad über Knob | Wert ändern |
| Doppelklick auf Knob/Zelle | Reset |
| Matrix-Zelle ziehen | Betrag −100 … +100 |
| Tasten `A W S E D F T G Y H U J K` | Noten spielen |
| `Z` / `X` | Oktave runter / rauf |
| Mod-Wheel ziehen | Modulationsquelle `MOD WHEEL` |
| Random / Clear | Matrix zufällig belegen / leeren |
| Panic | Alle Stimmen freigeben |

Presets: Init Lead, Wobble Bass, Pluck Lead, Drift Pad, Res Sweep FX.

## Aufbau

```
index.html          Rack-Aufbau (Panels, Matrix, Keyboard, Gate)
css/style.css       Design (dunkles Hardware-Rack, Amber/Cyan)
js/state.js         Patch-State, Quellen/Ziele, Presets
js/audio.js         Audio-Engine: Voices, ADSR, LFOs, Matrix-Auswertung
js/ui.js            Knobs, Segment-Schalter, Wheel, Matrix, Keyboard, Scope
js/main.js          Verdrahtung von State, Engine und UI
server.js           Statischer Server (node, ohne Dependencies)
```

## Signalfluss

```
OSC 1 ─┐
       ├─► VCF (LP/BP/HP) ─► VCA (Amp-Env) ─► Pan ─► Master ─► Compressor ─► Out
OSC 2 ─┘                         ▲
                                 │
   Matrix: 6 Quellen × 8 Ziele ──┴─► Pitch / Level / Cutoff / Reso / Pan / LFO-Rate
```

## Hinweise

- Kopfhörer oder Monitore empfohlen; Ausgabe läuft über einen Kompressor gegen Clipping.
- Die Engine läuft komplett lokal, es werden keine Daten gesendet.
- `Master` und `Mod-Wheel` bleiben beim Presetwechsel erhalten.
