# Native Programmaudio-Steuerung

Arbeitsstand: native Grundlage, geschlossener Vertrag, authentifizierter
Control-Socket, serverseitiger Antwort-Broker, HTTP-Director und Angular-Bedienfeld
implementiert. Capability v3 weist Audio-Control v1, die neue Capability v4
Audio-Control v2 ausdrücklich aus.
TBP-014 bleibt offen; die bestehende Browser-Audiokonfiguration bleibt getrennt.

## Native Mischstrategien v2

Agent 0.11.0 meldet bei aktiviertem Quellenprogramm Capability v4 mit
`sourceAudioControlVersion: 2`. Der geschlossene v2-Vertrag ist durchgängig in
nativen Query-/Apply-/State-Nachrichten, Broker, HTTP-Director und Angular
angebunden. Ein tatsächlicher v3-Agent bleibt auf Gain/Mute v1 beschränkt;
ein Capability-Verlust verwirft ausstehende v2-Antworten. Ein v1-Pegelauftrag
auf einem neuen Agenten setzt dessen Strategie nicht zurück.

Vier bewusst wählbare Presets ändern ausschließlich den autorisierten nativen
PCM-Programmbus:

| Strategie | Bei aktiver priorisierter Quelle | Übersteuerungsschutz |
|---|---|---|
| Unbearbeitet | Keine Absenkung; kompatibler Ausgangszustand | Nur bisherige Sample-Begrenzung, Clipping möglich |
| Ausgewogen | Bildschirmton auf 50 % bei aktivem Mikrofon | Gemeinsamer Stereo-Limiter |
| Sprache zuerst | Bildschirmton auf 28 % bei aktivem Mikrofon | Gemeinsamer Stereo-Limiter |
| Bildschirm zuerst | Mikrofone auf 28 % bei aktivem Bildschirmton | Gemeinsamer Stereo-Limiter |

„Aktiv“ bezeichnet mindestens ungefähr 4,5 % Full-Scale-RMS im aktuellen
20-ms-Block nach den Einzelpegeln und Mute. Das ist keine Spracherkennung oder
Echounterdrückung. Absenkung wird innerhalb eines Blocks eingeregelt;
die Rückkehr hat ungefähr 300 ms Zeitkonstante. Der Stereo-Limiter betrachtet
die aufsummierten Samples desselben Blocks, begrenzt dessen Spitze auf 29490
von 32768 und erhält das Kanalverhältnis. Keine zusätzliche Medienqueue,
Capture-API oder lokale Kontrollwiedergabe wird angelegt.

Strategie und Einzelpegel teilen eine CAS-Revision und alle bestehenden
Quellen-, Writer-, Zeit- und Replayprüfungen. Ein v2-Auftrag darf nur die
Strategie mit leerer Pegelliste ändern, auch vor dem ersten autorisierten
Eingang. Er erstellt keine Quelle und verlängert keine Freigabe. Abfrage und
explizite Bestätigung bleiben erforderlich; alte oder widersprüchliche Werte
werden nicht automatisch erneut angewendet.

Die UI zeigt zusätzlich begrenzte skalare Messwerte des letzten Mischblocks
und die tatsächlich konfigurierte AAC-Zielrate je Rendition, 48 kHz und Stereo.
Die Zielrate ist keine gemessene Netzwerkdatenrate. Ein Strategiewechsel ändert
weder AAC-Format noch HLS-Epoche. Unabhängige Codec-/Kanalwahl benötigt weiterhin
einen eigenen Start-/Rendition-Vertrag; Opus-DTX/FEC wird für diesen AAC-Ausgang
nicht als anwendbare Einstellung angeboten. Physische Akustik, Bluetooth und
Packager-Handoff bleiben eigene offene TBP-014-Kriterien.

Deterministische Prüfungen umfassen alle Presets, Post-Gain-Schwelle, Mute ohne
Nachspielen, geglättete Rückkehr, 80 gleichzeitig begrenzte Eingänge,
stereogekoppelte Spitzenbegrenzung, atomare konkurrierende Änderungen und
Widerruf. Gemeinsame Go-/Node-Fixtures, beide HTTP-Schemas, tatsächliche
HTTP-/Socket-Registries und Angular prüfen Versionsgrenzen und Rechteentzug.
Der neue reale HLS-Test unterscheidet synthetisches Mikrofon (440 Hz) und
Bildschirmton (880 Hz) in beiden dekodierten Kanälen mittels begrenzter DFT.
Pegel/Mute und Strategien erhalten getrennte frische Testprogramme, damit
beide innerhalb ihrer unveränderten Quellenfreigaben geprüft werden können.
Ein erster Lauf hatte einen falschen UI-Selektor; der folgende kombinierte
Lauf erreichte bestätigte 50-%-Absenkung, verlor dann aber die zuvor erteilte
Mikrofonfreigabe. Diese fehlgeschlagenen Läufe sind keine Gesamtabnahme.
Der anschließende separate Strategietest bestand in 71,208 Sekunden. Tatsächlich
dekodierte Amplituden (Mikrofon/Bildschirmton, beide Kanäle vergleichbar):
ungefähr 0,249/0,252 unverarbeitet, 0,249/0,125 ausgewogen, 0,250/0,070 bei
Sprachpriorität und 0,071/0,250 bei Bildschirmpriorität. Zurück auf unbearbeitet
ergaben sich wieder 0,248/0,249. Frames und Wiedergabezeit schritten fort;
nach Quellenwiderruf war der Ausgang still. Native Revisionen 1 bis 9,
beide Raum-Captures blieben vom Broadcast-Widerruf unberührt. Das ist ein
digitaler synthetischer Ende-zu-Ende-Nachweis, keine physische Akustikabnahme.
Der gemeinsame isolierte Gesamtcheck endete mit Exit 1: 1.221 Frontendtests,
Build (14,838 s), Typen, Go-Unit/Vet und statische Gates bestanden; 1.176
Node-/Browserprüfungen bestanden, eine scheiterte und vier waren explizit
übersprungen (537,922 s). Der einzige Fehler betraf den nachgeschalteten
Einzelwiderruf nach allen vier Strategiewechseln: Bei der Abfrage nach 62,421 s
waren null statt einer Quelle übrig. Alle vier Strategieausgänge waren zuvor
bestätigt; der getrennte Gain/Mute-Fall bestand in 48,278 s.

Die Strategiematrix erhält deshalb zwei unabhängige Programme mit jeweils zwei
Strategien und beiden Einzelwiderrufen. Kein Preset oder Widerruf wird aus der
Abnahme entfernt; eine abgelaufene Quelle wird nicht als noch freigegeben
vorausgesetzt. Runtime, Consent-Dauer und Messgrenzen bleiben unverändert.
Ein gezielter Nachlauf verwendet den unveränderten isolierten Build. Die
externe Infrastrukturstufe wurde im fehlgeschlagenen Gesamtcheck nicht erreicht;
der optionale Image-Scan blieb ausdrücklich SKIP. Kein Produktions-Rollout.

Beide abschließenden Strategiepaare bestanden gegen diesen unveränderten Build:
62,057 s für Ausgewogen/Sprachpriorität und 55,059 s für Bildschirmpriorität/
Unbearbeitet (zusammen 118,125 s, keine Skips). Jeweils bestätigen native
Revisionen 1 bis 7 zunächst zwei, nach dem ersten Widerruf genau einen und
nach dem zweiten keinen Eingang; die letzte Strategie bleibt erhalten.
Der Zuschauer erhält anschließend Stille, beide Raum-Captures bleiben aktiv.
Der alte Gesamtcheck bleibt als fehlgeschlagener Lauf dokumentiert. Die
nächste CI muss den finalen Stand einschließlich dieser Testaufteilung prüfen.

### Zwischennachweis nach Bildschirmton-Widerruf

Der spätere CI-Lauf `34525060305` scheiterte beim zweiten Widerruf am Warten auf
`OUTPUT_READY`. Die Encoder-Sperre merkt tatsächliche Beitragsquellen: Hat das
Mikrofon zur neuen Generation noch nichts beigetragen, erzwingt sein Widerruf
keinen weiteren Encoderwechsel. Eine Quellenliste allein beweist keinen Beitrag.

Der Browsertest prüft deshalb vor diesem zweiten Widerruf zusätzlich mindestens
eine Sekunde fortlaufende Ausgabe: In beiden dekodierten Kanälen muss der
440-Hz-Mikrofonton wieder den ursprünglichen Pegel erreichen, während der
880-Hz-Bildschirmton verschwunden ist. Alte Frames, Stille, nur ein funktionierender
Kanal oder weiterhin vorhandener Bildschirmton reichen nicht aus. Erst danach
wird auch das Mikrofon widerrufen und weiterhin Encoderwechsel sowie Stille
verlangt. Consent, Wiederanlauf- und Messfristen bleiben unverändert.

Vier browserfreie Mess-/Warteprüfungen und der isolierte native Encoder-Fence-Test
einschließlich Race-Detector bestehen. Der erste Container-Teststart scheiterte
am nicht ausführbaren temporären Dateisystem; nach explizitem `exec` bestand der
Test ohne Änderung des getesteten Codes. Lokale echte Medienprüfungen bleiben
pausiert. Die erweiterte reale Angular-/Native-/HLS-Abnahme ist noch durch CI zu
bestätigen; die vermutete Ursache des ursprünglichen Timeouts ist damit noch
nicht abschließend bewiesen. Keine neue Deploymentfreigabe.

Der nachfolgende CI-Lauf `34527707396` schlug in beiden erweiterten
Zwischennachweisen fehl. Im ersten Fall war der gewünschte Mikrofonton bereits
korrekt vorhanden (0,25085), der Bildschirmton verschwunden (0,000035).
Die neue HLS-Ausgabe zeigte jedoch erst 22,76 Sekunden/346 Frames gegenüber
27,93 Sekunden/424 Frames vor dem Wechsel. Der Test hatte fälschlich
generationsübergreifend steigende Elementzähler verlangt.

Eine neue browserfreie Regression reproduziert diesen Testfehler. Die private
Frequenzprobe zählt jetzt `currentSrc`-Wechsel als begrenzte numerische
Mediengeneration; die eigentlichen URLs verlassen die Probe nicht. Eine neue
Generation darf niedrigere Zeit-/Framezähler haben. Die stabile Messsekunde
mit steigendem Framezähler muss vollständig innerhalb derselben Generation
liegen; Quellenwechsel oder Zählerrücksprünge setzen dieses Fenster zurück.
Ton-, Stille-, Consent- und Zeitgrenzen bleiben unverändert. Fünf gezielte
Messprüfungen bestehen; der echte erweiterte Audiopfad benötigt erneut CI.
Der fehlgeschlagene Lauf bleibt mit 1.365 bestandenen Tests, zwei Fehlern und
vier Skips dokumentiert; Ananta-TURN, Native, Blind und macOS bestanden,
Live-Keycloak/TURN und Docker wurden nach dem roten Projektgate übersprungen.

## Historische v1-Abnahme

Die nachfolgende CI `34404162155` auf `406f95d` bestand den neuen nativen
Audioausgang, scheiterte aber im separaten Einzelquellen-Szenentest
([Befund und Prüfgrenze](native-source-output-rollover.md)). Es gibt deshalb
keine neue Deploymentfreigabe aus diesem Lauf. Native-, Blind-Agent-, beide
macOS- und Ananta-TURN-Jobs bestanden. Das Manifest und das Linux-amd64-Binary
von Version 0.10.0 wurden zusätzlich unabhängig gegen exakten Commit, Main,
Workflow und GitHub-Runner-Policy attestiert; alle fünf Dateien entsprechen
Größe und Hash des attestierten Manifests. Dieser Herkunftsnachweis ersetzt
keinen vollständigen CI-Erfolg oder eine Installation.

## HTTP-Director und Angular-Anschluss

`POST /api/broadcasts/:programId/native-source-audio` akzeptiert ausschließlich
geschlossene Query-/Apply-Anfragen. OIDC, aktuelle menschliche Membership,
Gerätebindung, Programmrollen, Programmrevision/-Epoch, aktueller Writer,
Assignment, Socket und Raumgeneration werden vor Versand, während des Wartens
und vor der Antwort geprüft. Query ist nur eine Zustandsaufnahme, kein Consent.
Der HTTP-Vertrag gibt weder Writer-Lease noch Control-Command-ID oder Medien aus.

Die neue native Version 0.10.0 meldet bei ausdrücklich aktiviertem
Quellenprogramm Capability v3 mit `sourceAudioControlVersion: 1`; v1/v2 bleiben
kompatibel, erhalten dadurch aber keine Audio-Steuerung. Der UI-Kontext verlangt
diese Capability vom tatsächlich kontrollierten Packager, nicht von irgendeinem
anderen installierten Agenten. Bestehende Quellen- und Szenensteuerung bleiben
kompatibel.

Im laufenden nativen Quellenprogramm bietet **Programmaudio** eine explizite
Abfrage, getrennte Links-/Rechtspegel von 0 bis 100 Prozent und Mute pro Eingang.
Änderungen bleiben lokal, bis der Benutzer die Anwendung bestätigt. Nur eine
höchstens fünf Sekunden frische, unveränderte Zustandsaufnahme darf angewendet
werden. Ablauf, Scopewechsel, Konflikt oder Bestätigung erfordern eine neue
Abfrage; keine automatische Wiederholung oder Freigabeverlängerung. Das Panel
startet weder Capture noch Monitoring und ändert nicht die Raumwiedergabe.

51 Frontendprüfungen der Audio-/Szenen-/Programmcontroller bestanden in 919 ms,
31 Node-Vertrags-/Capability-/Broker-/Assignmentprüfungen in 372 ms. Der echte
HTTP-v4-Integrationsfall bestand anschließend in 1,275 s inklusive fremdem
Benutzer/Gerät, veralteter Revision, Backpressure, parallelem Auftrag, Query,
Apply, Konflikt und Capability-Entzug. Dieser HTTP-Test verwendet synthetische
native Antworten; er beweist keinen realen Decoder- oder Audioausgang. Angular-
Template- und Broadcast-Typprüfung bestanden im vorausgehenden Implementierungsschritt.

Die anschließend explizit aktivierte echte TLS-/P-256-Control-Matrix mit v3
bestand alle sechs Fälle mit Race-Erkennung in 12,648 s: Stop, Disconnect,
Cancel, doppelte Authentifizierung, deaktivierter Quellenmodus und fehlende
Authentifizierung. Die erlaubten Pfade bestätigen Query, Gain/Mute, CAS-Konflikt
und erneute Abfrage. Wie bei der früheren Socketstufe ist das kein Nachweis
eines abgeschlossenen Audio-RTP-/SFrame-Schlüssel-/Decoder-/Zuschauerpfads.

Die durchgehend gerenderte Browser-/Native-Audio-Abnahme besteht jetzt gemeinsam
mit beiden Szenenfällen: drei Tests, null Fehler in 115,350 s. Der Audiotest
(45,881 s) misst beim tatsächlichen HLS-Zuschauer RMS 0,177/0,177 vor Änderung,
0/0 bei Mute, 0,0885/0,0444 nach bestätigten 50/25 Prozent und wieder 0/0 nach
Quellenwiderruf. Dabei schreiten die dekodierten Frames und die Wiedergabezeit
fort; ein eingefrorener Player genügt nicht. Die echte native Revision läuft
von 1 bis 5, die getrennte Raummikrofonquelle bleibt nach Broadcast-Widerruf aktiv.
Das ist ein synthetischer digitaler Ende-zu-Ende-Nachweis, keine physische
Echo-/Lippensynchronitäts- oder Produktionsabnahme.

Zwei vorherige Audioausgangsläufe scheiterten an einem reproduzierten
[HLS-Ratebudgetfehler](broadcast-playback-rate-budgets.md), der vor diesem
bestandenen Nachlauf korrigiert wurde. Der gemeinsame isolierte Projektcheck
des aktuellen Arbeitsstands einschließlich der priorisierten Ananta-Integration
ist ebenfalls bestanden (Exit 0): 1.209 Frontendtests, 1.143 Node-/Browserfälle,
null Fehler und vier Node-Skips in 513,191 s; Build, Typprüfung und Go-Unit/Vet
bestanden. Der Audiofall bestand in dieser Runde in 43,510 s, beide Szenenfälle
in 25,706/27,587 s. 14 externe Gates und der Image-Scan blieben ausdrücklich
übersprungen. Das ist kein Rollout oder Abschluss aller TBP-014-Kriterien.
Der frühere getrennte Ananta-Renewal-Gesamtcheck enthält
diese Broadcast-Arbeitskopie nicht.
Die folgenden Nachweise sind historische Stufen, nicht ein nachträglicher
Ende-zu-Ende-Nachweis des neuen Panels.

## Zustands- und Berechtigungsgrenze

Der Mixer hält eine eigene monotone Audio-Revision. Quellenaufnahme,
Quellenende und Pegeländerung invalidieren ältere Auswahlen. Eine Batchänderung
mit bis zu 80 lokalen Eingangshandles prüft die erwartete Revision, alle
Eingänge, Pegelgrenzen und die aktuelle Befehlsfreigabe vor der Mutation.
Duplikate, fremde/geschlossene Quellen, ungültige Pegel oder verlorene Rechte
führen zu keiner partiellen Pegeländerung. Erschöpfung der sicheren
Revisionsgrenze beendet den Mixer, statt eine alte Revision wiederzuverwenden.

Die Programm-Grenze übersetzt ausschließlich eigene noch freigegebene
Source-Lease-IDs in diese Handles. Sie kann weder Quellen, Decoder, Schlüssel
noch Mitgliedschaften erzeugen. Videopublikationen sind keine Audioeingänge.
Eine Abfrage liefert sortierte Kopien der Einstellungen, keine PCM-Daten,
Schlüssel, Pegelmessung oder zusätzliche Zugriffsberechtigung.

## Pegel und Stummschaltung

Linker und rechter Kanal besitzen Q15-Werte von 0 bis 32768, also maximal
Einheitsverstärkung. Mute ist separat: Die Werte bleiben erhalten, aber
stummgeschaltete Samples werden beim jeweiligen Programmtakt konsumiert und
verworfen. Beim Aufheben von Mute darf kein zuvor stummer Puffer nachspielen.
Der vorhandene direkte interne `SetGain`-Pfad berücksichtigt dieselbe Revision.

Mute widerruft keinen Consent. Quelle und Decoder bleiben im erlaubten
Lebenszyklus; ein echter Quellenwiderruf bleibt terminal. Writerverlust löscht
die PCM-Puffer. Bereits an Encoder/Zuschauer gelieferte Bytes können durch eine
spätere Pegeländerung nicht zurückgerufen werden. Monitoring, Talkback, Capture
und die interaktive Raumwiedergabe erhalten keinen neuen Signalpfad.

## Verifikation und nächste Integration

### Authentifizierter Kontrollkanal und Antwort-Broker

Die native Dekodierung und Dispatch-Schleife akzeptieren die beiden Audio-Befehle
nur im expliziten Quellenprogramm-Modus. Der Handler prüft authentifizierte
Session, aktuellen Owner, Assignment-/Programm-/Writer-Bindung sowie Ablauf
erneut vor der Antwort. Ein eigener Revisions-/Quellenkonflikt liefert den
fünften geschlossenen Vertrag `source-audio-rejected` mit `AUDIO_NOT_APPLIED`,
ohne den Encoder zu zerstören. Ungültige oder nicht autorisierte Befehle sind
weiter fail-closed; es gibt keinen Decrypt-, Capture- oder Quellenaufnahmeport.

Der Node-Broker hält höchstens 128 offene Aufträge und einen pro Packager,
übernimmt das vorhandene opake Raum-/Verbindungs-Handle statt einer erfundenen
numerischen Generation und friert den ursprünglichen Auftragskontext ein.
Antworten müssen zu Socket, Member, Writer, Programmrevision und kurzer Deadline
passen. Alle 100 ms wird aktuelle Autorität erneut geprüft. Abort, Disconnect,
Scopewechsel, Uhrenrücksprung und Serverende räumen Pending und Timer auf; kein
automatischer Wiederholungsauftrag entsteht. Die Control-Plane bindet Antworten
an diesen Broker erst nach Authentifizierung und bestehendem Rate-Limit; ohne
offenen Auftrag erzeugt eine Antwort keine Autorität. Der spätere HTTP-Director
muss die menschlichen Rollen und die separate Audio-Capability noch prüfen.

Die ersten neuen Tests scheiterten, weil sie `receiver-prepared` fälschlich als
angelegten Audioeingang behandelten. Tatsächlich bindet erst das aktuelle
SDP-Angebot den Receiver an den lazy Programmeingang. Die Owner-Unitfixture
bindet ihren bereits autorisierten Receiver nun ausdrücklich; der TLS-Test
sendet ein echtes Pion-Opus-/DataChannel-Angebot über den bestehenden Signaling-
Vertrag. Asynchrone Antwort-/ICE-Nachrichten ausschließlich dieser synthetischen
Quelle werden beim Lesen begrenzt von Steuerantworten getrennt. Produktions-
Quellenaufnahme und Fristen wurden nicht geändert.

Nach dieser Fixture-Korrektur bestanden zwei Socket-/Ownerprüfungen mit
Race-Erkennung (1,080 s), der echte TLS-/P-256-Stopfall (3,977 s) und anschließend
die vollständige Sechs-Fälle-TLS-Matrix mit Race-Erkennung (12,398 s; Stop,
Disconnect, Cancel, doppelte Authentifizierung, deaktivierter Quellenmodus und
fehlende Authentifizierung). Die zugelassenen Fälle prüfen Query, Pegel/Mute,
CAS-Ablehnung und erneute Abfrage bei tatsächlicher HLS-Bereitschaft. Das belegt
keinen Audio-RTP-, Schlüsselaustausch-, Decoder- oder Zuschauersamplepfad.

20 Node-Vertrags-/Broker-/Control-Regressionen bestanden in 228 ms; zusätzlich
bestand der vorhandene echte HTTP-v4-Start-/Szenenfall in 635 ms. Der vollständige
native Unit-/Vet-Lauf bestand (Daemon 27,327 s). Der Audio-HTTP-Endpunkt und die
Angular-Bedienung fehlen weiterhin. Keine neue Capability, kein Commit oder
Rollout dieses Arbeitsstands; die separat dokumentierten CI-/HLS-Fehler bleiben
offen. Der gemeinsame Projektcheck folgt nach dem vertikalen Anschluss.

Die vier additiven Verträge `source-audio`, `source-audio-query`,
`source-audio-applied` und `source-audio-state` liegen unter
`contracts/native-packager/`, gemeinsame Fixtures unter
`native-broadcast-packager/testdata/`. Sie ändern die bestehende Szenensteuerung
nicht. Die native Eingangsprüfung begrenzt 16 KiB, exakt bekannte und nicht-null
gesetzte Felder, eindeutige Source-Lease-IDs, höchstens 80 Eingänge, sichere
Ganzzahlen und maximal vier Sekunden Laufzeit bei einer Sekunde Zukunftstoleranz.
Das Schema allein beweist weder Frische noch eindeutige IDs bei unterschiedlich
konfigurierten Eingängen; diese Prüfungen erzwingt der native Parser zusätzlich.

Der Owner-Adapter serialisiert Abfragen und Änderungen getrennt von der
Szenensteuerung. Assignment, Programm-Epoch, Writer-Lease und Fence müssen zum
aktuellen Owner passen. Ein Ablauf während des Wartens auf den Mixer verhindert
die Mutation; eine rückwärts laufende Uhr wird nicht als neue Freigabe behandelt.
Maximal 32 kurzlebige, digestgebundene Bestätigungen ermöglichen Wiederholung
ohne zweite Mutation. Eine geänderte Wiederholung wird abgewiesen, die Reihenfolge
derselben Batch-Einträge ist dagegen bedeutungslos. Alte Bestätigungen belegen
nur die frühere Anwendung und verlängern niemals Quellenrechte.

123 fokussierte Go-Prüfungen einschließlich Untertests bestanden mit
Race-Erkennung in 13,365 Sekunden, ohne Fehler oder Skip. Der anschließend
ergänzte Fall mit einem tatsächlichen autorisierten SourceReceiver bestand
separat mit Race-Erkennung in 1,046 Sekunden: Pegel/Mute bestätigt, nach Quellenende
keine Wiederbelebung, kein gestarteter Decoder. Vier strikte JSON-Schema-Prüfungen
mit denselben Fixtures bestanden in 186 ms. Das ist noch kein Socket-, HTTP-,
Angular-, Encoding- oder physischer Akustiknachweis.

Der anschließende vollständige native Unit-/Vet-Lauf dieses Vertragsstands
bestand ebenfalls (Daemon 27,707 Sekunden). Der gemeinsame Projekt-Gesamtcheck
bleibt bis zum zusammenhängenden Socket-/Broker-/UI-Anschluss ausstehend.

39 fokussierte Mixer-/Quellen-/Generation-Prüfungen bestanden mit Race-Erkennung
in 1,118 Sekunden, ohne Skip. Sie prüfen echte PCM-Samplewerte, Mute/Unmute,
Revisionskonflikte, atomare Mehrquellenablehnung, zwölf konkurrierende Änderungen
mit genau einem Gewinner, Quellenentzug, Writerverlust und Revisionserschöpfung
auch während der Ausgabe. Der ganze native Unit-/Vet-Lauf bestand; Daemon-Tests
27,147 Sekunden. Das ist kein physischer Akustik- oder Encoding-Nachweis.

Der erste neue Owner-Test übergab nach dem Anbinden aktueller Receiver erneut
den alten Fixture-Zeitstempel an deren Prune-Pfad. Dessen Rollback-Schutz entzog
die zuvor angebundenen Quellen korrekt. Die Receiver werden in dieser
synthetischen Fixture nun vor dem Anbinden der lebenden Konsumenten vorbereitet;
keine Produktionszeit oder Ablaufgrenze wurde dafür gelockert.

Auch nach dem bestandenen gebündelten Projekt-Gesamtcheck dürfen native
Audio-Profile, Sprachpriorität, Ducking und eine physische Echo-/Pegelabnahme
nicht allein aus diesen neuen Pegel-Operationen als fertig abgeleitet werden.
