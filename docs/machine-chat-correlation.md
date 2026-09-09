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
dürfen identischen Text enthalten. Ein explizites Neuöffnen beginnt wie bisher
ohne Historie; alte Antwortkorrelationen werden nicht übernommen. Das ist kein
persistenter Schutz über mehrere Sitzungen hinweg.

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
| Reihenfolge und Grenzen | `MachineChatQueue` liefert lokale Eingangsreihenfolge über Cursor, maximal acht Ereignisse je Poll, 32 wartende Ereignisse/128 KiB und 512 IDs. ACK kann keine undelieferten Ereignisse konsumieren. Reopen liefert keine alte Historie nach. |
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
