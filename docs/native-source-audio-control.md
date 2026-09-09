# Native Programmaudio-Steuerung

Arbeitsstand: native Grundlage, geschlossener Vertrag, authentifizierter
Control-Socket, serverseitiger Antwort-Broker, HTTP-Director und Angular-Bedienfeld
implementiert. Die additive Capability v3 weist Audio-Control v1 ausdrücklich aus.
TBP-014 bleibt offen; die bestehende Browser-Audiokonfiguration bleibt getrennt.

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
