# Broadcast-Quellen gezielt entfernen

In einer laufenden nativen Mehrquellen-Sendung öffnet der Programm-Ersteller
**Aktive Quellenfreigaben verwalten** und fragt die Freigaben ausdrücklich ab.
Die Anzeige ist höchstens fünf Sekunden ab Anfragebeginn nutzbar. Eine separate
Bestätigung entfernt genau die gewählte Quelle aus der Sendung. Kamera, Mikrofon
und Bildschirm im interaktiven Raum bleiben davon unabhängig.

Die Liste zeigt gültige Consents, nicht bestätigten Medienempfang. Ein Widerruf
bestätigt die serverseitige Entziehung der Freigabe, nicht die sofortige Leerung
bereits ausgelieferter HLS-Playerpuffer. Die vorhandenen begrenzten Source-Leases
und der Stop-Pfad im Packager beenden die weitere Verarbeitung. Andere gültige
Quellen bleiben erhalten; eine neue Nutzung benötigt eine neue Anfrage und die
erneute ausdrückliche Zustimmung des Publishers. Eine Einladung abzubrechen oder
eine Quelle aus dem Layout zu nehmen ersetzt diesen Widerruf nicht.

## Autorität und Grenzen

- `contracts/trusted-decrypt/source-moderation.v1.schema.json` definiert einen
  eigenen geschlossenen WS-Namensraum, getrennt von Publisher-Steuernachrichten.
- Abfrage und Widerruf benötigen die tatsächliche aktuelle menschliche
  Creator-Verbindung und verifizierte Identität. Der Server prüft das eigene
  Programm, den Raum und die Program-Epoch; beim Widerruf zusätzlich die erwartete
  Program-Revision und Writer-Fencing-Revision. Öffentliche Fingerprints oder
  kopierte Peer-Objekte genügen nicht. Delegierte Moderatorrollen werden hier
  nicht neu eingeführt.
- Höchstens 80 Quellenmetadaten, Anfragen bis 2 KiB, Antworten bis 32 KiB und
  höchstens 64 KiB ausstehende Socket-Bytes. Das vorhandene Principal-Budget der
  Quellenautorität begrenzt Moderation und Approval zusammen auf 60/min.
- Die Projektion enthält nur Quellen-/Consent-Referenz, Quellenart, Peer-ID und
  Ablaufzeit. Anzeigenamen kommen separat aus aktueller Room-Membership.
  Keine Identitätsclaims, Gerätefingerprints, Schlüssel, Medien oder Tokens.
- Der Audit-Grund `program-owner-removed` unterscheidet die serverautorisierte
  Owner-Entfernung vom Publisher-Widerruf. Es entsteht kein neuer Consent.
- Leave, Identitäts-/Programmwechsel, Zeitablauf, ungültige Antwort und
  Backpressure entwerten die lokale Momentaufnahme. Verspätete Antworten dürfen
  keine neue Anzeige autorisieren. Es gibt keine automatische Mutationswiederholung.
  Bei fehlender Antwort kann ein gesendeter Widerruf bereits wirksam sein.
- Das Öffnen des Panels fragt weder Freigaben noch Capture-Berechtigungen an.
  Der Editor hält ausschließlich flüchtige Metadaten; sein Schließen stoppt
  keine anderen Publikationen.

Gezielte Domain-Tests verwenden verschiedene synthetische Owner-/Publisher-
Identitäten und zwei unabhängige Quellen. Der gekoppelte Browser-Test prüft
zusätzlich die Tastaturaktion des Owners, echte native Quellenverarbeitung,
Slate nach Kameraentzug und weiterbewegtes Bildschirmbild in der HLS-Ausgabe.
Dieser Pfad ist kein Nachweis für sämtliche Moderator-/Handoff-Funktionen,
physische Geräte, Produktionslast oder eine verzögerungsfreie Auslieferung.
