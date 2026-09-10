# Szenenanpassung pro Quelle: versionierter v2-Pfad

Implementierungsstand: nativer Steuer- und Renderpfad, explizite
Capability-Aushandlung, Node-Director/Broker und Angular-Auswahl verbunden.
Der reale durchgängige Szenentest besteht; der Gesamtcheck ist noch rot.
Noch nicht deployed. TBP-015
bleibt offen; Zielauflösung/FPS, weitere Profile und die 60-Minuten-Abnahme
sind dadurch nicht erledigt.

## Vertrag und Wirkung

Die additive `source-program-scene`-Version 2 verlangt `sourceFits`: eine
vollständige Liste aus `contain` oder `cover`, positionsgleich zu
`sourceLeaseIds`, höchstens 20 Einträge. Fehlende, zusätzliche, unbekannte oder
nicht passend lange Listen werden abgewiesen. Auch eine leere Auswahl besitzt
eine explizite leere Liste. Query, State, Applied und Rejected verwenden
dieselbe angeforderte Version. Die fünf neuen JSON-Schemas und gemeinsamen
nativen Fixtures sind versioniert; gleiche Listenlängen werden zusätzlich
vom nativen Validator geprüft, nicht durch das allgemeine Schema allein.

Der Mixer besitzt eine eigene Kopie der Szenen-Fits. Er verändert weder die
Admission-Konfiguration eines Inputs noch dessen Consent, Frames, Zeitbasis,
Quelle, Decoder, Lease oder Puffergrenzen. Der Wechsel betrifft die tatsächliche
Pixelkomposition beim nächsten Render. `contain` erhält die vollständige Quelle
mit Slate-Rändern; `cover` füllt die Kachel durch den vorhandenen mittigen Crop.
Es gibt keine frei übergebenen Filter, Koordinaten, URLs oder Metadaten.

Das vorhandene v1 bleibt in seiner exakten Form gültig. Ein v1-Schreibauftrag
setzt wie bisher die ursprünglichen Input-Defaults; eine v1-Abfrage enthält
keine neuen Felder. Eine v2-Abfrage liefert die tatsächlich ausgewählten Fits,
auch für einen nach Widerruf als Slate verbleibenden Slot, ohne neue Rechte
aus dessen ID abzuleiten. Kein v2-Auftrag wird als v1 umgedeutet.

Native Commands behalten die authentisierte Control-Verbindung, den aktuellen
Source-Program-Owner, Revision-CAS, die maximal viersekündige Frist und die
maximal 32 historischen Command-Belege. Ein Replay mit geändertem Fit scheitert.
Ein erst nach Warten auf die Render-Sperre abgelaufener Auftrag verändert die
bestehende Szene nicht. Antworten bleiben historische Anwendungsbelege, keine
Bestätigung der Zustellung beim Publikum.

## Capability und Angular-Bedienung

Der Agent 0.13.0 meldet nur bei ausdrücklich aktivierten Source-Programs
Capability v6: `sourceSceneControlVersion: 2`, weiterhin Audio-Steuerung v3
und Audio-Encoding v1. Ohne Source-Programs bleibt der Bericht v1. Die neuen
Fähigkeiten werden aus dem authentisierten, zeitlich gültigen Bericht geprüft,
nicht aus einer Versionsnummer geraten. Die bisherigen Audio-Funktionen
bleiben auch mit Capability v6 verfügbar.

Die Angular-Abfrage verwendet Director-Request v2. Der Server darf eine
v1- oder v2-Beobachtung zurückgeben, je nach aktueller Agent-Capability;
beide Antwortschemas bleiben getrennt. Ein **Schreibauftrag** mit expliziten
v2-Fits wird dagegen niemals auf v1 zurückgestuft. Broker und Director binden
die Antwortversion an die frisch geprüfte Autorisierung; Capability-Wechsel
während einer ausstehenden Operation machen die Antwort ungültig.

Unter der Sendeszene erscheinen die Fits nur bei bestätigtem v2-Zustand,
positionsgleich zur bewussten Quellenauswahl. Neue Quellen starten in der UI
mit sichtbarem `contain`, ohne automatischen Schreibauftrag. Nach einer frischen
Abfrage sind Änderungen höchstens fünf Sekunden anwendbar und benötigen die
lokale Bestätigung. Änderungen während des Bestätigungsdialogs werden nicht
unbemerkt mitgesendet. Keine erneute Capture-Anfrage oder zusätzliche
Entschlüsselungsfreigabe wird dadurch ausgelöst.

## Verifikation

Die fokussierten nativen Scene-/Mixer-Racetests bestehen, einschließlich der
unveränderten v1-Fixtures. Neue Tests prüfen echte RGBA-Pixel bei
Contain/Cover/v1-Rückkehr ohne erneute Bildzufuhr, unveränderte Input-Defaults,
kopierte Beobachtungen, fehlende/falsche Fits, Versionsgrenzen, geänderte Replays,
Ablauf am Render-Lock und Auswahlverbot nach realer Receiver-Revocation.
Die RGBA-Prüfung ist eine lokale synthetische Renderprüfung, kein Browser- oder
Netzwerk-Transcodingnachweis.

Auch der vollständige native Go-Racelauf besteht (48,750 s; internes
SFrame-Paket 2,193 s), ebenso Go Vet. Diese lokalen nativen Prüfungen ersetzen
weder den noch folgenden gemeinsamen Projektcheck noch eine UI-Abnahme.

Der native Zwischenstand bestand zehn Node-Schema-/v1-Vertragstests (0,397 s).
Nach der Node-/Angular-Integration bestehen 33 fokussierte Node-Tests,
52 Frontendtests und die Typprüfung. Die neuen Negativfälle prüfen insbesondere
fehlende/falsche Fits, unbekannte Capability-Felder, Versionswechsel,
Capability-Downgrade und abweichende Antwortversionen.

Die erweiterte reale Angular-/Node-/Native-/HLS-Prüfung fordert zwei
unterschiedliche Quellen: zunächst beide mit sichtbaren Slate-Rändern, danach
nur die Kamera gefüllt und schließlich beide Quellen gefüllt. Sie prüft die
tatsächlich dekodierten Kachelpixel, fortschreitende Frames und unveränderte
Capture-Zähler; native ACKs allein genügen nicht. Beide Fälle bestanden im
isolierten Gesamtcheck: Einzelquelle 30,865 s, zwei Quellen 41,348 s. Die
Kachelpixel wechselten tatsächlich von Slate/Slate über Rot/Slate zu Rot/Blau;
Widerruf, weiterbewegte zweite Quelle und anschließender Stop bestanden.

Der neue native Racelauf bestand in 45,299 s, das interne SFrame-Paket in
2,024 s. Der erste Projektcheck stoppte nach 1.283 bestandenen Frontendtests
am unveränderten 1,60-MB-Startbudget (475 Byte darüber). Der Szenen-Parser wird
jetzt erst bei der expliziten HTTP-Bedienung geladen; Abbruch während des
Imports verhindert den Request. Das Budget wurde nicht erhöht.

Der anschließende isolierte `npm run check` bestand 1.286 Frontendtests,
Build, Typprüfung, Go-Unit/Vet und statische Gates. Node beendete den Lauf
mit 1.239 bestandenen, zwei fehlgeschlagenen und vier ausdrücklich
übersprungenen Prüfungen (644,345 s):

- Eine HTTP-Fixture behandelte die jetzt unterstützte Query-Version 2 noch
  als unbekannt. Sie prüft jetzt Version 3 sowie echte HTTP-Aushandlung mit
  einem älteren Agenten und das Verbot, v2-Schreibaufträge herunterzustufen.
- Chromium überschritt beim verzögerten Bootstrap die unveränderte
  Fünfsekundenfrist für den Login-Button. Der unveränderte Nachlauf bestand;
  damit ist die Ursache nicht bewiesen oder behoben.

Alle sechs gezielten HTTP-/Bootstrap-Nachprüfungen bestanden (6,992 s).
Der Gesamtcheck bleibt dennoch rot. Die 14 externen Infrastruktur-Gates
wurden anschließend separat ausgeführt und ausdrücklich übersprungen;
auch der optionale Image-Scan war übersprungen. Prüfprotokolle liegen in
`/tmp/webrtc-scene-fit-check.fwIAq9/`. Kein Release- oder Produktionsnachweis
wird daraus abgeleitet; der vorhandene Serving-Build blieb bytegleich.
