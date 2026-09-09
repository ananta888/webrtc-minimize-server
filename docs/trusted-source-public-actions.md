# Explizite Quellenfreigabe über die Publisher-Verbindung

Die additiven [Source-Aktionen](../contracts/trusted-decrypt/source-actions.v1.schema.json)
laufen auf der bestehenden authentisierten Raum-WebSocket-Verbindung:

- `trusted-source-publications`: ausschließlich eigene aktuelle Publikations-
  IDs/Epochen, eigene Peer-ID und serverseitige Raumepoche; kein Capture/Consent.
- `trusted-source-approve`: vorhandener geschlossener Approval-Vertrag mit
  Einladung, Publikation/Epoche, Raum, Gerät, `user-action` und begrenzter Dauer.
- `trusted-source-revoke`: ausschließlich eigenen Consent widerrufen.

Die Identität stammt intern aus dem verifizierten OIDC-Join/Einmal-Ticket.
Tokens und vom Browser behauptete Claims werden nicht in Signaling übernommen.
Der Actor muss exakt das noch aktive authentisierte menschliche Registry-
Peerobjekt sein; ein Fingerprint oder kopiertes Peerobjekt reicht nicht.
Invitation-, Publication-, Writer- und Consent-Prüfungen bleiben maßgeblich.
Der öffentliche Einstieg verlangt einen v4-Writer und aktuelle native Source-
Signaling-Capability. Preparefehler widerruft den dabei erteilten Consent.
Keine automatische Wiederholung, Legacy-Umschaltung oder Klartextfreigabe.

Die [Publisher-Nachrichten](../contracts/trusted-decrypt/source-publisher-control.v1.schema.json)
trennen `trusted-source-approved` vom Receiver-bestätigten
`trusted-source-publisher-lease`. Nur nach tatsächlichem nativem ACK geht der
konkrete Lease an den gebundenen Publisher, höchstens einmal pro Revision.
Auch Erneuerungen gehen erst nach ACK weiter und bleiben innerhalb der
ursprünglichen Consent-Dauer. Sie verlängern kein Nutzereinverständnis.

Widerruf, Quellenende, Scopeverlust oder Zustellfehler beendet nur diese Source.
Stop geht getrennt an Receiver und dieselbe noch vorhandene Publisher-Verbindung.
Bei fehlender Zustellung bleibt die kurze lokale Ablaufgrenze maßgeblich.
Der Parent-Writer und die menschliche Raumaufnahme bleiben unabhängig.
Signaling enthält weder Medien noch SFrame-Schlüssel.

## Prüfung und verbleibender Umfang

46 fokussierte Server-/Protokoll-/Ticket-/v4-Tests bestanden final (3,827 s), darunter
echtes Loopback-HTTP/WS mit synthetischem OIDC und P-256-Agenten-Handshake.
Der Browser-Join nutzt hier ein explizites ephemeres Session-Ticket, keinen neuen
PKCE-/P-256-Join-Nachweis. 29 Signaling-/Publisher-Frontendtests bestanden (1,130 s).
Die neue v4-Fixture wurde zunächst korrekt wegen einer noch belegten Assignment
abgewiesen; sie bildet nun die tatsächlich getrennte alte Testverbindung über
den bestehenden Disconnect-Pfad ab. Keine produktive Stop-Regel wurde gelockert.

Die [Angular-Quellenfreigabe](trusted-source-angular-workflow.md) verbindet nun
lokale Quellenauswahl, ausdrückliche Bestätigung und `TrustedSourcePublisher`.
Noch zu verbinden: v4-Start-UI, Mehrquellenlayout, Recovery/Discontinuity und
vollständige Mehrquellen-HLS-Abnahme.
Ein Server-Receipt allein startet keine Browserpublikation. Dieser Schritt
aktiviert keine Produktionskonfiguration und schließt TBP-030 nicht ab.

Der isolierte Gesamtcheck auf Basis `f02df7b` bestand 922 Frontendtests und
950 Node-/Browserprüfungen, scheiterte aber an einem bestehenden Firefox-
`hold_last`-Avatarfall (zwei Node-Skips, 411,729 s). Build, Typprüfung, Go und
statische Gates bestanden; der anschließende externe Infrastrukturabschnitt
wurde wegen des Fehlers nicht erreicht. Eine begrenzte numerische Diagnose
wurde ergänzt, ohne die Assertion zu lockern. Der einmalige fokussierte
Firefox-Nachlauf bestand (9,600 s), erklärt aber die ursprüngliche Ursache nicht.

Nach dem Start dieses Gesamtchecks wurde die Receipt-Zustellung zusätzlich
gegen geworfene Sendefehler und mehr als 64 KiB Backpressure abgesichert:
Beide Fälle widerrufen den gerade erteilten Consent, ohne den Writer zu stoppen.
Die obigen finalen 46 Fälle enthalten beide echten WebSocket-Negativtests und
liefen im isolierten Prüfkandidaten mit dem finalen Server-/Teststand.
Der Gesamtcheck bleibt ausdrücklich fehlgeschlagen; die neue CI ist separat
vor einem Release zu prüfen. Kein Deployment oder produktiver Source-Opt-in.
