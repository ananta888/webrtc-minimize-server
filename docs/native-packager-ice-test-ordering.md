# Native-Packager: frühe ICE-Kandidaten in der Testgegenstelle

Die RTP-Fixture muss wie der echte Angular-Publisher ICE-Kandidaten bis zur
Remote-Answer puffern. Pions `AddICECandidate` ohne RemoteDescription ist kein
gültiger Ersatz dafür. Der produktive Angular-Pfad hat bereits eine begrenzte
Queue; diese Änderung betrifft ausschließlich Go-Testcode.

## Reproduktion

CI 34249189767 (`bc1fce8`) scheiterte mit empfangenem RTP und einem aggregierten
Signalisierungsfehler. Zusätzlich las die Fehlerausgabe `assignment.State` ohne
den vom Writer verwendeten `assignmentMu`. Der Diagnosesnapshot ist jetzt
synchronisiert; atomare feste Fehlerstufen enthalten keine SDP-/ICE-Inhalte.

Auf `2ae2e2a` wurden je drei echte Pion-Verbindungen mit normaler und ausdrücklich
erzwungener ICE-vor-Answer-Reihenfolge geprüft. Zwei Standardfälle bestanden,
einer erreichte das Verbindungslimit. Alle drei erzwungenen Fälle scheiterten:
zweimal Verbindungslimit, einmal mit `packets=1`, `bytes=14`, `signalStage=2`,
`earlyCandidates=1`. Letzteres belegt das zu frühe Anwenden des Kandidaten;
es erklärt nicht automatisch jede historische Netzwerkdeadline.

## Regression

Ein kleiner, ausschließlich testlokaler Empfangsport puffert höchstens 128
Kandidaten und leert sie nach erfolgreicher Answer in Reihenfolge. Überlauf und
Anwendungsfehler sind terminal; Stop leert die Queue. Deterministische Tests
prüfen Reihenfolge, einmalige Zustellung, Grenze, Fehler und Stop. Der reale
Pion-Fall verlangt weiterhin eine tatsächlich beobachtete frühe ICE-Nachricht,
eine verbundene PeerConnection und empfangene RTP-Pakete/Bytes.

Verbindungsbudget (10 Sekunden) und RTP-Budget (5 Sekunden) bleiben unverändert;
die künstliche Reihenfolge hat separat höchstens zwei Sekunden. Keine Retries,
Assertion-Abschwächung oder Änderung an Produktions-ICE, SFrame oder Capture.

## Verifikation der Korrektur

Am Stand `c093809` bestand derselbe kompilierte Race-Test im isolierten
Container-Netz alle zehn Standard- und zehn erzwungenen Verbindungsfälle sowie
die Queue-Negativtests. Die alte Reproduktion scheiterte im selben Netz erneut
dreimal mit `signalStage=2` und tatsächlichem RTP-Empfang. Das ist ein gezielter
Vorher-/Nachher-Nachweis und kein bloßer erfolgreicher Wiederholungsversuch.

Der vollständige native Racelauf im Container bestand mit 146 erfolgreichen
Top-Level-Tests und zwölf ausdrücklichen FFmpeg-/Interop-Skips; `go vet ./...`
bestand ebenfalls. Die optionalen Skips sind keine Medienabnahme.

Auf dem Laptop-Host bestanden dagegen nur neun der 20 Verbindungsfälle;
elf erreichten unverändert das 10-Sekunden-Limit, jeweils ohne Signalfehler
(`signalStage=0`). Auch der komplette Host-Racelauf scheiterte an beiden
Verbindungsfällen und einer Source-Beobachtungsfrist. Die zahlreichen virtuellen
Host-Schnittstellen sind eine mögliche Ursache, aber nicht abschließend
diagnostiziert. Dieser getrennte Host-/Netzwerkbefund bleibt offen; die
Testkorrektur wird nicht als allgemeiner Produktions-Netzwerkfix ausgegeben.

Der isolierte `npm run check` am Stand `c093809` bestand mit Exit 0:
698 Frontendtests und 774 Nodeprüfungen bestanden, null Fehler, zwei explizite
Node-Skips; Node-Laufzeit 322,715 Sekunden. Build, Go-Unit/Vet und statische
Sicherheits-/Konfigurationsgates bestanden. Vierzehn externe Infrastruktur-Gates
und der optionale Image-Scan blieben sichtbar übersprungen. Beide kombinierten
Ananta-Dialogfälle bestanden (Chromium 15,561 / Firefox 16,833 Sekunden): je
16.000 entschlüsselte PCM-Samples, korrelierter Chat, bewegte eigene Bildschirm-
quelle, drei Renewals und aktiver Rechteentzug. Keine menschliche Capture-
Freigabe oder produktive Hub-/Projektpolicy wurde dadurch erzeugt.

Der Serving-Build blieb SHA-256-identisch. Neue CI und produktiver Rollout stehen
noch aus; das operatorseitig freigegebene öffentliche Hub-Trustprofil bleibt
eine separate Voraussetzung. MDS-09 ist nicht abgeschlossen.
