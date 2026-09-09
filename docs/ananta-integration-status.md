# Ananta-Hub und Worker: Integration und Aktivierung

Stand: 10. September 2026. Implementierung, lokale Integration und öffentliche
Aktivierung sind unterschiedliche Zustände. Die öffentliche Meet-Instanz meldet
bei der aktuellen Prüfung `admissionEnabled: false`: Noch kein produktiver
KI-Beitritt. Der gesamte aktive Ananta-Track ist nicht abgeschlossen.

## Aktuell: sechs Grundfunktionen vorhanden, Aktivierung noch ausstehend

Priorisierte Nachprüfung am 10. September: Die sechs Funktionen bleiben
Meet-seitig verbunden. Alle vier echten Dialogfälle mit Chromium/Firefox
über authentisiertes TURN-UDP und TURN-TCP bestehen mit Audio, Chat,
Bildschirm, drei Erneuerungen und Widerruf. Die
[private TLS-Startprüfung](machine-tls-readiness.md) erzwingt jetzt ihre
Gesamtfrist auch bei verspäteten Antworten und hinterlässt keine gepoolten
Verbindungen. Der Anlass war ein fehlgeschlagener Chromium-Testaufbau in
CI `34413091470` auf `6fdf26e`; dessen Ursache ist damit nicht bewiesen.
Der neue gemeinsame isolierte Projektcheck ist erfolgreich abgeschlossen:
1.221 Frontendtests, 1.189 Node-/Browserprüfungen, null Fehler, vier explizite
Node-Skips. Build, Typprüfung, Go und statische Gates bestanden; 14 externe
Infrastrukturprüfungen und der optionale Image-Scan blieben übersprungen.
Auch beide nativen Szenenfälle bestanden lokal; die gesonderte ältere CI
bleibt rot. Kein neuer Commit, Push oder Deployment in dieser Nachprüfung.
Die nachfolgenden älteren Nachweise gelten jeweils nur für ihre Revision.

Ein frischer öffentlicher GET bestätigt alle acht Software-Capabilities,
aber weiterhin `admissionEnabled: false`. Für die tatsächliche öffentliche
Hub-/Worker-Teilnahme fehlen das ausgewählte Hub-Trustprofil und der
freigegebene Ananta-Projektauftrag. Keine Produktionsfreigabe, kein Neustart
und keine Änderung im Ananta-Repository in dieser Nachprüfung.

Audioempfang, Chatlesen/-antworten, agenteneigener Bildschirm, erneuerbare
Sitzungen, Berechtigungsprüfung und Angular-Freigaben sind Meet-seitig verbunden.
Die zuvor geprüfte Revision `7be5c7df2d92486e69f0ed9ef9a49e1ed098f055`
besitzt jetzt eine vollständig erfolgreiche
[CI 34409010146](https://github.com/ananta888/webrtc-minimize-server/actions/runs/34409010146):
alle acht Jobs einschließlich Browser-Gates, authentisiertem Ananta-TURN-Dialog,
Live-Keycloak/TURN und Docker. Die getrennte uncommittete native Audio-Arbeit
ist darin nicht enthalten. Der unten dokumentierte lokale Firefoxfehler bleibt
ein fehlgeschlagener Lauf ohne bewiesene Ursache; eine spätere grüne CI ist
kein nachgewiesener Fix und keine abgeschlossene Langzeitabnahme.

Frisch ausgeführt: 126 Frontendtests für Quellenfreigaben, Integration,
Audio-/Chat-/Bildquellen und Sitzungswechsel sowie 100 Node-Tests für
Chatverträge, Receive-Policy, Leases, Hub-Trust und Integration. Alle bestanden,
keine Skips. Kein zusätzlicher Gesamtcheck nach dieser reinen Statusergänzung;
der oben genannte CI-Nachweis gehört ausschließlich zur exakten Revision.

Die öffentliche Instanz antwortet weiterhin mit `admissionEnabled: false`.
Die rein lesende Mini-PC-Prüfung bestätigt `disabled disabled` und einen
sauberen Checkout auf `5602ccf`; das ist kein Nachweis der laufenden Image-Revision.
Bei der Prüfung war ein Teilnehmer in einem Raum aktiv. Kein Dienst wurde
neu gestartet, keine Betreiberpolicy geändert und das Ananta-Repository nicht
bearbeitet.

Für den nächsten produktiven Schritt fehlen die ausdrückliche Auswahl des
öffentlichen Hub-Trustprofils und der freigegebene Ananta-Projektauftrag.
Benötigt wird die konkrete Konfiguration, kein privater Schlüssel oder Token.
Danach folgen Preflight, kontrollierter Rollout ohne Unterbrechung eines
belegten Raums und eine separat vorautorisierte gemeinsame Live-Abnahme.
Die Softwareübersicht ist bereits unter **Analyse → Ananta · Freigaben meiner
Quellen → Betreiberstatus** verfügbar; sie meldet keine aktive Hub-Verbindung.

## Priorisierter Nachtrag: lokale Erneuerungsentscheidung

Die sechs gewünschten Grundfunktionen bleiben integriert. Neu abgesichert ist
die [clientseitige Erneuerungsgrenze](machine-client-renewal-boundary.md): Ein
verspäteter erfolgreicher Server-ACK darf die inzwischen abgelaufene lokale
Sitzung nicht wiederbeleben. Sechs vorher fehlgeschlagene Service-Regressionen
sowie die echten Chromium-/Firefox-Fälle bestehen nach der Korrektur.
Die aktiven Dialoge mit Audioempfang, Chat, Bildschirm, drei Renewals und
unverändert widerrufbaren Quellenfreigaben bestehen ebenfalls. Der gemeinsame
isolierte Gesamtcheck bestand 1.217 Frontendtests und 1.160 Node-/Browserfälle,
scheiterte jedoch an einer Firefox-Avatarprüfung nach bestätigtem Renewal
(vier Node-Skips). Deren unveränderter gezielter Nachlauf bestand in 13,108 s;
die Ursache bleibt offen und der Gesamtcheck bleibt rot. Kein Deployment.

Die CI `34406142613` des vorherigen Commits `6e099b8` ist insgesamt **rot**:
Der Ananta-Dialog über authentisiertes TURN bestand, aber der separate
Zwei-Quellen-Broadcast zeigte nach bestätigter Szenenanwendung weiterhin das
Wartebild. Die Einzelquellenprüfung bestand diesmal. Dies erklärt weder die
frühere Intermittenz noch den Ananta-Langzeitstillstand und wird nicht durch
die vorliegende Renewal-Korrektur als behoben ausgegeben.

Der aktuelle öffentliche Status bestätigt weiterhin `admissionEnabled: false`
bei vorhandenen Softwarefähigkeiten. Der beobachtete aktive Raum bleibt
unangetastet. Betreiber-Trust und Ananta-Projektauftrag werden nicht allein
aus SSH-Zugriff oder einem gemeinsamen Benutzerkonto abgeleitet.

## Aktueller Nachtrag: öffentlich ausgelieferte Integration

Die erneute priorisierte Abnahme auf `529040f` einschließlich der offenen
Broadcast-Arbeitskopie ist im isolierten Checkout **bestanden (Exit 0)**:
1.209 Frontendtests, 1.143 Node-/Browserfälle, null Fehler und vier explizite
Node-Skips (513,191 s). Build, Typprüfung und Go-Unit/Vet bestanden ebenfalls.
Die beiden aktiven Ananta-Dialoge bestanden in Chromium 10,119 s und Firefox
11,061 s, jeweils mit vier Phasen mit
16.000 entschlüsselten PCM-Samples, korrelierten Chatantworten, dekodierten
roten/grünen Bildschirmbildern und drei Sitzungserneuerungen. Persönliche
Quellenfreigaben bleiben unverlängert; Widerruf sperrt auch nach einem weiteren
Renewal. Beide nativen Szenenfälle und der neue reale Audioausgang bestanden
ebenfalls. 14 externe Infrastruktur-Gates und der optionale Image-Scan wurden
ausdrücklich übersprungen; die separate Langzeitabnahme bleibt offen.
Prüfprotokoll: `/tmp/webrtc-ananta-priority-check.lfJUA1/check.log`.
Es handelt sich um private synthetische Testidentitäten, nicht um eine
öffentliche Hub-Aktivierung.
Ein frischer öffentlicher GET bestätigt weiterhin `admissionEnabled: false`.

Der anschließende priorisierte Review sichert die
[Ablaufgrenze bei der Erneuerungsentscheidung](machine-renewal-decision-boundary.md)
ab. Die neuen Deadline-/Rücksprungregressionen reproduzierten zunächst eine
unzulässige Verlängerung; nach der Korrektur bestehen die gezielten Prüfungen
und beide aktiven Audio-/Chat-/Screen-Dialoge. Dieser lokale Nachtrag ist noch
nicht ausgerollt und behebt nicht nachweislich den separaten Langzeitstillstand.

Der geprüfte Stand `5a10338` ist jetzt über den regulären Drei-Dienste-Runner
auf dem Mini-PC ausgerollt. CI `34380159740` bestand alle acht Jobs. Der neue
öffentliche Integrationspfad liefert den strikten JSON-Vertrag statt der alten
HTML-Ausweichseite; die Softwareübersicht und der Maschinenclient sind damit
öffentlich verfügbar. Beide echten Browser-Client-Proben, Chromium und Firefox,
bestanden ohne Capture, WebSocket oder PeerConnection. Alle fünf öffentlichen
Packager-Downloads entsprechen dem unabhängig attestierten CI-Manifest.

Audioempfang, Chat, eigene Bildschirmquelle, Sitzungserneuerung und die
Freigabeoberfläche sind in diesem Softwarestand enthalten. Eine öffentliche
Hub-/Worker-Teilnahme wurde damit **nicht** aktiviert: Die explizite Auswahl
bleibt `disabled disabled`, `admissionEnabled: false`. Dafür fehlen weiterhin
das vom Betreiber ausgewählte öffentliche Hub-Trustprofil und der freigegebene
Ananta-Projektauftrag. Gemeinsame Langzeitabnahme und die übrigen offenen
Trackkriterien bleiben getrennt. [Rollout und genaue Prüfgrenzen](ananta-public-rollout-20260909.md).

Der während dieses Rollouts eingegangene Nachtrag `0c75dea` dokumentiert zudem
einen fehlgeschlagenen separaten Langzeitlauf: Bildschirmstillstand beim
Empfänger nach etwa 36 Minuten, Ursache noch offen. Der neue Software-Rollout
ist kein nachgewiesener Fix dafür. Die [Langzeitdiagnose](ananta-linux-grouped-check-20260909.md#third-long-reference-receiver-movement-failure)
bleibt Teil der offenen gemeinsamen Abnahme.

## Vorheriger Nachtrag: Erneuerung im aktiven Dialog

Die Meet-seitigen Funktionen sind bereits implementiert. Der neue
[aktive Renewal-Dialog](machine-active-dialog-renewal.md) schließt eine konkrete
Prüflücke: Audioempfang, Chat und eigene Bildschirmquelle bleiben bis zum
Lease-Wechsel gleichzeitig aktiv; anschließend müssen alte Zugriffe scheitern
und frisch geöffnete Quellen wieder echte Samples, Antworten und dekodierte
Bildschirmfarben liefern. Publisherfreigaben dürfen dabei nicht verlängert
oder nach Widerruf wiederhergestellt werden. Chromium und Firefox bestehen
die vier Dialogphasen mit drei solchen Erneuerungen. Der isolierte Gesamtcheck
auf `f67c9e5` plus diesem Testnachtrag ist erfolgreich: 1.192 Frontendtests,
1.096 Node-/Browserprüfungen, null Fehler, vier explizite Node-Skips. Build,
Typprüfung, Go und statische Gates bestanden; 14 externe Infrastruktur-Gates
blieben übersprungen. Die offenen Broadcast-Arbeitskopieänderungen waren nicht
Teil dieses festen Prüfstands. Noch kein öffentlicher Hub-Rollout und keine
Zweistundenabnahme.

CI `34374881656` für den bereits gepushten Stand `f67c9e5` ist inzwischen in
allen acht Jobs erfolgreich. Diese CI enthält den neuen Testnachtrag noch nicht.
Die damals vor dem obigen Rollout erfolgte rein lesende Prüfung meldete öffentlich
`admissionEnabled: false`, lokal `disabled disabled`. Der neue öffentliche
Integrationspfad antwortet noch mit HTML statt dem Statusvertrag; die neue
Übersicht ist damit nicht als öffentlich ausgerollt nachgewiesen. Keine
automatische Trustfreigabe, kein Deployment und keine Änderung im Ananta-Repo.

## Vorheriger Nachtrag: getrennte Quellenzeit

Die anschließende CI `34370659493` für `edc117f` ist vollständig erfolgreich:
alle acht Jobs einschließlich des authentisierten TURN-Dialogs und des
Live-Keycloak-/TURN-Gates. Das ist weiterhin kein öffentliches Hub-Deployment.
Die neue [Integrationsübersicht](machine-integration-overview.md) ergänzt jetzt
die Analyse um implementierte Funktionen, globale Betreibergrenzen und
notwendige Quellenfreigaben. Der isolierte Gesamtcheck dieses Nachtrags bestand:
1.192 Frontendtests, 1.091 Node-/Browserprüfungen, null Fehler und vier Node-Skips;
14 externe Gates blieben ausdrücklich übersprungen. Beide kombinierten Dialoge
und die neue UI bestanden in Chromium und Firefox. Das fehlende produktive
Hub-/Projektprofil bleibt eine eigene Voraussetzung; noch kein Deployment.

Der falsch ausgelöste lokale Sprach-/Avatar-Stillstand ist jetzt mit einem
gezielten Vorher-/Nachher-Test reproduziert und behoben: Eine Wanduhrkorrektur
innerhalb einer weiterhin gültigen Lease darf keine bereits verstrichene lokale
Fortschritts- oder Heartbeat-Frist vortäuschen. Epochgebundene Berechtigungen und
Aktivierungsenden bleiben unverändert; lokale Intervalle verwenden eine getrennte
monotone Uhr. Details: [Zeitbasen und Nachweis](machine-source-clock-domains.md).

Die isolierte Gesamtprüfung (`0996030` plus Quellenzeitkorrektur) bestand mit
1.188 Frontendtests und 1.086 Node-/Browserfällen, null Fehlern und vier Node-Skips
(478,974 s). Beide gemeinsamen Ananta-Dialoge, die unabhängigen Sprachausgaben,
die Quellenzeit- und die neuen Uhrkorrekturtests bestanden. 14 externe Gates
blieben ausdrücklich übersprungen. Das ersetzt weder die Zweistundenabnahme noch
die produktive Hub-/Projektfreigabe. Öffentlich wurde weiterhin
`admissionEnabled: false` beobachtet; dieses Ergebnis ist kein Deployment.

## Vorheriger Nachtrag: priorisierte Sitzungsintegration

Die sechs angefragten Grundfunktionen sind implementiert; neu gehärtet ist das
[durchgängig begrenzte Warten auf Beitritt und Erneuerung](machine-page-join-lifecycle.md).
Ein hängender Gerätenachweis kann den Controller nicht mehr unbegrenzt festhalten.
Leave, Timeout und Ersatzbeitritt verhindern Folgeoperationen aus alten Ergebnissen.
Hub-Trust, Publisherfreigaben und die bestehenden Lease-Grenzen bleiben unverändert.

Die isolierte Gesamtprüfung auf `e50f246` plus diesem Nachtrag bestand
1.170 Frontendtests, Build, Typprüfung, Go und statische Gates sowie 1.082
Node-/Browserfälle. Zwei Fälle scheiterten, vier wurden ausdrücklich übersprungen
(Node: 506,036 s). Die gemeinsamen Chromium-/Firefox-Dialoge bestanden jeweils
mit 16.000 PCM-Samples, Chat, bewegtem Screen, drei Renewals und Rechteentzug.
Der neue echte Chromium-Test für einen hängenden Renewal-Gerätenachweis bestand
in 12,704 s mit beendeter Membership und geschlossenen Verbindungen.

Offen bleiben die separaten Chromium-Quellenzeit- und Sprachausgabetests.
Beim Sprachabbruch meldete der Trace `progress-expired` nach 499 ms monotoner
Zeit gegenüber 2.578 ms Wanduhrzeit; die Sitzung war noch gültig. Die Ursache ist
nicht abschließend belegt. Die externe Infrastrukturstufe wurde wegen der Fehler
nicht erreicht; keine Wiederholung wurde als Ursachenfix ausgegeben.
Die grüne CI `34365113608` betrifft nur den vorherigen Commit `e50f246`, nicht
diesen Nachtrag. Kein Deployment und keine öffentliche Hub-Aktivierung wurden
durchgeführt. Dafür fehlt weiterhin das ausdrücklich freigegebene Hub-/Projektprofil.

## Frühere Prüfläufe

Die frühere isolierte Gesamtprüfung auf Basis `dfa9829` mit nativer Szenenbasis
und der Freigabe-Ablaufkorrektur endete mit **Exit 1**: 1.142 Frontendtests und
1.039 Node-/Browsertests bestanden, ein Fehler und zwei Node-Skips
(Node-Lauf: 455,910 Sekunden). Build, Typprüfung, Go-Unit/Vet und statische Gates
bestanden. Die externe Infrastrukturstufe wurde wegen des Fehlers nicht erreicht;
der optionale Container-Image-Scan blieb ausdrücklich übersprungen.

Der gemeinsame Audioempfang-/Chat-/Screen-/Drei-Renewal-Dialog bestand in
Chromium und Firefox, jeweils mit 16.000 entschlüsselten PCM-Samples und aktivem
SFrame ohne Transformfehler. Separat endete die synthetische Sprachausgabe im
Chromium-Fall vorzeitig: 56.889 Samples angenommen, 52.479 abgespielt,
Sitzung weiterhin verbunden. Die Ursache dieses Abbruchs ist nicht belegt.
Ein bestandener Dialog ersetzt weder diesen Fehler noch die Langzeitabnahme.
Die später übernommenen TURN-Testcommits und die neue Prozessbeobachtung wurden
separat mit 50 bestandenen Tests geprüft; sie waren nicht Teil dieses festen
Gesamtprüfstands. Keine Produktionsaktivierung oder kausale Medienfehlerbehebung
wird daraus abgeleitet.

Der zusammengeführte Stand `fd77b6c` einschließlich des neutraleren Ablauftexts
bestand anschließend den isolierten Produktionsbuild in 15,455 Sekunden
(1,59 MB initial; unveränderte Budgetwarnung) und die Todo-Validierung.
Das ist kein nachträglich bestandener Gesamtcheck und kein Deployment.

Die erneute priorisierte Kurzabnahme vom 9. September bestand **alle sechs
Browserfälle in 59,352 Sekunden**. Geprüft wurde `47f9103` mit dem unveränderten
isolierten Frontend von `fd77b6c`: Chromium und Firefox empfingen jeweils
16.000 echte PCM-Samples im gemeinsamen Chat-/Screen-/Drei-Renewal-Dialog
einschließlich Freigabeentzug. Avatarwechsel und unabhängige Sprachausgabe
bestanden ebenfalls; letztere spielte jeweils 66.150 Samples ab, ohne
menschlichen Capture oder Transformfehler. Die frühere Intermittenz wurde
nicht reproduziert und ist damit nicht als kausal behoben einzustufen.

Die zwischenzeitlich auf `origin/main` eingegangenen Commits `ebd78be` und
`76628ab` dokumentieren zusätzlich einen **separaten** bestandenen Linux-
Gesamtcheck (1.142 Frontendtests, 1.066 bestandene Nodefälle, vier Node-Skips).
Diese externe Arbeitskopie und deren Prüfergebnis sind nicht mit dem hiesigen
Kurzlauf oder der öffentlichen Installation gleichzusetzen. Ein aktueller
öffentlicher GET bestätigt weiterhin `admissionEnabled: false`. Die laufend
ausgelieferte lokale Browserdatei wurde bei dieser Prüfung nicht verändert.

Im anschließenden isolierten Gesamtcheck der Broadcast-Szenenintegration
(`1a34b29`) bestanden 1.151 Frontendtests und 1.082 Node-/Browserfälle; ein
Firefox-Timingfall scheiterte, vier Nodefälle wurden ausdrücklich übersprungen.
Beide gemeinsamen Ananta-Dialoge und die unabhängige Sprachausgabe bestanden.
Die Avatarquelle meldete jedoch `controller-expired` nach 913 ms monotoner Zeit
gegenüber 3.076 ms Wanduhrzeit, bei noch gültiger Sitzung. Ursache und Abhilfe
bleiben offen; weder Uhren noch Watchdog-Fristen wurden geändert. Die externe
Infrastrukturstufe wurde nicht erreicht. Details und Revisionstrennung stehen
in der [Szenen-Verifikation](native-source-scene-control.md#korrigierte-gesamtprüfung).

| Bereich | Vorhandener Meet-Pfad | Grenze |
| --- | --- | --- |
| Audioempfang | Eigener autorisierter Browser-Endpunkt, begrenztes PCM16/16-kHz-Mono, Quellen-/Epoch-Bindung und Stop bei Entzug | ASR und Modellauswahl gehören zum Worker; keine Audio-HTTP-Route im Signaling |
| Chat | Freigegebene neue DataChannel-Ereignisse, Cursor/ACK, begrenzte korrelierte Antworten und KI-Kennzeichnung | Kein pauschaler Zugriff auf Historie; Lesen und Senden sind getrennte Rechte |
| Eigener Bildschirm | Hub-sessiongebundene synthetische Quelle, begrenzte Frames, unabhängig von Avatar/Sprache; eigener optionaler Tonport | Kein menschlicher Desktop, Browserprofil oder automatischer Capture-Dialog |
| Sitzungen | Frische signierte Grants, P-256-Renewal, Generationen, feste Gesamtdauer und exakte alte Session-Retirement | Reconnect-Steuerung gehört zum Hub/Worker; alte Quellenfreigaben werden nicht übernommen |
| Angular | Analyse-Panel für Betreiberstatus, KI-Teilnehmer, eigene Quellen, Ablauf, Bestätigung und Widerruf | Eine Capability oder ein Remote-Track beweist keine aktive Modellverarbeitung |

Die lokale Chromium-/Firefox-Dialogprüfung verbindet Audioempfang, Chat, bewegte
Screen-Frames, drei Lease-Wechsel und Freigabeentzug unter required-SFrame.
Private verpackte Hub-/Worker-Prüfungen existieren zusätzlich. Sie sind keine
öffentliche Projektfreigabe und ersetzen nicht die verbleibende gemeinsame
Langzeit-/Reconnect-Abnahme. Der neue
[Page-Lifecycle](machine-page-join-lifecycle.md) verhindert insbesondere einen
offenen Beitritt nach Welcome-Timeout und das Beenden einer neuen Sitzung durch
eine verspätete alte Operation.
Der [Bildschirm-Endpoint](machine-screen-endpoint-cleanup.md) versucht außerdem
Bild- und Tonstopps unabhängig, damit ein einzelner Cleanupfehler den jeweils
anderen Stop nicht überspringt. Nach fehlgeschlagenem Cleanup startet er keine
Ersatzquelle.

Die inzwischen integrierte optionale [Quellen-Zeitüberwachung](machine-live-media-clock.md)
beobachtet Sprache, Avatar und agenteneigenen Bildschirm getrennt. Sie stoppt
veraltete oder zeitlich unplausible eigene Quellen, erweitert aber keine
Berechtigung oder Sitzung. Der Worker muss das Profil ausdrücklich aushandeln;
es ist weder ein Nachweis von Lippen-Synchronität noch von Empfang beim Publikum.

Die gebündelte Prüfung mit `28eff78` und dem neuen Quellenfreigabe-Workflow
bestand 1.012 Frontendtests und 975 Nodeprüfungen; drei Browserfälle scheiterten,
zwei Prüfungen wurden ausdrücklich übersprungen. Der gemeinsame Consent-/Chat-/
Audioempfang-/Screen-Dialog mit drei Erneuerungen bestand in Chromium und Firefox.
Offen sind die Chromium-Beobachtung unmittelbar vor Lease-Ablauf, eine fehlende
Avatar-Zeitzeile nach dem Screenstop unter Firefox sowie ein vorzeitig beendeter
separater Chromium-Sprachausgang. Die Ursache ist noch nicht belegt; dieser
Stand ist keine abgeschlossene Integrationsabnahme. Die externe
Infrastrukturstufe wurde nach den Fehlern nicht mehr ausgeführt.

Die anschließende gezielte Nachprüfung bestand alle sieben Fälle der drei
betroffenen Browserdateien in 64,989 Sekunden. Zwei konkrete Testschwachstellen
sind korrigiert: Die synthetische Sprachzufuhr wartet nach dem Öffnen nicht mehr
auf die Empfänger-UI; der Lease-Test liest einen geschlossenen Statuswert über
den bereits vorhandenen Host-Poller. Die ursprünglichen Laufzeitgrenzen bleiben
unverändert. Die fehlende Avatar-Zeitzeile trat nicht erneut auf und ist nicht
als kausal behoben einzustufen. Eine begrenzte Fehlerprojektion erhält künftig
Quellzustände und Fortschrittszähler, aber keine Inhalte oder rohen Fehlertexte.
Der frühere Gesamtcheck wird durch diesen Nachlauf nicht nachträglich grün;
die nächste Gesamtregression folgt gebündelt mit der weiteren Implementierung.

Der anschließende Stand `0a63b05` bestand den isolierten Gesamtcheck mit
1.078 Frontend- und 989 Node-/Browsertests, null Fehlern und zwei Node-Skips.
Die 14 externen Infrastrukturprüfungen blieben ausdrücklich übersprungen.
Neue interne Fehlerkategorien grenzen die sporadischen Quellenabbrüche ein;
eine kausale Behebung dieser Intermittenz ist damit weiterhin nicht behauptet.

Die aktuelle Lifecycle-Ergänzung sperrt einen Client nach unbestätigtem
Ressourcenstopp für weitere Beitritte. Ein neuer Grant oder ein späterer leerer
Cleanup-Aufruf hebt diese Sperre nicht auf. Die Maschinenansicht erklärt den
erforderlichen frischen Browserkontext; alle unabhängigen Stopps werden weiterhin
versucht. 26 fokussierte Lifecycle-/Renewalprüfungen bestehen. Der neue Gesamtcheck
bestand 1.085 Frontend- und 986 Nodeprüfungen, scheiterte aber an drei separaten
Avatar-/Quellenzeitfällen (zwei Node-Skips). Die kombinierten Dialoge bestanden
in beiden Browsern; die externe Infrastrukturstufe wurde nicht erreicht.
Im gezielten Nachlauf bestehen sechs von sieben Fällen, der Controller-Frische-
Abbruch bleibt reproduzierbar und ursächlich offen. Das ist keine vollständige
Integrationsabnahme und noch kein Deployment des Nachtrags.

## Im Browser

Die Freigabeanzeige behandelt nun auch verspätete Bestätigungen: Ist eine
angeforderte Empfangsfreigabe inzwischen abgelaufen, bleibt sie `expired`, selbst
wenn die passende Serverantwort vor dem verzögerten Timer eintrifft. Die UI
wiederholt oder verlängert die Anfrage nicht. Abgelaufene Quellen zählen nicht
mehr als aktiv freigegeben. Ein reiner Widerruf benötigt dagegen keine noch
gültige Grant-Laufzeit. Diese Anzeigeprüfung ersetzt keine serverseitige Policy.
Die vier ergänzten Tests prüfen Ablauf vor Timerzustellung, fehlende Bestätigung,
Quellenzähler und unverändert bestätigbaren Widerruf.

1. Dem Raum beitreten und **Analyse → Ananta · Freigaben meiner Quellen** öffnen.
2. Nach dem separat autorisierten Hub-Beitritt den KI-Teilnehmer auswählen.
3. Eigene bereits laufende Audio-/Bildquellen beziehungsweise neue Chatbeiträge
   auswählen und ausdrücklich freigeben. Die Serverbestätigung abwarten.
4. Bildschirm und Sprache des Agenten erscheinen als getrennte Publikationen
   in der bestehenden Live-Ansicht; Antworten sind im Chat als KI markiert.
5. Eigene Freigaben lassen sich im Analyse-Panel widerrufen. Verlängert der Hub
   seine Sitzung, verlängert das diese Quellenfreigaben nicht automatisch.

Das Öffnen dieser Ansicht startet keine Aufnahme und keinen Worker.

## Noch notwendig für öffentliche Teilnahme

- Ein vom Betreiber ausgewähltes Hub-Trustprofil: exakter Issuer, ausschließlich
  öffentlicher Ed25519-Schlüssel, Subject, Tenant, Projekt und Capability-Obergrenze.
- Ein in Ananta separat freigegebener Projektauftrag sowie ein geeigneter Worker.
- Zusammenpassende freigegebene Revisionen, Preflight und kontrollierter Rollout
  über die vorhandene [Maschinen-Deployment-Konfiguration](machine-production-compose.md).
- Aktuelle Membership und die jeweiligen Publisherfreigaben im Raum.

Das Profil wird weder aus einem gemeinsamen Login noch aus vorhandenen
SSH-Schlüsseln abgeleitet. Keine privaten Hub-Schlüssel nach Meet kopieren.
Das Ananta-Repository bleibt bei Meet-seitigen Änderungen unverändert.

Die alten `chatEvents`-/`audioSubscription`-/`screenPublication`-Booleans von
`/api/machine/capabilities` gehören zum unveränderten v1-MP4-Vertrag. Sie sind
keine vollständige Auflistung der neueren Browserports; dafür gibt es den
separaten lokalen [Client-Probe](machine-client-probe.md). Weder Probe noch
`admissionEnabled: true` beweisen einen verbundenen Hub oder laufenden Worker.
