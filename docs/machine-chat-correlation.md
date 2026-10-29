# Ananta-Chat: Herkunft und Subscription-Lifecycle

Der Maschinen-Chat liest nur neue, vom jeweiligen Publisher freigegebene
Human-Ereignisse über den bestehenden DataChannel. Die technische Senderbindung
kommt aus der aktuellen Verbindung, nicht aus einem behaupteten Nachrichtenfeld.
Sie ist keine zusätzliche Bestätigung einer menschlichen Identität.

Antworten korrelieren im bestehenden Vertrag ausschließlich über `message_id`.
Deshalb bindet die endpoint-lokale Queue jede angenommene ID an genau einen
Sender innerhalb ihrer unveränderlichen Raum-/Task-/Lease-/Policy-Scope.
Verwendet ein anderer zugelassener Sender dieselbe ID, beendet sich der Chatport
mit `meet_chat_message_id_conflict`, entfernt Listener, Timer, Queue und wartende
Antwortzuordnungen. Es gibt keine mehrdeutige Lieferung oder automatische Antwort.
Das ist eine bewusste Verfügbarkeitsgrenze: Ein Konflikt beendet diese
Subscription, nicht die Room-Membership oder andere Medienpublikationen.

Die Zuordnung bleibt nach ACK und Alterspruning erhalten, damit eine bereits
ausgelieferte ID nicht einem anderen Sender zugeordnet werden kann. Sie nutzt
das vorhandene Limit von 512 Dedup-Einträgen; darin liegen nur IDs und Sender,
keine Chattexte. Gleiche Sender-Retries bleiben dedupliziert, unabhängige IDs
dürfen identischen Text enthalten. Ein explizites Schließen und Neuöffnen beginnt wie
bisher ohne Historie; alte Antwortkorrelationen werden nicht übernommen. Das ist kein
persistenter Schutz über mehrere Sitzungen hinweg.

## Fortsetzung über einen Fence derselben Konversation

Ein Lease-Renewal (neue Generation), ein Membership- oder Policy-Revisionswechsel
fenced die Queue weiterhin mit `meet_chat_authority_changed`; auf dem alten
Fence wird nichts mehr geliefert oder beantwortet. Der Endpoint leert dabei aber
nicht mehr, sondern suspendiert höchstens 30 Sekunden (Frischegrenze): Er
behält nur selbst angenommene, noch nicht quittierte Human-Eingaben sowie die
`delivered`-/`replied`-Zuordnung. Ein Standby-Listener nimmt im Fenster bis zum
Reopen neue Eingaben mit denselben Regeln an (freigegebene Quelle, kein
`replyTo`, nicht beantwortet, höchstens 32, gleiche ID-Senderbindung; Überlauf
oder Konflikt beenden und leeren). `open()` übernimmt diesen Bestand nur, wenn
Origin, Tenant, Projekt, Task, Hub-Session, Runtime, Lease-ID, Raum und eigene
Peer-ID gleich sind und die Generation nicht sinkt, und lässt jede Eingabe
erneut durch Quellen-, Alters- und Queueprüfung unter der aktuellen Scope zu.
Beantwortete IDs werden nie erneut geliefert oder beantwortet; quittierte, noch
unbeantwortete bleiben genau einmal beantwortbar. Widerruf während der
Suspendierung leert binnen 250 ms, ein explizites `close()` sofort. Das ist
kein Verlauf: vor dem ersten `open()` oder nach `close()` Gesehenes wird nie
nachgeliefert.

Das Antwortfenster zählt ab der (letzten) Zustellung durch `poll()`, nicht ab dem
`sentAt` des Senders: eine gelieferte Eingabe bleibt 120 Sekunden beantwortbar.
`sentAt` begrenzt nur die Annahme (30 Sekunden Frische). Eine über einen Fence
getragene Eingabe kann bei der Zustellung schon ~20 Sekunden alt sein; eine
Modellrunde mit Werkzeugen danach darf sie trotzdem genau einmal beantworten.

Listener und Watchdog gehören außerdem zur konkreten Queueinstanz. Nach
Close/Renew/Open können verspätete alte Callbacks weder Ereignisse mit der neuen
Leasegeneration etikettieren noch den Nachfolger schließen. Ein Entzug bereits
während der Subscription-Registrierung räumt auch den gerade zurückgegebenen
Listener auf und installiert keinen Timer.

## Verifikation und Grenzen

Die Meet-seitigen Kriterien von MDS-04 verteilen sich auf diese vorhandenen Ports:

| Kriterium | Implementierung und Prüfung |
|---|---|
| Gebundene, flüchtige Ereignisse | `MachinePeerChatIngress` bindet den aktuellen Verbindungssender und prüft Raum/Epoch; `MachineChatSessionService` liefert nur aktuelle Hub-/Meet-Rechte. |
| Reihenfolge und Grenzen | `MachineChatQueue` liefert lokale Eingangsreihenfolge über Cursor, maximal acht Ereignisse je Poll, 32 wartende Ereignisse/128 KiB und 512 IDs. ACK kann keine undelieferten Ereignisse konsumieren. Reopen liefert keine Historie nach; nur unquittierte Eingaben derselben Konversation überleben einen Fence. |
| Einmalige Antworten | `MachineChatEndpoint` prüft separat aktuelles Senderecht und Quellenfreigabe, reserviert die gelieferte Eingangs-ID vor genau einem Sendeversuch. `PeerMeshService` erhält `replyTo` und die aus Membership bestimmte Maschinenkennzeichnung. |
| Entzug und Isolation | Scopewechsel, Ablauf und Widerruf schließen die Subscription; Leave/Destroy schließen den Endpoint. Fremde Räume, erfundene Senderfelder, Oversize, Raten und alte Callbacks werden negativ geprüft. |

`machine-chat.test.js`, `machine-peer-chat.spec.ts` und die Endpoint-/Service-
Tests prüfen diese Grenzen deterministisch. Die echten Chromium-/Firefox-
Dialog- und Nur-Lese-Chat-Gates prüfen DataChannel-Lieferung, Antworttransport,
Neueröffnung nach Renewal und Entzug zusammen mit laufenden Medien. Ein
Transport-ACK beweist nur dessen definierten Konsum, nicht eine LLM-Verarbeitung.

Vor der Korrektur scheiterten vier Queue-Regressionen für gleiche IDs aus
verschiedenen Quellen (wartend, ausgeliefert, quittiert, gealtert). Ein weiterer
Endpoint-Test reproduzierte ein altes Ereignis mit neu etikettierter Generation.
Nach der Korrektur bestehen 51 gezielte Node-Queue-/Policy- und 24 Angular-
Endpoint-/Service-/DataChannel-Tests einschließlich des 512-ID-Limits und
synchronem Entzug.

Der isolierte `npm run check` auf `8a5fdd2` plus diesem Chat-Batch endete am
9. September 2026 mit Exit 1: 879 Frontendtests und 898 Node-Prüfungen bestanden,
eine Node-Prüfung scheiterte, zwei wurden sichtbar übersprungen (Node 456,060 s).
Build, Typen, Go-Unit/Vet und statische Gates bestanden; der externe
Infrastruktur-Nachlauf wurde wegen des Fehlers nicht mehr erreicht.

Die tatsächlichen Dialogfälle bestanden in Chromium/Firefox (15,271/16,730 s)
mit je 16.000 PCM-Samples, aktivem SFrame ohne Transformfehler, Chatantwort,
bewegtem Bildschirm, drei Renewals und Entzug. Nur-Lese-Chat bestand ebenfalls
(4,925/7,283 s) ohne unerlaubten Sendeversuch oder alte Historie nach Renewal.

Der Fehler betraf den bestehenden Chromium-Avatar-Test nach dem dritten
Quellenwechsel zu `hold_last`: `avatar_not_moving`. Die gezielte Nachprüfung
des exakt gleichen Builds bestand in Chromium/Firefox (8,181/11,312 s) mit
24/23 Held-Frame-Beobachtungen und unabhängigem Stop. Es gibt bislang keine
gesicherte Ursache und keinen behaupteten Avatar-Fix. Der rote Gesamtlauf wird
nicht durch diesen Einzel-Erfolg als grün ausgegeben. Weitere kombinierte
Abnahme und CI des exakten Chat-Commits bleiben erforderlich; kein Deployment.

Wireformat, Hub-Trust, menschlicher Capture-Klick und getrennte Lese-/Senderechte
bleiben unverändert. Diese Korrektur aktiviert keine Produktion und implementiert
keine Modell-, Dialog-, Aufzeichnungs- oder Wiederverbindungsentscheidung.


`chat.poll(afterCursor?)` bietet additive, begrenzte Pagination ohne ACK. Der Cursor darf nur zwischen dem bestaetigten Cursor und dem hoechsten bereits gelieferten Cursor liegen. Jede Seite hat weiterhin maximal acht Ereignisse; ohne Parameter bleibt das bisherige Verhalten erhalten. Der Controller setzt den Cursor nach Reopen auf null und bindet die Aufnahme weiterhin an aktuelle Autoritaet. Die 30-s-Frische, Queue-Grenzen, Quellenpruefung und Reply-Rechte bleiben unveraendert. Diese API allein behebt keine synchrone Companion-Poll-Pause; die Ananta-Komposition muss sie waehrend der Ausfuehrung bedienen. Queue-Domain und Endpoint bleiben getrennt (SRP/DIP); kein vorzeitiges ACK und keine Persistenz von Chat-Inhalten im Server.


`chat.redeliver(messageIds)` bestaetigt maximal 32 eindeutige, bereits durch diesen
Endpoint ausgelieferte und noch lebende unbeantwortete IDs erneut. Die Operation
prueft aktuelle Read-/Lease-/Scope-Autoritaet und Quellenfreigabe, danach nochmals
den exakten Queue-Owner und unveraenderte Registrierungen vor atomarer Aktualisierung.
Unbekannte, beantwortete oder nach 120 s abgelaufene Registrierungen bleiben gesperrt.
Keine Inhalte, neue Eingaben, ACKs, Senderechte oder Lease-Erweiterung werden erzeugt.
Die 30-s-Erstaufnahme bleibt bestehen, das Antwortfenster endet 120 s nach letzter
gueltiger Zustellung. Eine fortgesetzte Bestaetigung endet bei Hub-Widerruf oder
Lease-Ablauf; `reply` prueft aktuelle Senderechte weiterhin separat.

47 Endpointtests pruefen Frische, atomare Listenvalidierung, Widerruf, Quellenentzug,
Ablauf, fremde Konversation, unveraenderte Senderechte und synchrone Source-Port-
Seiteneffekte vor Mutation. Der Ananta-Pump nutzt die Operation hoechstens alle
10 s fuer offene unbeantwortete Eingaben. Der echte TypeScript-Endpoint in Node
und Anantas echter Python-run()-Loop bestehen zusammen fuer 2/3/32 Eingaben mit
je 50 s synthetischer Modellrunde; insgesamt 364 Companion-Regressionstests.
Browser/Hub/Modell-Ports sind dabei synthetisch, keine Live- oder Release-Evidence.
Gemeinsame echte Browser-/Quellenwiderruf-Abnahme, voller Blockcheck und gepaartes
Deployment bleiben offen. Aeltere Clients ohne redeliver beenden den aktualisierten
Companion-Pfad bei offenen Eingaben; kein stiller unautorisierter Ersatz.


Die aktuelle Receive-Policy folgt dem absichtlichen Commit `add3f5f`:
verifizierte Hub-Capabilities autorisieren Chat-/Medienempfang; separate alte
Publisher-Consent-Eintraege sind keine zusaetzliche technische Voraussetzung.
Session-Lease und aktuelle Room-Membership bleiben verpflichtend. Ein Hub-
Leserecht erteilt kein Senderecht; ein Quellenport nimmt nur aktuelle Mitglieder
und deren bereits zugestellte Identitaeten an. Aenderung oder Ablauf alter
Consent-Eintraege kann keine Hub-Capability erteilen oder widerrufen. Die alten
Session/Gate-/Browser-Erwartungen wurden auf diesen bestehenden Vertrag
abgeglichen; Produktionspolicy wurde dafuer nicht geaendert.

Die aktuelle Production-Angular-Kopie besteht vier echte HTTPS/WebRTC-
Browserfaelle: Chromium/Chromium und Firefox/Chromium fuer Live-Chat/PCM/Screen,
Chromium/Chromium und Firefox/Firefox fuer Nur-Lese-Chat. Neun wartende Eingaben
werden 8+1 ohne ACK paginiert, durch drei echte Renewals erneut bestaetigt und
je einmal beantwortet. Bereits beantwortete IDs koennen nicht erneut bestaetigt
werden; Nur-Lese-Receipts erteilen kein Senderecht. Echte private Server-
Mitgliedschaftsverluste sperren Wiedereroeffnung/Redelivery und stoppen aktive
Audioannahme. Die Fixtures verwenden ausschliesslich kryptografisch verifizierte
synthetische Identitaeten, Quellen und eigenen lokalen Server, keine Produktion.
62 Session/Endpoint/ReceiveGate- und 28 Queue-Tests, App-Typen und Production-
Angular-Build bestehen. Dies ist Client-/Server-Abnahme, kein aktueller Python-
Worker-/Browser-Gesamtloop und keine GPU-/Registry-Release-Evidence. Legacy-
Consent-UI-Wording/Deprecation, voller Blockcheck und gepaartes Deployment bleiben
als getrennte Arbeit offen; kein Push/Deploy.

Ein zusaetzlicher Nachlauf der zwei Nur-Lese-Faelle prueft den Publisher-Verlust
getrennt von Maschinen-Mitgliedschaft und Hub-Lease: Der menschliche Sender
verlaesst den Raum, die Maschine bleibt joined mit gueltiger Lease, und redelivery
der alten ID wird verweigert. Chromium und Firefox bestehen (2 wiederholte
Matrixfaelle, 9.086 s, keine weitere eigenstaendige Vierer-Matrix).


Die lokale Receive-Policy-Migration ist inzwischen weitergefuehrt: Die menschliche
Quellenuebersicht ist passiv und zeigt Hub-Rechte fuer Audio, Bild, Chatlesen und
Antworten getrennt. Unwirksame Legacy-Consent-Schalter sind aus der aktiven UI
entfernt. Stoppen erfolgt ueber die bestehenden Mediensteuerungen oder Leave.
Auch PCM- und Bildexport benutzen jetzt die schon geltende Hub-Capability-Policy
statt einer zusaetzlichen alten Consent-Anforderung; aktuelle Lease, Membership,
Quelle/Track, Publikationsepoche und begrenzte Export-Lifetimes bleiben Pflicht.
139 Frontend- und 14 Node-Tests bestehen. 22 unterschiedliche echte Browserfaelle
bestehen ueber Matrix und gezielten Renewal-Nachlauf; der anfaengliche Lauf hatte
20 Erfolge und zwei falsche Renewal-Testannahmen und wird nicht als komplett
gruener Gesamtlauf dargestellt. Faehigkeitswechsel ist weiterhin kein legaler
Renewal; der korrigierte Test prueft diese Ablehnung und anschliessendes Leave.

Legacy-Transport/Service und das alte Integration-v1-Feld
`publisherConsentRequired` bleiben als Kompatibilitaetsschuld erhalten; die aktive
UI interpretiert es nicht als aktuelle Freigabeanforderung. Private Audio-/Visual-
Testbruecken stoppen reale synthetische Quellen fuer Entzug. Selektiver Multi-
Worker-Widerruf muss vom owning Hub kommen: Der obsolete negative Consent-
Brueckenbefehl endet bis zu dessen Fixture-Anschluss begrenzt mit
`test_hub_receive_revocation_required`. Er stellt keinen erfolgreichen Entzug dar.
Voller Clientblock, aktuelle gepinnte Worker-/Browser-Gesamtkomposition, Live-
Provider/GPU und Registry-Release-/Deployment-Abnahme bleiben offen. Aktueller
Nachweis: `artifacts/test-gates/meet-receive-policy-migration.v1.json`.


Der aktuelle gekoppelte Hub-/Worker-Test hat eine weitere Legacy-Luecke
geschlossen: Der Signaling-Backchannel lieferte nur alte Consent-Eintraege
(Revision 0, leere Quellenliste), waehrend der Browser bereits Hub-Receive-Rechte
benutzte. Eine kleine reine Serverprojektion stellt jetzt aktuelle
Hub-Capabilities, authentifizierte menschliche Membership/Publikationen und
Lease-Deadline im kompatiblen Quellenformat dar. Sie erteilt keine Senderechte
oder neue Lease. Der Lease-Store liefert die aktuelle geschlossene Lease an
seinen registrierten Port und prueft Liveness davor und danach.

39 Node- und 18 Hub-Regressionsfaelle bestehen. Das frisch gebaute eigenstaendige
Workerimage besteht die Quellcode-/Dependency-Pruefung. Zwei private reale
Worker mit gepinntem Playwright 1.58.0, realer Hub-SQL/TaskQueue und aktuellem
Client bestehen zwei korrelierte Antworten, gleichzeitige synthetische Sprache,
unterschiedliche Avatare, unabhaengigen Bildwiderruf und gezielten Hub-Stopp
einer Teilnahme bei weiterlaufender zweiter Teilnahme (67.63 s nach Fix). Der
vorherige fehlgeschlagene Lauf wird im Bericht erhalten. Der vorhandene Hub-
Task-Cancel ist der selektive Widerruf; ein neuer Legacy-Consent-Befehl ist
dafuer nicht noetig. Dies ist eine Dialog-Runtime-Abnahme mit synthetischer
Inferenz und keine Pruefung des Legacy-Companion-Gesamtloops unter langem
Modell-/Medienrueckstau. Live-Provider/GPU, Deployment und produktive Registry-
Freigabe bleiben offen. Bericht: `artifacts/test-gates/meet-hub-receive-projection.v1.json`.


Der anschliessende volle Clientblock `npm run check` ist noch nicht bestanden:
187 Frontenddateien/1694 Tests bestehen, vier Dateien/19 Tests schlagen fehl
(SFrame-Key-ACK/Overlay-Testdoubles, Avatar-Setup/Reason/Clock), plus eine
unhandled Rejection. Die spaeteren Build-/Leakage-/Go-/Node-/Infrastruktur-
Stufen wurden nicht erreicht. Diese konkreten Regressionen sind im aktiven
Track festgehalten und muessen untersucht und korrigiert werden; der erfolgreiche
gekoppelte Teilnachweis wird nicht als gruener Gesamtblock ausgegeben.
