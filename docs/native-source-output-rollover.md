# Native Mehrquellen-Ausgabe nach Quellenwiderruf

## Aktueller Arbeitsstand: durchgängiger Wiederanlauf bestanden

Ein späterer Audioausgangstest grenzte einen konkreten HLS-Stillstand auf das
[falsche Ratebudget für gültige Wiedergabesitzungen](broadcast-playback-rate-budgets.md)
ein. Nach dessen Korrektur bestehen beide echten Szenenfälle und der neue
Audioausgangstest gemeinsam (115,350 s). Das beweist nicht nachträglich die
Ursache aller folgenden historischen CI-Fehler oder des separaten langen
Ananta-WebRTC-Laufs. Die gemeinsame isolierte Prüfung der aktuellen Arbeitskopie
bestand anschließend: Exit 0, 1.209 Frontendtests, 1.143 Node-/Browserfälle,
null Fehler und vier Node-Skips (513,191 s). Beide Szenenfälle bestanden darin
in 25,706/27,587 s. 14 externe Gates und der Image-Scan wurden übersprungen;
noch kein neuer Rollout.

### Neuere Regression: nicht durchgängig stabil

Der nachfolgende CI-Lauf `34391296035` für `bbc526f` ist **fehlgeschlagen**:
1.112 Node-/Browserfälle bestanden, zwei scheiterten, vier wurden übersprungen.
Neben der separaten Compose-Prüfung scheiterte der Einzelquellenfall beim Warten
auf rote dekodierte Kamerapixel. Der Zweiquellen-Wiederanlauf und der separate
authentisierte Ananta-TURN-Dialog bestanden; Docker und Live-Identity wurden
wegen des Testfehlers nicht ausgeführt. Der frühere grüne Lauf bleibt ein
historischer Nachweis, kein Beleg für durchgängige Stabilität.

Ein gezielter lokaler Nachlauf mit dem festen isolierten Frontendbuild von
`d2cfea4` und der aktuellen nativen Audio-Arbeitskopie scheiterte nach 40,677 s
an einer anderen Stelle: nach Quellenwiderruf. Der Packager meldete erneut
`OUTPUT_READY`; der Viewer zeigte Slate-Pixel, aber `failed` und keinen
hinreichenden Zeit-/Framefortschritt. Der konkrete Playerfehler war noch nicht
in der vorhandenen Fehlerprojektion enthalten. Diese liest nun zusätzlich
den bereits öffentlichen, begrenzten Fehlercode aus dem Player, getrennt vom
Autorisierungsfehler. Auch das erste Warten auf die ausgewählte Quelle hält
nun dieselbe begrenzte synthetische Beobachtung fest. Zwei Unitprüfungen
bestanden, einschließlich der Unterdrückung beliebiger DOM-Texte.

Ein zweiter, letzter gezielter Diagnoselauf bestand in 39,619 s; kein
Produktionspfad, Zeitbudget oder Kriterium wurde zwischen den Läufen geändert.
Die Ursache ist damit **nicht** behoben oder abschließend bestimmt. Kein
weiterer Gesamttest, Commit oder Deployment dieses Nachtrags. Der getrennte
Ananta-Langzeitfehler nach etwa 36 Minuten bleibt ebenfalls offen und wird
nicht mit diesem HLS-Befund gleichgesetzt.

### CI-Nachweis und eingegrenzter lokaler Testfehler

Der CI-Browserjob von `2da0440` bestand anschließend den tatsächlichen
`npm run check`: 1.198 Frontendtests, 1.109 bestandene Node-/Browserprüfungen,
null Fehler und vier explizite Node-Skips (499,440 Sekunden Node). Beide
gekoppelten Quellenfälle bestanden. Die externen Skripte dieses Jobs erreichten
ihre sichtbaren Skip-Pfade; der separate authentifizierte TURN-Job bestand
zusätzlich vier echte Chromium-/Firefox-Dialogfälle über UDP/TCP ohne Skip.
Der gesamte [CI-Lauf 34389380539](https://github.com/ananta888/webrtc-minimize-server/actions/runs/34389380539)
ist inzwischen mit allen acht Jobs erfolgreich abgeschlossen. Der Dockerjob
prüfte zusätzlich das exportierte Release gegen die Attestation und den
112.075.776-Byte-OCI-Export auf die vorgesehenen Leakage-Canaries. Der separate
Live-Keycloak-/TURN-Gate meldete tatsächlich `passed`, zwei ausgewählte
Relay-Paare und je 32 Payload-Bytes in beide Richtungen. Dessen Scope bleibt
synthetischer DataChannel im selben Browser; die Anwendungsmedien-Evidence
stammt aus dem getrennten vierfachen TURN-Dialog, nicht aus diesem Payloadtest.
Andere nicht aktivierte Infrastrukturprofile blieben ausdrücklich übersprungen.

Ein begrenzter lokaler Reproduktionslauf mit der gepushten Diagnose scheiterte
bereits im ersten Versuch: 3.768 ms Wandzeit gegenüber 1.236,860 ms Monotonzeit,
229 ms verbleibende Lease, beide Sockets offen, erste Publisher-Lease bestätigt,
keine Stopnachricht, noch keine zweite Lease. Damit ist der vorzeitige Ablauf
der Wanduhr-Testwartefrist belegt. Die produktiven Ablaufregeln wurden nicht
verändert; insbesondere müssen Leases auch weiterhin bei Zeitverlust enden.

Nur die vier synthetischen In-Prozess-Signalingtests verwenden nun eine durch
den Node-Testkontext begrenzte Date-Uhr aus Start-Epoch plus echter Monotonzeit.
Date-Konstruktor und Date.now bleiben konsistent, echte Timer/WebSockets laufen
weiter, und der Testkontext stellt Date nach Cleanup wieder her. Unit-Tests
prüfen spätere Wandzeitsprünge, monotone Fortschritte, ungültige Uhren und die
Wiederherstellung. 37 gezielte Tests bestanden in 4,085 Sekunden; anschließend
bestand der vorher fehlschlagende Fall 20 von 20 begrenzten Durchläufen.
Dieser Testnachtrag ist **nicht** Bestandteil des obigen CI-Commits. Er ändert
weder Browser-, Signaling- noch native Produktionslogik und belegt keinen Fix
des getrennten Ananta-Langzeitstillstands.

Alle fünf nativen CI-Artefakte von `2da0440` wurden heruntergeladen und anhand
von Größe/SHA-256 geprüft. Das Release-Manifest mit SHA-256
`9fc2358e1051eae1e5a84c12192992013ee5eb84d8af0c31377f041c6d1b26e1`
bestand die unabhängige Attestationsprüfung gegen Repository, Main-Ref,
Workflow, exakten Quellcommit und den Ausschluss selbst gehosteter Runner.
Das ist Herkunftsevidence, keine neue öffentliche Bereitstellung.

### Vorheriger lokaler Abschlusscheck: fehlgeschlagen

Der isolierte Gesamtcheck des Commits `d2cfea4` endete mit **Exit 1**:
1.198 Frontendtests und 1.108 Node-/Browserprüfungen bestanden, ein Nodefall
scheiterte, vier wurden ausdrücklich übersprungen (479,103 Sekunden Node).
Build, Go-Unit/Vet und statische Gates bestanden; die externe Infrastrukturstufe
wurde wegen des Fehlers nicht erreicht. Beide gekoppelten nativen Browserfälle
und die Ananta-Dialoge bestanden innerhalb dieses festen Prüfstands.

Der Fehler betrifft `live public v4 true signaling renews only after ACK and
stops on publisher revoke`: Die nächste Quellen-Lease wurde innerhalb der
Wanduhr-Beobachtungsfrist nicht gesehen. Der Test hatte 1,006 Sekunden gemessene
Gesamtdauer bei einer dreisekündigen Wanduhrfrist; das allein beweist weder eine
Uhrkorrektur noch deren Ursächlichkeit. Der separate Nachlauf aller vier
Signalingvarianten bestand in 3,870 Sekunden, ohne Runtime- oder Friständerung.
Das ist keine nachgewiesene Fehlerbehebung und kein nachträglicher Gesamterfolg.

Die Testbeobachtung protokolliert bei einem weiteren Fehler jetzt ausschließlich
begrenzte Wand-/Monotonzeitdifferenzen, Lease-Alter/-Restzeit, Socketzustände und
Nachrichtenzähler/-revisionen. Keine IDs, Tokens, Inhalte oder zusätzlichen
Browser-RPCs; keine automatische Wiederholung. Ein Produktionsrollout dieser
Änderungen bleibt ausstehend. Der separat auf dem Mini-PC laufende Browsertest
wird nicht durch ein Deployment unterbrochen.

### Gezielte Mehrquellen-Nachweise

Der nachträglich ergänzte Zwei-Quellen-Browserfall hat eine weitere echte Lücke
gefunden: `live → degraded` erhöhte die Anzeige-Programmrevision und entzog damit
auch der noch freigegebenen Bildschirmquelle ihre Zustimmung. Ein kleiner Test
mit den realen Registries reproduzierte genau diesen ungewollten Entzug.
Eine interne Quellenautoritätsrevision bleibt jetzt ausschließlich bei den
geprüften Ausgabestatuswechseln und revisionsneutraler Lease-Erneuerung erhalten.
Erstfreigaben prüfen weiterhin die aktuelle Einladungsrevision; bestehende
Freigaben zusätzlich diese interne Revision. Echte Programmänderungen, Epochen,
Widerruf, Membership, Writer, Ablauf und Quellenbindung bleiben geprüft.

Danach bestanden beide tatsächlichen Angular/Node/Go/SFrame/HLS-Browserfälle
in zusammen 54,747 Sekunden. Der neue Fall dekodierte Kamera und bewegten
Bildschirm nebeneinander, nach Kamerawiderruf links Slate und rechts weiterhin
wechselnde blaue Bildschirmbilder, nach Bildschirmwiderruf beide Plätze als
Slate. Keine zweite Zuschaueraktion und keine neue Quellenfreigabe. Beide
ursprünglichen Raum-Captures bleiben aktiv; der Zuschauer hat weder Capture
noch Room-Membership. Das sind zwei Quellen eines synthetischen Publishers,
keine Mehrpublisher- oder Produktions-Langzeitabnahme.

50 gezielte Registry-/Consent-/Prozessprüfungen bestanden anschließend, inklusive
neuer Freigabe nach Recovery, Lease-Erneuerung ohne Consentverlängerung und
terminalem Widerruf. Die Testfixture prüft nun tatsächliches Exit 0 ihrer nativen
Prozesse; Fehler/Signale sind kein bestätigtes Cleanup und erhalten ihr privates
Ausgabeverzeichnis. Das vermeintliche UI-Enabled-Flackern im ersten Nachlauf
war ein Testfehler: Nun wird die tatsächliche Szenenantwort abgewartet, nicht
nur ein fehlendes `disabled`-Attribut am Kind eines deaktivierten Fieldsets.

Der asynchrone Encoderbesitzer ist jetzt an die produktive Quellen-Generation
angeschlossen. Mixer und weiterhin autorisierte Decoder bleiben bestehen;
widerrufene Encoder einschließlich Ausgabe werden zuerst beendet und bereinigt.
Neue Encoder erhalten getrennte HLS-Segmentbereiche und eine gemeinsame neue
Audio-/Videozeitbasis. Zwischenzeitliche Frames werden verworfen, nicht gestaut.
Maximal 128 Generationen, acht Ersatzstarts pro Minute sowie die bestehenden
Setup-/Cleanup-/Readiness-Grenzen verhindern unbegrenzte Neustarts. Unbestätigtes
Cleanup hält den Besitz gesperrt, statt Kapazität fälschlich freizugeben.

Der native Status meldet `SOURCE_PROGRAM_RESTARTING` und anschließend wieder
`OUTPUT_READY`. Andere Ursachen wie thermische Überlast werden damit nicht
geheilt. Node übernimmt negative Zustände erst nach geprüfter Assignment-ACK;
ein aktueller gleicher Writer darf von `live` nach `degraded` und zurück
wechseln, ohne Quellen-, Policy-, Programm- oder Lease-Epochen zu erneuern.
Bestätigungen beendeter alter Writer dürfen keine Nachfolger verändern und
dürfen eine wiederverwendbare Agent-Verbindung nicht allein deshalb schließen,
weil die alte Writer-Lease bereits entfernt wurde.

Die erste gekoppelte Nachprüfung blieb rot: Der Viewer meldete
`broadcast_playback_generation_limit`. Er öffnete noch während `degraded`
wiederholt neue Sitzungen gegen den nicht bereiten Encoder. Der ergänzte
deterministische Test reproduzierte dieses zu frühe Öffnen. Der Viewer wartet
jetzt innerhalb derselben unveränderten sechs Versuche/75-Sekunden-Grenze auf
eine frisch autorisierte `live`-Ausgabe. Scopewechsel bleiben terminal,
Rate-Limits werden nicht wiederholt, Leave bricht weitere Versuche ab.

Der anschließende tatsächliche Angular/Node/Go/Origin/Viewer-Test bestand in
31,667 Sekunden: dekodiertes 640×360-Leerbild, rote ausdrücklich freigegebene
Kamera und danach neues dekodiertes Leerbild. Keine zweite Zuschaueraktion,
kein Zuschauer-Capture oder Room-Beitritt; die menschliche Raumkamera bleibt
aktiv. Der echte native Mehrquellen-Encoder-Test hatte zuvor rote Quelle mit
Ton, verbliebene blaue Quelle mit Ton und abschließend Leerbild/Stille über
drei Generationen und jeweils zwei Renditions dekodiert (17,357 Sekunden).
Dieser native Rohquellentest ist kein Mehrpublisher-SFrame-Browsernachweis.

34 gezielte Frontendtests, 23 Assignment-/Runtime-/Quellenvertragsprüfungen und
fünf echte HTTP-/WebSocket-Stop-/Handoff-Fälle bestehen. Der neue späte Stop-ACK
scheiterte zunächst am Socket-Abbruch und besteht nach der abgegrenzten
negativen Statusbehandlung. Native Status-/Rollover-/Ownerprüfungen bestehen
auch mit Race-Erkennung. Die gemeinsame isolierte Gesamtprüfung dieses
Änderungspakets folgt; TBP-030 bleibt offen. Kein Deployment dieser Arbeitskopie
und kein Fix-Claim für den getrennten Ananta-Langzeit-Bildstillstand.

### Gebündelter Prüfstand und korrigierter Prüfstart

Der feste Snapshot basiert auf `d628724` plus 38 unveröffentlichten Dateien;
deren nach Pfad sortierter, LF-normalisierter Inhaltsabgleich ergab SHA-256
`5b6e29f69e45f470c9130a387613648b0aa2d12da56bf4ba9299e683f4b6aede`.
Der isolierte Gesamtcheck in `/tmp/webrtc-rollover-final.EhNKEF` bestand mit
Exit 0: 1.198 Frontendtests, 1.100 Node-/Browserprüfungen, null Fehler und vier
explizite Node-Skips (Node: 459,433 Sekunden). Build, Go-Unit/Vet und statische
Gates bestanden; 14 externe Infrastruktur-Gates blieben sichtbar übersprungen.
Dieser feste Snapshot enthält noch nicht den Zwei-Quellen-Nachtrag und dessen
Quellenautoritätskorrektur oben. Diese gezielten Nachweise werden nicht als
Bestandteil des früheren Gesamtchecks ausgegeben; ein gemeinsamer finaler
Prüfstand folgt vor Veröffentlichung.

Der erste Aufruf startete versehentlich im Hauptverzeichnis. Sein Prüflauf wurde
mit Exit 143 abgebrochen; der bereits gestartete Build-Unterprozess ersetzte
jedoch noch die lokalen Assets. Die vorhandene vorherige Build-Sicherung wurde
anschließend vollständig zurückgespielt und per rekursivem Dateivergleich
bestätigt. Der ursprüngliche HTML-Hash
`2a9259b48e7e9676d8d48346247c4bd0e2bf37c1855b2fa9b8428618aa2ea783`
ist wiederhergestellt. Der versehentliche Build ist separat gesichert, nicht
gelöscht. Keine Behauptung, dass der lokale Serving-Pfad während dieses Fehlers
unverändert blieb; das öffentliche Mini-PC-Deployment war nicht betroffen.
Die eigentliche Gesamtprüfung wurde danach im richtigen isolierten Verzeichnis
gestartet, nicht als Wiederholung eines bestandenen Prüflaufs gewertet.

## Vorheriger Befund und verifizierte Grundlagen

Der gekoppelte Angular/Node/Go/HLS-Test reproduziert zwei inzwischen korrigierte
Startfehler: Das v4-Antwortfeld `inputMode` wurde als unbekannt abgelehnt, und
die unveränderte Quellen-Epoche einer leeren Sendung wurde fälschlich wie eine
Legacy-Quellenänderung behandelt. Korrigierte Fixtures reproduzierten beide
Fehler vor der Reparatur. Die getrennten Legacy-Prüfungen bleiben strikt.

Der echte Pfad startet anschließend, liefert ein dekodiertes 640×360-Slate,
überträgt nach eigener Aufnahme und ausdrücklicher separater Quellenfreigabe
SFrame-RTP zum tatsächlichen Packager und zeigt die roten Kamerapixel über
den echten Origin und autorisierten Angular-Zuschauer. Der Zuschauer hat
keine Room-Membership und startet keinen Capture.

Noch fehlend: Nach Widerruf beendet `sourceEncoderFence` korrekt die komplette
Encoder-Generation einschließlich bereits codierter Daten und löscht deren
Ausgabe. Der übergeordnete Programmbesitzer endet daraufhin mit
`SOURCE_PROGRAM_STOPPED`, statt unter seiner weiterhin gültigen Writer-Lease
eine neue Ausgabe mit Slate beziehungsweise verbleibenden Quellen zu bauen.
Die Browserprobe erreicht daher noch kein neues Slate; der Viewer verschwindet.
Außerdem verarbeitet die Control Plane bisher nur `OUTPUT_READY`, weshalb der
Director zeitweise weiter eine bestätigte Ausgabe meldet. Das ist kein
bestandener Widerrufs-/Mehrquellen-Produktionsnachweis.

## Umsetzungspfad

Eine getrennte lokale Output-Rollover-Komponente muss den alten Encoder erst
nachweislich beenden und dessen private und veröffentlichte Dateien invalidieren.
Nur ein nachgewiesener Quellen-Fence-Verlust darf einen Wiederaufbau auslösen;
Writer-/Membership-/Leaseverlust, unbekannte Fehler, fehlendes Cleanup und
Budgetüberschreitung bleiben terminal. Quellenrechte werden weder erneuert
noch rekonstruiert. Mixer/Decoder weiterhin freigegebener Quellen bleiben
separat vom ersetzten Encoder. Während des Wiederaufbaus werden Frames
begrenzt verworfen, niemals unbeschränkt gepuffert.

Der lokale HLS-Adapter besitzt jetzt getrennte Generationen: nicht
wiederverwendete Segmentnummernbereiche und konsistente Discontinuity-
Nummern über alle Renditions. Ein Encoder-Neustart setzt seine Samplezeit
zurück; dessen neue Timeline darf nicht als Fortsetzung alter Fragmente gelten.
FFmpeg bietet dafür unter anderem `start_number` und `discont_start` an.
[FFmpeg HLS-Muxer](https://ffmpeg.org/ffmpeg-formats.html#hls).
Beim Entfernen eines Discontinuity-Tags muss dessen Sequenznummer so angepasst
werden, dass verbleibende Segmente ihre Zuordnung behalten.
[RFC 8216, Abschnitt 6.2.2](https://www.rfc-editor.org/rfc/rfc8216.html#section-6.2.2).

Der Adapter erlaubt höchstens 128 lokale Encoder-Generationen pro Assignment.
Zusätzliche Frequenz-/Setup-/Cleanup-Grenzen braucht der noch anzuschließende
Outputbesitzer. Segmentnummern erhalten getrennte Bereiche von je einer Million
Nummern; Überschreiten endet, statt Nummern zu recyceln. Ein lokaler
Generationswechsel erweitert keine Serverautorität. Die aktuelle Lease und
alle individuellen Quellen-Fences sind vor jeder weiteren Ausgabe zu prüfen.

## Verifizierter Zwischenstand, noch kein automatischer Rollover

Der feste FFmpeg-Adapter erhält eine interne Epochennummer und daraus seinen
`start_number`. Die Dateistufe prüft die exakte, kanonische Segmentfolge im
zugehörigen Bereich. Der erste neue Abschnitt erhält eine Discontinuity;
verlässt er das gleitende Fenster, bleibt seine Zählung in dessen Sequenzwert
erhalten. Beginn und Ende des Fensters dürfen pro Rendition nicht zurückspringen.
Die projizierten Playlistbytes werden vollständig veröffentlicht, nicht mit
der kürzeren Länge der ursprünglichen FFmpeg-Datei abgeschnitten.

Der Test mit unveränderten Mediendateien reproduzierte zunächst beide
Fensterrücksprünge. Nach der Ergänzung werden sie vor Veröffentlichung abgewiesen.
Unbekannte Producer-Discontinuities, fremde Nummernbereiche, nichtkanonische
Dateinamen und das Überschreiten der 128 Generationen werden ebenfalls abgelehnt.

Der Encoder merkt sich außerdem die erste Stopursache unveränderlich über sein
Cleanup hinweg. `CanRollover()` ist ausschließlich eine lokale Eignungsprüfung:
nachgewiesener Quellenentzug, tatsächlich beendete Worker/Prozesse, erfolgreiches
Cleanup, aktuelle Writer-Autorisierung, kein Widerruf und verbleibendes
Generationsbudget. Writerverlust, absichtlicher Stop, unbekannte/ungültige Guards,
Quota-Fehler und fehlendes Cleanup dürfen dadurch nicht erneut gestartet werden.
Diese Methode startet selbst weder einen Encoder noch eine Quelle.

23 fokussierte Testgruppen einschließlich Race-Erkennung und echter FFmpeg-
Ausgabe bestanden in 40,930 Sekunden. Generationen 0, 1 und 127 dekodierten
je zwei Renditions mit wechselnden Originalpixeln und 700-Hz-AAC-Ton. Für dieses
Linux/libx264-Profil waren die Initialisierungsbytes über die Generationen
identisch; das ist kein Nachweis für Hardwareencoder oder andere Plattformen.
Quellenentzug räumte jeweils Encoder und Ausgabe auf. Der bestehende 26-Sekunden-
Test bestand zusätzlich mit gleitenden Playlists und zwei Renditions.
Das vollständige native Unit-/Vet-Gate bestand ebenfalls.

Noch kein neuer Gesamtcheck des gesamten Broadcast-Arbeitsstands und kein
Deployment: Der Programmbesitzer beendet seine Ausgabe weiterhin nach
Quellenentzug. Asynchroner Ersatzencoder, gemeinsame Samplezeit-Neuausrichtung,
aktuelle Bereitschaftsmeldungen und die durchgehende Zuschauer-Wiederaufnahme
sind die nächsten Implementierungsschritte. Der gekoppelte Widerrufstest bleibt
offen; erfolgreiche Encoder-Einzelprüfungen ersetzen ihn nicht.

Anschließend: tatsächlichen Zustand zurück zur Control Plane/Angular spiegeln,
gebaute Zuschauer bei Unterbrechung korrekt neu laden, mehrere weiterhin
freigegebene Quellen und wiederholten Widerruf dekodiert nachweisen. Erst dann
die gemeinsame Gesamtprüfung und Release-/Deploy-Gates. Der vorhandene
fehlgeschlagene gekoppelte Test bleibt ein offenes Akzeptanzkriterium.
