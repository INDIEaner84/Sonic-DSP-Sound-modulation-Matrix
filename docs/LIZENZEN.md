# Lizenzen: was beim Verkauf des Projekts sicher ist

Kurzfassung: **Code unter MIT/Apache-2.0/BSD-3 und Assets unter CC0 sind ohne Auflagen
verkaufbar.** Alles andere braucht Prüfung, Namensnennung oder ist ausgeschlossen.

Dieses Dokument ist die Entscheidungsgrundlage für den kommerziellen Vertrieb (Verkauf des
Projekts oder eines daraus gebauten Produkts). Es ersetzt keine Rechtsberatung, hält aber
jede Abhängigkeit mit Lizenz und Pflicht fest.

## 1. Regeln für Code

| Lizenz | Verkauf erlaubt | Pflichten |
| --- | --- | --- |
| MIT | ja | Copyright-Hinweis + Lizenztext mitliefern |
| Apache-2.0 | ja | Lizenztext, `NOTICE`-Datei, Änderungen angeben, Patentklausel beachten |
| BSD-2/3 | ja | Copyright-Hinweis + Lizenztext, keine Namenswerbung mit Autoren |
| ISC | ja | wie MIT |
| MPL-2.0 | ja | Dateien, die verändert wurden, bleiben MPL |
| LGPL-2.1/3.0 | nur mit Vorsicht | dynamisches Linken, Quellcode der Bibliothek verfügbar halten; bei WASM/JS-Bundles praktisch heikel |
| GPL-2.0/3.0, AGPL | **nein** für ein proprietär verkauftes Produkt | Copyleft erfasst das Gesamtwerk |
| keine Lizenz / „all rights reserved" | **nein** | keine Nutzung ohne Erlaubnis |

## 2. Regeln für Audio-Assets (Samples, Soundfonts)

| Lizenz | Verkauf erlaubt | Pflichten |
| --- | --- | --- |
| CC0 / Public Domain | **ja, ohne Auflagen** | keine |
| CC BY 3.0/4.0 | ja | Namensnennung des Urhebers im Produkt (Credits/„Über"-Dialog) |
| CC BY-SA | ja, aber Share-alike | abgeleitete Assets müssen wieder CC BY-SA sein — für ein Produkt meist ungeeignet |
| CC BY-NC | **nein** | keine kommerzielle Nutzung |
| GPL-Soundfonts (z. B. TimGM6mb) | **nein** | Copyleft auf die Bank |
| „free for music", „free for personal use" (GeneralUser GS, Arachno, Timbres of Heaven) | **nein** | Erlaubnis deckt Musik, nicht Einbettung/Weiterverkauf |
| unbekannte Herkunft | **nein** | Beweislast liegt beim Verkäufer |

## 3. Stand in diesem Projekt

| Bestandteil | Herkunft | Lizenz | Verkaufsstatus |
| --- | --- | --- | --- |
| App-Code (`js/*.js`, `css/`, `index.html`, `server.cjs`) | eigene Implementierung | Projektlizenz (offen, siehe unten) | unkritisch |
| `js/sf2.js` (SF2-Parser) | eigene Implementierung, keine Fremdbibliothek | Projektlizenz | unkritisch |
| `js/sampler.js` (Sample-Bank/-Stimme) | eigene Implementierung | Projektlizenz | unkritisch |
| `js/midi-io.js`, `js/wav.js`, `js/recorder.js` | eigene Implementierung | Projektlizenz | unkritisch |
| Samples/Audio-Dateien | **keine im Repo** | — | unkritisch |
| Externe CDNs, Web-Fonts, Analytics | **keine** | — | unkritisch |

Konsequenz: Der Kern hat **keine** drittanbieterrechtlichen Pflichten. Wer das Projekt
verkauft, muss nur die eigene Projektlizenz setzen und einhalten.

### Projektlizenz (offener Punkt)

Im Repo liegt noch keine `LICENSE`. Vor einem Verkauf muss der Rechteinhaber entscheiden:

- **proprietär** (alle Rechte vorbehalten) — dann darf der Käufer nur nutzen, was im Vertrag steht;
- **MIT/Apache-2.0** — dann darf jeder den Code weiterverwenden, auch kommerziell (Verkauf des
  Produkts bleibt möglich, der Code selbst ist dann frei).

Bis dahin gilt: keine Lizenzdatei = alle Rechte beim Autor.

## 4. Bewusst nicht genutzt (und warum)

| Kandidat | Lizenz | Warum nicht |
| --- | --- | --- |
| `smplr` + `soundfont2` | MIT | lizenzrechtlich **ok**, aber zusätzliche Fremdabhängigkeit im asset-freien Repo; Funktion ist durch `js/sf2.js` abgedeckt |
| `spessasynth_lib` | Apache-2.0 | ok, aber 5 MB + eigener Audio-Pfad |
| `js-synthesizer` (FluidSynth-WASM) | BSD-3-Wrapper, **FluidSynth LGPL-2.1** | WASM-Bundle + LGPL macht den Vertrieb unnötig kompliziert |
| `webaudio-tinysynth` | Apache-2.0 | ok (rein algorithmisch, keine Samples), aber eigener Synth statt unserer Engine |
| FluidR3 GM / MuseScore General | MIT | 148–200 MB, nicht repo-tauglich |
| Salamander Grand Piano | CC BY 3.0 | 120–700 MB, Namensnennung nötig |
| VSCO 2 CE / VCSL | CC0 | lizenzfrei nutzbar, aber 111 MB–3,2 GB (nur einzelne Instrumente sinnvoll) |
| TimGM6mb | GPL-2.0 | Copyleft |
| GeneralUser GS, Arachno, Timbres of Heaven | „free for music" | Einbettung/Weiterverkauf nicht erlaubt |

## 5. Der verkaufssichere Weg für Samples

1. **Der Nutzer bringt die Datei mit.** `.sf2` per Datei-Dialog laden, im Browser parsen
   (`js/sf2.js`), nur Metadaten im Projekt speichern. Keine Assets im Repo, keine
   Weiterlizenzierung, kein CDN. Die Lizenz der Datei bleibt Sache des Nutzers.
2. **Optional ein CC0-Demo** (einzelnes Instrument, wenige MB) mit `assets/instruments/<name>/LICENSES.md`
   — nur mit ausdrücklicher Freigabe, Quelle und Lizenznachweis.
3. **CC BY nur mit Credits-Seite** (Namensnennung ist Pflicht, sonst ist der Verkauf angreifbar).
4. **Niemals** Dateien ohne dokumentierte Lizenz einchecken — auch nicht „nur zum Testen".

## 6. Checkliste vor dem Verkauf

- [ ] Projektlizenz gesetzt (`LICENSE`) und mit dem Käufervertrag abgeglichen
- [ ] Keine Fremd-Assets ohne Lizenznachweis im Repo (`git ls-files assets/`)
- [ ] Bei CC-BY-Assets: Namensnennung sichtbar im Produkt (Dialog „Credits")
- [ ] Keine Fremd-URLs zur Laufzeit (Fonts, Soundfonts, Analytics)
- [ ] Bezeichnung „SoundFont" ist eine Marke von Creative/E-mu: in der UI neutral von
      „SF2-Datei" sprechen, nicht als eigenes Format ausgeben
- [ ] Drittanbieter-Code (falls später ergänzt) mit Lizenztext + `NOTICE` ausgeliefert
