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
Die aktuelle native Komposition hat 640×360 Pixel. Größere Ausgaben können
diese hochskalieren, erzeugen aber keine zusätzlichen Quelldetails. Eine
höher aufgelöste Komposition und die mobile Qualitätsabnahme bleiben offen.

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
Drei begrenzte Probe-Checks bestehen. Die echte Angular→Native→HLS-Prüfung
für jede Strategie, der isolierte Build und die gemeinsame Projektabnahme
stehen bei diesem Implementierungscheckpoint noch aus. Dies ist kein
Deployment- oder abgeschlossener TBP-020-Nachweis.
