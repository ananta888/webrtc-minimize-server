# Expliziter serverseitiger Mehrquellen-Start

`POST /api/broadcasts/<programId>/native-source-programs` ist ein separater
authentisierter Einstieg. Der geschlossene
[Startvertrag](../contracts/native-packager/source-program-start.v1.schema.json)
verlangt `requestVersion: 1`, `trigger: "user-action"`,
`inputMode: "trusted-sframe-v1"`, `packagerId`, `deviceFingerprint`,
`requestedRenditions` und `allowHardwareAcceleration`.
Er akzeptiert keine Source-IDs, Raumepoche, Geräte-Referenz, Keys oder SDP vom
Controller. Ein Programm startet ohne Quellen; die native Pipeline liefert
Slate, bis einzelne Publisher separat tatsächlich zugestimmt haben.

Die vorhandene serverseitige OIDC-/Origin-/Room-Creator-/Gerätebindung gilt
weiter. Vor Programm-Mutation werden Writer-Belegung, aktuelle Admission und
der ausdrücklich gemeldete `capabilityVersion: 2`/`sourcePrograms: true`-Pfad
geprüft. Alte oder nicht consentierte Agenten werden nicht automatisch
umgeschaltet. Ein abgelehnter Start erweitert keine Freigabe.

`NativePackagerAssignmentRegistry.prepareSourceProgram` erzeugt den vorhandenen
geschlossenen v4-Auftrag. Tenant und P-256-Geräteref stammen aus der normalisierten
Packager-Capability, die Raumepoche aus der Signaling-Membership. Der exakte
authentisierte, menschliche Controller muss weiterhin im eigenen Raum sein.
Der zusätzliche interne Consent-/Verbindungsgenerations-Handle ist nicht Teil
des Wire-Vertrags. Widerruf mit anschließendem sofortigem Neu-Consent kann
einen alten Auftrag nicht wieder gültig machen.

Renewal, positive Agent-Statusmeldungen, Output-Ready und der interne
Source-Parent prüfen diese Bindungen erneut. Bei Verlust werden keine neuen
Source-Leases oder Writer-Verlängerungen autorisiert. Die vorhandenen
Source-Lease-/Control-Stop-Pfade bleiben verantwortlich für tatsächliches
Reaping. Ein fehlender Decrypt-Consent wird niemals durch den Start ersetzt.

Der v4-Auftrag enthält keinen `publisherPeerId` und akzeptiert keine alten
`assignment-signal`-/`native-packager-signal`-Medienpfade. Nur Statusmetadaten
gehen an den Controller. V4-ICE-Einträge sind strikt getrennte STUN- oder
credentialgebundene TURN-Gruppen; eine explizit leere Liste ist möglich und
erbt keine fremden Defaults. Der Legacy-Start bleibt unverändert.

## Handoff und Standby

Ein bestehender v4-Writer wird beim Handoff nicht zu einem Legacy-Writer.
Der Ziel-Packager muss den v4-Pfad bereits vor dem Stop des alten Writers
explizit unterstützen. Die vorhandene echte Stop-ACK-Barriere bleibt bestehen;
danach werden Membership, Admission und Ziel-Consent erneut geprüft und ein
frischer v4-Auftrag mit neuer Output-Generation ausgegeben. Alte Source-Grants
werden nicht übertragen. Standbys erhalten ausschließlich Auswahlmetadaten und
müssen für ein v4-Programm dieselbe zusätzliche Capability erfüllen.

## Angular-Einstieg

Raumersteller finden unter **Broadcast → Mehrquellen-Sendung öffnen** einen
eigenen Startpfad. Er verlangt die konkrete Packager-Auswahl und eine lokale
Bestätigung; Publikum ist zunächst privat, Hardwarebeschleunigung zunächst aus.
Es werden nur online gemeldete, für den Raum bestätigte, gesunde Geräte mit
exakter v2-Mehrquellen-Capability angeboten. Dies ersetzt keine serverseitige
Admission. Die Geräteübersicht lässt sich unter Analyse aktualisieren.

`NativeSourceProgramController` besitzt ausschließlich die Control-Plane-
Operationen, keine Medienverbindung, Capture-Quelle oder Frame-Schlüssel.
Der Root-Service bindet ihn an menschliche OIDC-Identität, Gerät, Creator,
Raum, Peer und Membership-Epoche. Create/Prepare sind auf zusammen 15 Sekunden,
Statusabrufe auf fünf Sekunden und die erste Outputbestätigung auf 45 Sekunden
begrenzt. Die Polls überlappen nicht; unbekannte Writer, rückläufige Revisionen,
andere Epochen, Kontextverlust oder abgelaufene Bestätigungen stoppen den Zweig.
Eine Annahme des Startauftrags ist noch keine Outputbestätigung. Erst der
passende serverseitige `live`-Status schaltet den Programmref für die bestehende
Quellenanfrage-Oberfläche frei. Auch dies beweist keine Zuschauerwiedergabe.

Panelwechsel beendet den Controller nicht. Expliziter Stopp oder Kontextverlust
widerruft zuerst das Programm und bestätigt separat den nativen Stopp. Geht die
Prepare-Antwort verloren, wird nach Programmwiderruf die begrenzte Auftragsliste
auf noch aktive Aufträge dieses Programms geprüft. Ein unbestätigter Stopp bleibt
sichtbar und wiederholbar; verspätete Start-/Statusantworten aktivieren nichts neu.
Der Legacy-Browser-/Einzelquellen-Start und dieser Einstieg sperren sich in der UI.
Es werden weder Standby-Keys verteilt noch automatische Source-Consents erteilt.

Die vorhandene Anfrage-Authority erlaubt Anfragen an **andere** Teilnehmer,
nicht an sich selbst. Eine direkte eigene Quelle des v4-Controllers, Layout,
Recovery und dessen vollständige Handoff-/Standby-Oberfläche bleiben als
Gesamtintegration offen; der Legacy-Handoff wird nicht still auf diesen neuen
Controller umgedeutet.

## Verifikation und verbleibender Umfang

58 gezielte Registry-, Capability-, Consent- und Handofftests bestanden in
2,150 Sekunden. Zwei reale Loopback-HTTP-/WebSocket-Fälle mit P-256-Packager-
Authentisierung prüfen alten und neuen Einstieg; synthetische OIDC-Fixture,
keine Produktionsidentität. V4-Schema, tatsächliche Membership-Epoche,
servergebundene Geräte-Referenz, abgewiesene Zusatzfelder, fremdes Gerät und
fehlender Opt-in werden geprüft. Positive Statusweitergabe funktioniert,
alter Einzel-Publisher-Ingress wird abgelehnt. Diese Tests betreiben keinen
nativen Encoder und beweisen keine vollständige Mehrquellen-HLS-Auslieferung.

Der erste HTTP-Test erwartete die Epoche irrtümlich im Welcome statt im
vorhandenen Membership-Port. Seine Assertion wurde korrigiert. Außerdem
schloss der Test-Helper bei Fehlern bisher nur Browser-WebSockets und konnte
auf eigene native Sockets warten; er beendet jetzt alle drei eigenen
Socket-Server vor HTTP-Close. Drei solche Testprozesse wurden gezielt beendet,
bevor der korrigierte Test lief. Keine Assertion oder Runtime-Frist wurde
gelockert.

Der gemeinsame Check dieses Serverstands war nicht grün: 914 Frontendtests
bestanden; Node meldete 927 bestanden, 16 fehlgeschlagen und zwei übersprungen
(339,606 s). 15 Fehler stammen aus einem gemeinsamen nativen Compile-Hook
(Exit 2, Ursache nicht erfasst); ein Firefox-Avatarstart meldete abgelaufene
Autorität. Die unveränderten Avatarfälle bestanden separat beide (7,867 s).
Der vollständige native Nachlauf bestand alle 15 Fälle (167,052 s), einschließlich
je 401 SFrame-Frames und gepaarter Audio-/Videouhren in Chromium und Firefox.
Das macht den ursprünglichen Gesamtcheck nicht nachträglich grün.
Eine neue begrenzte Compile-Diagnose gibt nur feste Fehlerklassen, Exitcode und
Signal aus, niemals Compilertext oder Pfade; zwei Redaktions-/Klassifikationstests
bestanden. Der externe Infrastrukturabschnitt des fehlgeschlagenen Checks wurde
nicht erreicht. Kein Deployment wurde daraus abgeleitet.

Der nachfolgende gemeinsame isolierte Check mit der Ananta-Page-Lifecycle-
Korrektur bestand: Exit 0, 922 Frontendtests, 946 Node-/Browserprüfungen,
null Fehler, zwei Node-Skips (419,948 s). Build, Typprüfung, Go und statische
Gates bestanden; 14 externe Infrastruktur-Gates wurden sichtbar übersprungen.
Der frühere Fehler bleibt historisch dokumentiert; dessen unbekannte Ursache
wird durch den grünen Nachlauf nicht als behoben behauptet.

### Angular-Startprüfung vom 9. September 2026

81 fokussierte Tests bestanden in 1,010 Sekunden: exaktes HTTP-Schema,
Antwortgrößen, falsche Scopes/Fences, fehlende Ausgabe, Abbruchrennen,
verlorene Prepare-Antwort, Stopbestätigung und lokale UI-Zustimmung. Der echte
Angular-Tastaturtest bestand zusätzlich (4,124 s): synthetische, kryptografisch
verifizierte OIDC-Identität und P-256-Room-Membership, native HTTP-Antworten
explizit simuliert. Kein Capture und keine zusätzliche PeerConnection; Start
erst nach Bestätigung, Quellenformular erst nach passendem Outputstatus,
Controller und Stop bleiben nach Panelwechsel erhalten. Das ist kein Encoder-
oder Zuschauer-HLS-Nachweis.

Der gemeinsame isolierte `npm run check` bestand **nicht**: 1.067 Frontendtests,
981 erfolgreiche Node-/Browserprüfungen, ein Fehler und zwei explizite Skips
(Node: 428,821 s). Build, Typen, Go und statische Gates bestanden. Das initiale
Bundle bleibt mit 1,60 MB über der Warnschwelle; der harte Build-Gate bestand.
Die externe Infrastrukturstufe wurde nach dem Nodefehler nicht erreicht.
Der neue Angular-Starttest und beide nativen Source-Publisher-Medienfälle
bestanden auch in diesem Lauf.

Der verbleibende Fehler betrifft den Ananta-Firefox-Timingtest: In der
Hold-last-Beobachtung fehlt die Avatar-Timingzeile; vor Cleanup melden Avatar
und Speech bereits `failed`, Screen bleibt offen. Keine gesicherte Ursache
und keine kausale Runtimekorrektur werden behauptet. Die getrennten Tests für
Audio/Chat/Screen mit Human-Consent und drei Renewals bestanden in beiden
Browsern. Grundlage ist `d2c4e0a` plus dieser Implementierung; der inzwischen
eingegangene reine Dokumentationscommit `91d9203` wurde konfliktfrei übernommen.
Serving-Build, Hub-Trust und Produktionspolicy blieben unverändert.

Die Angular-Startkomposition ist jetzt angeschlossen; die getrennte
Approve-/Publisher-Lease-Komposition ist in
[Trusted-Source-Workflow](trusted-source-angular-workflow.md) beschrieben.
Native Quellen-Recovery/Discontinuity, die vollständige Regieoberfläche,
reale gemeinsame Mehrquellen-Abnahme und das Deployment bleiben offen.
Dieser Einstieg schließt TBP-030 nicht ab. Es werden weder
Produktionspolicy noch lokale Agent-Opt-ins durch die Implementierung verändert.
