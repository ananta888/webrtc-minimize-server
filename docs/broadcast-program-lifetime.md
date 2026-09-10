# Absolute Broadcast-Laufzeit

`BROADCAST_MAX_PROGRAM_RUNTIME_MS` begrenzt die Laufzeit einer aktivierten
Sendung. Der Standard beträgt vier Stunden (`14400000`), der zulässige
Operatorbereich 60 Sekunden bis 24 Stunden. Ein ausdrücklich leerer oder
ungültiger Wert verhindert den Konfigurationsstart. Compose übergibt den Wert
an den Node-Server; er wird nicht aus Browser- oder Agentennachrichten gelesen.
Die Einstellung ist ein Startparameter des Servers, keine nachträgliche
Verlängerungsberechtigung für eine bereits laufende Sendung.

## Beginn und Ende

Ein Draft verbraucht noch keine aktive Laufzeit. Das Budget beginnt beim
erfolgreichen Aktivieren; eine abgelehnte native Zulassung lässt den Draft
unverändert. Intern bereits aktiv registrierte Programme erhalten ihr Budget
bei der Registrierung. Der Server persistiert oder rekonstruiert damit keine
frühere Sendung: Programme und Budgets bleiben instanzlokal und flüchtig.

Die einmalige absolute Deadline bleibt erhalten bei Lease-Erneuerung,
Ausgabedegradation/-wiederherstellung, Quellenwechsel und Packager-Handoff.
Eine Standby-Auswahl erstellt kein neues Budget. Stop ist terminal; ein neuer
bewusster Start benötigt weiterhin ein neues Programm und die normale Zulassung.
Ungültige oder rückwärts laufende beobachtete Zeit beendet ein aktives Budget
ebenfalls terminal; eine spätere Uhrkorrektur belebt es nicht wieder.

| Pfad | Durchgesetzte Grenze |
| --- | --- |
| Native Prepare und Renew | Die bestehende Wire-Lease endet spätestens an der Programmdeadline; Scope stammt aus verifizierter Packager-Capability sowie aktueller Programm-ID und Epoche. |
| Handoff und Quellenautorität | Nachfolger, Handoff-Fenster und Writer-Kontext übernehmen die ursprüngliche Grenze, keine neue Laufzeit. |
| OIDC-/anonyme Wiedergabe und WHIP-Grants | Challenge und ausgestellter Grant werden auf das Restbudget begrenzt; nach asynchroner Ausgabe wird der aktuelle Zustand erneut geprüft. |
| Runtime-Wartung | Alle 500 ms werden abgelaufene Programme gestoppt und ihre Epochen widerrufen; autorisierende Writer-/Quellenpfade prüfen zusätzlich synchron. |

Auch bei vielen Ausgabezustandswechseln bleiben zwei Command-Ledger-Einträge
für Stop und terminales Aufräumen reserviert. Eine weitere aktive Mutation
wird vor Commit abgewiesen, bevor diese Reserve aufgebraucht werden könnte.
Ungültige fremde Writer-Fences verändern den Programmzustand nicht.

## Stop ist keine erfundene Medienbestätigung

Nach dem Runtime-Widerruf sendet der Server den bestehenden gefenceten
`assignment-stop` mit `PROGRAM_RUNTIME_EXPIRED` ausschließlich an das aktive
Assignment des gebundenen Owners und Programms. Eine verlorene Zustellung
hebt den Widerruf nicht auf. Die bereits übertragenen nativen Leases können
die Deadline nicht überschreiten. Der bestehende Lease-Watchdog kann denselben
Stop zusätzlich einmal mit `LEASE_EXPIRED` senden.

Das Assignment bleibt ohne Agentenbestätigung zunächst `draining`, nicht
`stopped`. Ein Runtime-Stop oder späteres serverseitiges `failed` beweist für
sich allein weder einen beendeten Encoderprozess noch entfernte Ausgabedateien.
Die native Cleanup-/ACK-Abnahme bleibt deshalb Bestandteil der realen CI- und
Produktionsgates. Das vorhandene native Source-Assignment behandelt eine
Erneuerung mit identischer Ablaufzeit ohne Reset seiner monotonen Deadline.

Für den Legacy-MediaMTX-/WHIP-Zweig werden Programmrechte widerrufen und neue
Zugriffe abgewiesen. Ein bereits offener Ingress benötigt jedoch weiterhin den
gesonderten physischen Session-Kill-/Ressourcenfreigabenachweis. Diese Änderung
behauptet deshalb **keine vollständige Encoder-Laufzeitkontrolle aller
Legacy-Gateways**, keine Clusterquote und keinen abgeschlossenen TBP-033.

## Verifikation

Vor der Implementierung scheiterten acht neue Runtime-/Konfigurationsprüfungen,
darunter eine Lease-Erneuerung auf 90 statt maximal 60 Sekunden und fortbestehende
Quellenrechte am Programmende. Danach bestanden 173 gezielte browserfreie
Node-/HTTP-/WebSocket-/P-256-/JWT-Prüfungen gemeinsam in 4,478 Sekunden.
Der echte Serverkonstruktor ist mit Operator-ENV, realem Runtime-/Assignment-State,
simulierter Zeit, kontrollierter Stopzustellung, gesondertem ACK und HTTP-Health
abgedeckt. Zwei Packager werden über den echten Handoff-Koordinator gewechselt.

Zwei vorhandene Socket-Fixtures benutzten zuvor eine eingefrorene Registry-Uhr
neben der laufenden Serveruhr. Für ihre Live-Variante wird jetzt dieselbe bereits
vorhandene monotone Testuhr verwendet; deterministische Rollbacktests behalten
ihre steuerbare Uhr. Keine Runtime-Frist wurde für einen Test gelockert.

Lokale Browser-, Audio- und FFmpeg-Tests bleiben pausiert. Der zusätzliche
gezielte native Go-Aufruf konnte lokal mangels `go` im PATH nicht starten
(Exit 127); er zählt nicht als bestanden. Der vollständige Projektcheck und
die native Medienabnahme müssen in CI für den neuen Commit erfolgen. Das
ausgelieferte lokale `dist` sowie Produktionsdienste wurden nicht geändert.
