# Native Broadcast-Ausgabestrategien

Die Angular-Auswahl unter Broadcast → Mehrquellen-Sendung legt vor dem
bewussten Start eine Video-Strategie fest. Sie verändert weder Raumkamera
noch Bildschirmaufnahme. Eine laufende Sendung behält die Auswahl auch bei
Standby-Prüfung und bestätigter Packager-Übergabe; ein Wechsel benötigt eine
neue Sendung. Jede Teilnehmerquelle benötigt weiterhin separate Zustimmung.

| Strategie | Low | Medium | High |
| --- | --- | --- | --- |
| Ausgewogen / bisheriger Standard | 640×360 · 15 FPS · 500 kbit/s | 960×540 · 24 FPS · 1100 kbit/s | 1280×720 · 30 FPS · 2400 kbit/s |
| Sparsam | 426×240 · 10 FPS · 250 kbit/s | 640×360 · 15 FPS · 500 kbit/s | 960×540 · 15 FPS · 900 kbit/s |
| Bildschirm | 640×360 · 10 FPS · 400 kbit/s | 960×540 · 10 FPS · 800 kbit/s | 1280×720 · 10 FPS · 1400 kbit/s |

Alle Werte sind Encoder-Ziele, keine Datenraten- oder Qualitätsgarantie.
Das standardmäßig konfigurierte lokale `compact-v1`-Ressourcenprofil dekodiert
einzelne Quellen höchstens mit 640×360 Pixeln. `standard-v1` erlaubt dafür
960×540, `expanded-v1` 1280×720. Die Kompositionsgröße folgt der größten
zugelassenen Ausgabe. Höhere Ausgaben können somit Quellen hochskalieren,
erzeugen aber keine zusätzlichen Quelldetails. Die Auswahl ändert nicht das
lokale Ressourcenprofil; mobile Bildqualität bleibt gesondert abzunehmen.

Die angeforderte Anzahl bestimmt einen Low-first-Präfix. CPU-, Upload- und
Rendition-Klasse sowie das **summierte** Pixelbudget begrenzen die tatsächlich
zugelassenen Stufen. Unzureichende Kapazität wird reduziert oder abgelehnt;
die Auswahl hebt kein Ressourcenlimit an. Audio bleibt unabhängig auswählbar.

## Vertragsgrenzen

`source-program-start.v3` verlangt genau eine geschlossene `videoOutput`
mit `profile` (`balanced-v1`, `economy-v1`, `screen-v1`) und `audioOutput`:
entweder `null` für bisherige AAC-Stufenwerte oder die bestehende geschlossene
AAC-Auswahl. V1/V2 bleiben unverändert. Unbekannte Profile oder Zusatzfelder
werden abgelehnt, nicht durch einen Standard ersetzt.

Die Codec-Familie bleibt `h264-aac-720p-v1` (H.264 Main/Level 3.1,
YUV420p, AAC-LC/48 kHz, Zwei-Sekunden-GOP). Die schon vorhandenen nativen
Assignment-Verträge V4/V5 übertragen Auflösung, FPS und Bitraten ausdrücklich;
die neue HTTP-Auswahl fügt diesen Wireformaten keine unbekannten Felder hinzu.
V5 bleibt für die explizite AAC-Auswahl erforderlich. Node prüft bei Prepare
die komplette Admission erneut, bevor ein Writer reserviert wird. Handoff
und Standby lesen die gespeicherte Auswahl, nicht neue Client-Overrides.

## Verifikation / noch offen

104 gezielte Angular-/Controller-/HTTP-Checks, 37 Policy-/Schema-/Assignment-/
Handoff-Checks, vier echte HTTP-/WebSocket-Integrationsfälle sowie die nativen
Assignment-Parserprüfungen bestehen. Die neuen HTTP-Fälle verwenden echte
Gerätenachweise und prüfen auch fehlerhafte Auswahl ohne Writerreservierung.
Drei begrenzte Probe-Checks bestehen. Der isolierte Produktionsbuild auf
`7fe38f9` besteht in 10,564 s unter dem unveränderten 1,60-MB-Hardlimit
(1,50-MB-Warnung). Alle drei echten Angular→Native→HLS-Fälle bestehen in
24,231 s: Die kleinste Stufe liefert 640×360/15, 426×240/10 beziehungsweise
640×360/10 FPS mit jeweils 30/20/20 tatsächlich dekodierten H.264-Frames.
Jeder Fall prüft den exakten V3-Request, gesperrte Auswahl nach Start,
bestätigten Stopp und null menschlichen Capture.

Dies beweist noch nicht die gesamte mehrstufige Ausgabe auf mobilen Geräten,
Bildqualität oder den weiterhin offenen Zwei-Quellen-Szenenfehler. Der
nachfolgende gemeinsame Projektcheck wird einmal für die zusammenhängende
Implementierung gestartet. Öffentliche Dienste, Hub-Trust und das
Ananta-Repository bleiben unverändert; kein Deployment-/TBP-020-Abschluss.
