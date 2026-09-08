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
Die wiederholte Race-Prüfung, Gesamtprüfung und neue CI sind noch ausstehend.
