# Native Programm-Generation

Eine interne, ausdrücklich autorisierte `sourceProgramGeneration` verbindet
gemeinsames Decoderbudget, Publisher-Uhren, Lazy-Decoder, Audio-Resampling,
Audio-/Videomixer, Programmtakt und Raw-HLS-Encoder. Sie ist noch **nicht** der
produktive Assignment-/SourceFactory-Adapter und aktiviert keinen Decrypt-Port.

## Autorität und Lebenszyklus

Der vertrauenswürdige Elternkontext bindet Tenant, Packager/Gerät, Raum und
Membership-Epoch, Programm/Epoch sowie Assignment, Writer-Lease und Fence.
Jede neue Quelle muss zusätzlich durch einen aktuellen `SourceReceiver`
genau dieser vollständigen unveränderlichen Lease gebunden sein. Ein erlaubter
Receiver und fremde JSON-Metadaten genügen nicht. Nur Revision und Leasezeiten
dürfen sich bei autorisierter Erneuerung ändern; bestehende Handles behalten
ihre Identität und prüfen weiterhin aktuelle Receiverpolicy.

Höchstens 20 Publisher-Uhren (Peer und Gerät innerhalb der festen Membership)
und 80 Quellenhandles; je Publisher maximal vier Medienuhren. Decoderprozesse
und Medienpuffer besitzen vor Zuteilung ein explizites gemeinsames Budget.
Geschlossene Quellen bleiben bis zum Generationsende in der begrenzten Historie.
Das verhindert unbeschränkten Churn, benötigt für langen Betrieb aber den noch
fehlenden äußeren Generation-/Recovery-Adapter. Szene und Gain akzeptieren nur
eigene aktuelle Handles; die spätere Steuerungsroute muss zusätzlich den
aufrufenden Director autorisieren. Diese lokalen Methoden erteilen keine Rechte.

Die Generation besitzt genau einen Scheduler. `Close()` setzt den Fence und
stoppt die Ausgabe; `finished` wird erst nach Schedulerende, allen Source-
Workern/Decoder-Reapern, geleerten Mixern/Uhren und Encoder-Reaping geschlossen.
Der Encoder behält die Widerrufsprüfung aller bereits verwendeten Quellen auch
für gepufferte/ausgegebene Segmente. Entzug einer solchen Quelle beendet die
gesamte Ausgabe-Generation. Bereits berechtigt abgerufene Daten sind nicht
rückrufbar. Neuer Output nach Entzug benötigt künftig eine neue Generation,
nicht das Löschen alter Fences oder einen impliziten Klartext-Fallback.

## Zeitgerechte begrenzte Videoqueue

Die erste gemeinsame Echtcodec-Prüfung reproduzierte nach 7,37 Sekunden gültige
HLS-Fragmente ohne ein einziges Quellbild. Ursache: Bei 300 ms Ausgabeversatz
verwarf ein voller Pool stets das älteste zukünftige Bild. Eine kontinuierliche
Quelle konnte dadurch jedes Bild verdrängen, bevor es fällig wurde.
Der deterministische Zwei-Puffer-Test reproduzierte ebenfalls ausschließlich
Slate. Das ist eine interne Packager-Regression, kein Nachweis zur Ursache
eines früheren Browser-Video-Freezes in einem produktiven Raum.

Der feste Pool schützt nun das aktuelle und das nächste fällige Bild. Gibt es
weitere Pending-Bilder, ersetzt eine neue Ankunft nur das fernste; sonst wird
die neue Ankunft verworfen. Dadurch wächst kein Speicher. Drop-Freiheit oder
volle Quell-FPS werden nicht zugesichert. Monotone Zeitstempel, Ablauf, Slate,
Ownership und Wipe bleiben erhalten. Die Regression prüft Pools mit zwei, drei
und acht Bildern unter kontinuierlichem 30-FPS-Vorlauf.

Ein separater echter Konstruktor-Negativtest reproduzierte bei fehlendem FFmpeg
einen nil-Pointer-Absturz im Cleanup: Ein nil-Encoder wurde bereits in ein
nichtnil Lifecycle-Interface konvertiert. Der native Factory-Wrapper gibt den
Fehler jetzt vor dieser Konvertierung zurück; fehlende Codecs bleiben begrenzte
Startfehler ohne öffentliche Ausgabe.

## Prüfumfang und noch fehlende Verdrahtung

Die Echtcodec-Fixture speist bereits entschlüsselte synthetische VP8-Keyframes
und Opus-Pakete samt synthetischen Senderreports in die echte Wall-Clock-
Generation. Sie erneuert beide echten lokalen Receiver-Leases sechs Mal,
decodiert H.264-Bilder und 700-Hz-AAC aus beiden HLS-Renditions und widerruft
danach den Video-Receiver. Reaping, geleerte Budgets und entfernte Ausgabe
werden geprüft. Das ist kein Netzwerk-/RTP-/SFrame- oder Produktionsnachweis.
SFrame- und echte Browser-Senderreports haben weiterhin separate Gates.

Vor produktiver Freischaltung bleiben Assignment-/SourceFactory-Integration,
atomarer Generationswechsel mit HLS-Discontinuity/Recovery, öffentlicher
Approve-/Renew-Pfad und gemeinsame Multi-Publisher-/SFrame-Endabnahme notwendig.
Agent-Version und Produktivfähigkeiten werden mit diesem internen Baustein
nicht angehoben. Siehe [Raw-Encoder](native-source-program-encoder.md).

Die finale fokussierte Race-Matrix bestand dreimal und Vet ebenfalls. Die drei
gemeinsamen Echtcodec-Läufe bestanden in 7,68 / 7,65 / 7,84 Sekunden.
Der isolierte Gesamtcheck auf Basis `8b72a46` plus diesen Änderungen bestand
mit Exit 0: 713 Frontendtests, 779 erfolgreiche Nodeprüfungen, null Fehler,
zwei explizite Node-Skips (Node 338,926 s). Der neue Node-Gate war darin mit
7,619 Sekunden enthalten; Build, Go-Unit/Vet und statische Gates bestanden.
14 externe Infrastruktur-Gates und der optionale Image-Scan blieben ausdrücklich
übersprungen. Der lokale Serving-Build blieb unverändert. Ein separater
Software-Rollout von `8b72a46` enthält diese neue Generation noch nicht.
