# Publisherzuordnung für die Quellenregie

TBP-030, Stand 2026-09-10. Interner Zuordnungsport, geschützte HTTP-Abfrage und
Angular-Namensanzeige in der Quellenregie sind implementiert. Der ergänzte
echte Browserablauf wartet noch auf CI; Produktionsabnahme bleibt offen.
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

Der interne Port ist **keine menschliche Autorisierung**. Der separate
`POST /api/broadcasts/:programId/native-source-labels` verwendet geschlossene
v1-Request-/Response-Schemas in `contracts/native-packager/`. Er benötigt
`AUTH_MODE=required`, aktivierten Packager-Self-Service, gültiges OIDC,
zulässigen Origin, JSON ohne Queryparameter und höchstens 16 KiB Requestbody.
Die gemeinsame Human-Director-Policy prüft tatsächliche Gerätemembership,
Programmbesitz, Live-/Degraded-Zustand, Capability, Socket und gefenceten Writer.
Erwartete Programmrevision/-epoche, Packager, Assignment und Fencingrevision
müssen aktuell sein. Die Writerlease wird ausschließlich serverseitig abgeleitet.
Pro tatsächlichem Membership-Objekt sind 20 Abfragen in zehn Sekunden zulässig;
das WeakMap-Budget besitzt keinen langlebigen Principal-/Namensspeicher.
Ablauf, Clockrollback und Shutdown bleiben fail-closed. Es wird kein
Agentenkommando, Capture oder Apply ausgelöst, und keine Lease erneuert.
Antworten sind `no-store`; fremde Programme bleiben gemäß bestehender
Owner-Policy mit 404 verborgen. Fehlende Zuordnungen bleiben unbekannt. Die
Angular-Anzeige löst Peer-IDs nur gegen ihre aktuelle autorisierte Raummembership
auf, verwendet keinen Agentennamen als Identitätsnachweis und zeigt nach
Kontextverlust keine alten Namen weiter an. Anzeigenamen bleiben escaped
UI-Text, niemals Log-, Metrik- oder Autoritätsfelder.

Verifikation: 36 Node-/HTTP-/WebSocket-Tests mit realen lokalen Registry-,
P-256-Agenten-, Grant- und Writer-Fixtures bestanden in 3,893 Sekunden, ohne
Browser oder Audio. Die drei gezielten Zuordnungsfälle bestanden nach ergänzter
Prüfung gegen fremde Grantzugriffe erneut in 0,460 Sekunden. Geprüft werden
Vorbereitung, exakte Scopegrenzen, 80er-Limit, Unknown/Duplicate/Oversize,
Revoke/Leave/Publikationsstop/Writerverlust/Disconnect/Ablauf/Clockrollback,
unveränderte Leases und inhaltsarme Ausgabe. Diese synthetischen Prüfungen sind
kein Produktions-, HTTP-Label- oder UI-Nachweis. TBP-030 bleibt offen.

HTTP-Ergänzung: 53 gezielte Node-, Director-, Broker- und Source-Tests bestanden
in 4,012 Sekunden (0 Fehler, 0 Skips). Sie prüfen
zusätzlich den tatsächlichen neuen HTTP-Pfad mit signierten ephemeren JWTs,
P-256-authentisiertem Agentensocket und realen lokalen Registries. Geprüft sind
vorbereitete Quelle, Revoke, Unknown, falscher Scope, fremder Publisher,
ungültiges JWT, Origin/Method/Content-Type/Query, 16-KiB-Limit, geschlossenes
Schema und wirksames Ratelimit. Native Scene-v1/v2 bleiben unverändert.
Das ist Metadaten-/Policy-Evidence, kein Medien- oder Produktionsnachweis.

## Angular-Anschluss

Eine frische, vom Packager bestätigte Szene startet höchstens eine separate
Label-Abfrage für die verfügbaren Quellen. Diese Abfrage blockiert weder die
Bearbeitung noch das Anwenden einer Szene. Sie läuft höchstens drei Sekunden;
Fehler führen nicht zu automatischen Wiederholungen. Ein neuer expliziter
Szenen-Refresh darf die Zuordnung erneut anfragen. Leere Quellenlisten brauchen
keine Label-Anfrage. Antworten werden geschlossen geparst und müssen exakt zu
Programmrevision/-epoche, Packager, Assignment, Fence und den angefragten
Quellen-IDs **und** Quellarten passen. Duplikate/Unknown/Oversize sind ungültig.

Der getrennte Label-Controller hält nur Peer-/Quellenreferenzen. Neue Szene,
Apply, fehlende Membership, anderer Owner, fünfsekündiger Ablauf der zugrunde
liegenden Szene, Clockrollback oder Destroy verwerfen Bindungen und brechen
laufende Anfragen ab. Verspätete Antworten dürfen auch vor dem nächsten
Lifecycle-Tick keine Zuordnung wiederherstellen. Es gibt weder Speicherung
noch einen Namenscache. Die Anzeige prüft den aktuellen Kontext zusätzlich bei
jedem Lookup und liest Namen aus den aktuellen Membership-Signals, einschließlich
des eigenen Teilnehmers. Namen sind auf 80 Zeichen begrenzt und nur UI-Text.

Quellenauswahl, Bildanpassung und bevorzugte Quelle zeigen den Namen neben der
technischen Quellenreferenz. Bei fehlender oder veralteter Zuordnung erscheint
„Teilnehmer nicht zugeordnet“; die Quelle bleibt über ihre Referenz bedienbar.
Ein Name beweist weder Decrypt-Consent noch Medienempfang.

67 gezielte Frontend-Tests bestanden in 0,955 Sekunden, darunter 14 neue Fälle
für die Namenszuordnung; TypeScript, Angular-no-emit und Todo-Gate sind grün.
Die Tests decken Parser, HTTP-Adapter, Ablauf/Abort/Ownership,
verspätete Antworten, aktuelle Self-/Remote-Namen und die echte gerenderte
Angular-Vorlage einschließlich escaped HTML-ähnlicher Namen ab, ohne Browser
oder Audio. Der bestehende CI-Browserablauf prüft ergänzend die Zuordnung zu
seiner tatsächlich beigetretenen Testidentität und das Entfernen des Namens
nach einer leeren Folgeantwort. Die Metadatenantwort dort ist ausdrücklich
synthetisch; sie ersetzt weder den separaten realen HTTP-Policy-Test noch eine
Produktions- oder Medienabnahme.
