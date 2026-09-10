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

## Ergebnis des gemeinsamen Checks auf `7137e85`

Der isolierte `npm run check` in `/tmp/webrtc-video-check.BikMfY` ist mit
Exit 1 beendet: 1.294 Frontendtests bestanden, Build 13,222 s erfolgreich,
Typ-, Go- und statische Gates bestanden. Node: 1.266 bestanden, drei Fehler,
vier ausdrückliche Skips; 650,892 s. Externe Infrastruktur-Gates wurden wegen
des Fehlers nicht mehr erreicht. Die drei Strategie-Fälle und beide früher
auffälligen Szenentests bestanden. Fehlgeschlagen sind diesmal:

- Zwei-Quellen-Audio `screen-first+unprocessed`: ein Tonanteil fehlt.
- Nativer Handoff: erwarteter Mono-Ton nicht bestätigt; kein Beleg für einen
  erneuten Standby-Ladefehler.
- Chromium Source-Interop: 200 erfolgreich entschlüsselte/dekodierte VP8-Frames,
  dann geschlossener Empfänger, Transportfehler 5. Dieser Code bezeichnet
  `receiver.AliveNow() == false`, nicht einen Codec-/SFrame-Authentifizierungsfehler.
  Welche Gültigkeitsbedingung verloren ging, ist damit noch nicht belegt.

Diese Fehler bleiben offen; der erfolgreiche Low-Profilnachweis ersetzt die
Gesamtabnahme nicht. Die separat vorbereitete Mehrstufenprüfung und explizite
Destroy/Recreate-Wartebedingung sind nicht Bestandteil dieses eingefrorenen
Checks. Kein zweiter Gesamtcheck pro kleinem Testnachtrag.

## Vollständige lokale Rendition-Leitern

Der getrennte Nachlauf mit erweitertem, ausdrücklich gewähltem Testprofil
bestand in 59,454 s: drei Ausgabe-Fälle und der tatsächliche Zwei-Packager-
Handoff. Die unveränderte Anwendung stammt aus dem isolierten `7137e85`-Build.
Auf diesem Laptop meldet der native Agent tatsächlich CPU-Klasse `high`.
Damit wurden bei **jeder** Strategie alle drei Stufen gleichzeitig zugelassen
und aus committed HLS dekodiert: alle neun Auflösungs-/FPS-Kombinationen der
Tabelle oben stimmen. Die Master-Playlist nennt exakt die jeweils drei
dekodierten Varianten mit passender Auflösung. Es wurde kein Capture ausgelöst.

Der Test setzt nur die lokale Testprozess-Konfiguration auf drei Renditions,
43.545.600 Pixel/s und die entsprechende Uploadklasse. Er überschreibt keine
CPU-Klasse und erhöht keine Produktionsgrenze. Auf schwächeren Rechnern prüft
er die tatsächlich zugelassene reduzierte Leiter und meldet
`completeLadder: false`; das zählt nicht als Dreistufennachweis.

Die separate Handoff-Prüfung besteht in 30,695 s einschließlich neuem Consent,
dekodiertem Mono-Ton und zwei Destroy/Recreate-Zyklen. Nach Navigation wird
jetzt das tatsächliche Entfernen beider alten Panels abgewartet, bevor die
neuen geöffnet werden. Das prüft die beabsichtigte Neuerstellung zuverlässiger,
beweist aber nicht die Ursache des zuvor fehlenden Mono-Tons. Zwölf gezielte
Fixture-/Probe-/Cleanup-Prüfungen bestehen in 0,133 s. Mobile Wiedergabe,
Qualitätsbewertung und die drei roten Gesamtcheck-Fälle bleiben offen.

Die CI `34476790152` auf `7137e85` ist ebenfalls terminal: Der Hauptjob
überschritt laut GitHub-Annotation sein unverändertes 15-Minuten-Limit und
wurde abgebrochen. Bis dahin bestanden dort beide 401-Frame-Interop-Fälle;
das widerlegt den lokalen Fehler nicht. Authentisierter Ananta-TURN-Dialog,
Blind-Media-Agent, nativer Packager und beide macOS-Lifecycle-Jobs bestanden.
Docker und Live-Keycloak/TURN wurden durch den Hauptjob nicht freigegeben.
