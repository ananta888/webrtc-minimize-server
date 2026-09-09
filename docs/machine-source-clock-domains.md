# Absolute Berechtigung und lokale Quellenzeit

Sprach- und Avatarquelle verwenden zwei getrennte Uhren. Der Signaling-Server
bleibt Eigentümer der Berechtigung; keine Uhr und kein Heartbeat erneuert eine
Lease oder eine Publisherfreigabe.

| Prüfung | Zeitbasis | Unveränderte Grenze |
| --- | --- | --- |
| Verifizierte Lease und ausgegebenes Aktivierungsende | Absolute Epoch-Zeit | `expiresAt` bleibt verbindlich |
| Tatsächlicher Sprachfortschritt | Monotone Browserzeit | 2.000 ms ohne Fortschritt |
| Frischer Avatar-Controllerimpuls | Monotone Browserzeit | 2.500 ms ohne Impuls |
| Avatar-Frames, Setup und Schutzverlust | Monotone Browserzeit | 5 FPS, 10 s Setup, 2 s Schutzverlust |
| Maximale lokale Aktivierung | Zusätzlich monotone Browserzeit | Sprache 50 s inklusive Setup, Avatar 30 s |

Die absoluten Receipts behalten unverändert ihre bisherigen Obergrenzen und
ihr Wireformat. Vorwärtskorrekturen der Wanduhr können deshalb weiterhin die
Lease oder Aktivierung beenden, aber keinen lokalen Fortschrittsstillstand
erfinden. Bei stehender Wanduhr laufen die lokalen Grenzen trotzdem ab.
Nichtendliche oder rückläufige Werte einer der beiden Uhren schließen weiterhin
die Quelle. Ein danach eintreffender Impuls oder Graphcallback belebt sie nicht
wieder. Bildschirmvideo und Bildschirmton hatten ihre lokalen Inaktivitätsfristen
bereits getrennt; ihre Berechtigungen werden durch diesen Nachtrag nicht verändert.

Die Zeitbasis ist ein kleiner injizierbarer Port der jeweiligen Quelle, keine
neue Policy, kein Scheduler und keine automatische Hub-Heartbeat-Erzeugung.
Produktive Controllerimpulse müssen weiterhin aus dem authentisierten Hub-Pfad
stammen. Auf dem Host werden weder Systemuhr noch Clocksource verändert.

## Nachweis und Grenzen

Die ursprüngliche Gesamtprüfung des Sitzungsfixes scheiterte unter anderem an
`progress-expired` nach 499 ms monotoner gegenüber 2.578 ms Wanduhrzeit und an
einem separaten Avatar-`controller-expired`. Der Quellcode verwendete dafür
ebenfalls die Wanduhr. Die neue getrennte Uhrmatrix reproduzierte zwölf Fehler
vor der Korrektur; danach bestehen 64 Quellen-/Boundarytests. Sie prüfen auch
unveränderte absolute Grenzen, lokale Aktivierungscaps, ungültige Uhren und
Widerruf. Frühere rein virtuelle Boundary-Fixtures führen beide Uhren gemeinsam
fort; die neue Matrix prüft ausdrücklich voneinander unabhängige Uhren.

Der neue Browserfall bereitet eine feste 3.000-ms-Korrektur ausschließlich im
isolierten synthetischen Maschinenclient vor, bevor Angular seine Ports erstellt.
Die Teilnehmer treten mit echten ephemeren TLS-/Ed25519-/P-256-Nachweisen bei;
danach werden Sprache, Avatar und Bildschirm unter required-SFrame publiziert.
Der Test verlangt weiter steigende dekodierte Empfängerzähler und Quellfortschritt,
nicht nur empfangene RTP-Bytes. Die normale Hostzeit und die Uhr des Servers
werden nicht verändert. Vor Wiederherstellung der Testuhr werden die Quellen
gestoppt und die Sitzung verlassen.

Gegen den vorherigen unveränderten Build wurde der Fehler in 3,445 s tatsächlich
reproduziert: Sprache und Avatar gingen unmittelbar auf `failed`, während der
Bildschirm offen blieb. Anschließend bestanden alle sieben gezielten Browserfälle
in 48,974 s: die neue Korrekturmatrix mit Chromium-/Firefox-Empfängern, beide
bisherigen Quellenzeitfälle, beide unabhängigen Sprachausgaben und die explizite
Unsupported-Prüfung des Firefox-Canvas-Publishers. Beide Sprachfälle spielten
66.150 Samples ab, ohne Capture oder Transformfehler.

Die anschließende isolierte Gesamtprüfung auf `0996030` plus diesem Nachtrag
bestand mit Exit 0: 1.188 Frontendtests, 1.086 Node-/Browserfälle, null Fehler
und vier ausdrücklich übersprungene Nodefälle (478,974 s Node-Laufzeit).
Build (17,430 s), Typprüfung, Go-Unit/Vet und statische Gates bestanden.
14 externe Infrastrukturprüfungen und der optionale Container-Image-Scan
blieben sichtbar übersprungen. Die neue Korrekturmatrix, die gemeinsamen
Audio-/Chat-/Screen-/Drei-Renewal-Dialoge und beide zuvor fehlgeschlagenen
Chromium-Fälle bestanden in diesem Gesamtlauf. Die ausgelieferte lokale
Browserdatei blieb SHA256-identisch. Dieser Nachweis beweist weder
störungsfreien Zweistundenbetrieb noch eine
öffentliche Hub-/Projektfreigabe oder eine Lösung sämtlicher Timingfehler.
