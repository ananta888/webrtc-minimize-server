# Publisherzuordnung für die Quellenregie

TBP-030, Stand 2026-09-10. Der interne Zuordnungsport ist implementiert;
HTTP-Autorisierung und Angular-Namensanzeige sind noch nicht angeschlossen.
Eine Einladung oder eine vom Agenten gelieferte Quellenliste beweist allein
nicht, welcher aktuelle Raumteilnehmer eine Quellenlease besitzt.

`TrustedBroadcastSourceControl.publisherBindings(context, sourceLeaseIds)`
projiziert vorhandene, vorbereitete Quellenleases. Der geschlossene Kontext
enthält `roomId`, `programId`, `programEpoch`, `packagerId`, `assignmentId`,
`writerLeaseId` und `fencingRevision`. Höchstens 80 unterschiedliche, syntaktisch
gültige Quellenreferenzen dürfen angefragt werden. Kontextfehler werden vor
einem Zugriff auf die Records abgewiesen. Fremde Programm-/Writerkontexte werden
vor jeder lebenszykluswirksamen Consentprüfung ausgeschlossen.

Eine gültige Bindung enthält ausschließlich `sourceLeaseId`, `publisherPeerId`
und `sourceKind`. Die unveränderlichen Ergebnisse enthalten keine Namen,
Principals, Gerätefingerprints, Publikations-IDs, Consents, Schlüssel oder
Medien. Unbekannte oder nicht vorbereitete Quellen ergeben keinen Eintrag.
Bestehende Prüfungen für Membership, Publikation, Consent, Writer, Assignment,
Socket und Ablauf müssen weiterhin bestehen. Deren bestehende Invalidierung
bleibt wirksam; eine Abfrage verlängert oder erzeugt jedoch keine Lease und
bestätigt keine Medienwiedergabe. Es entsteht kein zusätzlicher Datenspeicher.

Der Port ist **keine menschliche Autorisierung** und darf nicht direkt als
öffentlicher Lookup exponiert werden. Der nächste Anschluss benötigt einen
geschlossenen, größen- und ratenbegrenzten HTTP-Vertrag. Identität, tatsächliche
Gerätemembership, Programmbesitz und aktueller gefenceter Writer müssen vor der
Projektion erneut geprüft werden; fehlende Zuordnungen bleiben unbekannt. Die
Angular-Anzeige soll Peer-IDs nur gegen ihre aktuelle autorisierte Raummembership
auflösen, keinen Agentennamen als Identitätsnachweis verwenden und nach
Kontextverlust keine alten Namen weiteranzeigen. Anzeigenamen bleiben escaped
UI-Text, niemals Log-, Metrik- oder Autoritätsfelder.

Verifikation: 36 Node-/HTTP-/WebSocket-Tests mit realen lokalen Registry-,
P-256-Agenten-, Grant- und Writer-Fixtures bestanden in 3,893 Sekunden, ohne
Browser oder Audio. Die drei gezielten Zuordnungsfälle bestanden nach ergänzter
Prüfung gegen fremde Grantzugriffe erneut in 0,460 Sekunden. Geprüft werden
Vorbereitung, exakte Scopegrenzen, 80er-Limit, Unknown/Duplicate/Oversize,
Revoke/Leave/Publikationsstop/Writerverlust/Disconnect/Ablauf/Clockrollback,
unveränderte Leases und inhaltsarme Ausgabe. Diese synthetischen Prüfungen sind
kein Produktions-, HTTP-Label- oder UI-Nachweis. TBP-030 bleibt offen.
