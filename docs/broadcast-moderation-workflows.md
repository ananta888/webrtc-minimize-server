# Broadcast-Regie, Quellenwiderruf und Packager-Handoff

Aktuelle Ergänzungen (2026-09-11): Die kontogebundene
[Quellenmoderation](broadcast-source-moderation.md) ist inzwischen angeschlossen.
Der neue [bestätigte Programmverlauf](broadcast-program-history.md) zeigt
begrenzte flüchtige Runtime-Übergänge einschließlich Stop und Handoff. Das ist
kein vollständiges Audit und keine automatische Standby-Übernahme. Die folgenden
historischen Abschnitte behalten ihre jeweilige Datierung und ihre Grenzen.

Stand: 2026-09-07. Dieses Dokument beschreibt den TBP-030-Zwischenstand.
Die Domainpolicy für serverseitige Moderation ist vorbereitet, aber noch nicht
vollständig an eine öffentliche Moderations-API angeschlossen. Eine getrennte
Quellenanfrage-API ist jetzt verbunden, ohne Consent oder Medienrechte zu erteilen.
Der native Packager besitzt
inzwischen einen realen Enrollment-/Publish-/Playback-Pfad. Eine laufende
Own-Source-Komposition lässt sich über einen getrennten lokalen Bildregie-Port
steuern. Für eigenes natives Publishing ist die unten beschriebene serverseitige
Same-Program-Übergabe einschließlich Angular-Übergabedialog angeschlossen.
Kontrollierter Player-Generationswechsel ist lokal implementiert und getestet.
Fremdquellenmoderation und automatische Standby-Übernahme bleiben offen. Eine
keylose Standby-Vormerkung ist implementiert und per Produktionstastaturtest belegt.
Private Zwei-Packager-
Übergaben sind inzwischen real nachgewiesen; der vollständige Gate mit
öffentlicher Rückübergabe ist weiterhin offen.

## Angeschlossene Quellenanfragen (noch ohne Medienübernahme)

`POST /api/broadcast-source-requests` akzeptiert den geschlossenen Vertrag unter
`contracts/broadcast-source-requests/request.v1.schema.json`. Er ist nur bei
erforderlichem OIDC und aktiviertem Native-Packager-Selfservice verfügbar.
Exakter Origin, JSON-Body-Grenze und aktuelle Human-Mitgliedschaft desselben
Raums und Gerätefingerprints werden vor der Aktion geprüft.

Alle Aktionen enthalten `requestVersion: 1`, `action`, `roomId` und
`deviceFingerprint`. `create` ergänzt den sichtbaren lokalen Trigger
`user-action`, Programm-ID, erwartete Programmrevision/-epoche, `targetPeerId`
und `sourceKind` (`microphone`, `camera`, `screen`, `screen-audio`). Ausschließlich
der tatsächliche aktive native Program-Publisher darf einen anderen aktuellen
Human-Peer seines Raums anfragen. Ein bestehender Writer mit gültiger Lease ist
erforderlich; während einer Übergabe gibt es keine neue Anfrage.

`list` liest nur die an das eigene konkrete Peer-/Gerät gerichteten oder von ihm
gesendeten Anfragen. `decline` ist dem Zielgerät vorbehalten, `cancel` dem
anfragenden Publisher; beide benötigen `requestId` und `trigger: user-action`.
Ein identisches terminales Ablehnen/Zurückziehen ist idempotent. Ein fremder
Request liefert denselben Unavailable-Fehler wie ein unbekannter. Nach
Leave/Rejoin erhält auch dasselbe Konto/Gerät alte Anfragen nicht zurück.

Die Antwort enthält ausschließlich die geschlossenen Metadaten und immer
`authority: none`. Es gibt bewusst **keine** `approve`-Aktion, keinen Consent,
keinen Capture-Aufruf, keine Schlüsselweitergabe und kein neues Assignment.
Die nächste UI-/Consent-/Medienintegration muss diese getrennten Rechte erst
explizit einholen und durchsetzen; diese API allein ermöglicht noch keinen
Trusted-Program-Broadcast fremder Quellen.

Anfragen laufen nach 120 Sekunden ab. Lesen/Aktionen prüfen erneut Membership,
Publishergerät, Programmrevision/-epoche, Writer/Fence und dessen Lease;
Abweichungen invalidieren die Anfrage. Ein Fünf-Sekunden-Pruner entfernt
abgelaufene Metadaten auch ohne weitere Requests, Serverende löscht den Zustand
und sperrt weitere Aktionen. Maximal 20 Anfragen je Senderkonto, Zielkonto oder
Programm pro Lebenszeitfenster sowie 1.024 insgesamt begrenzen Speicher und
Flapping; terminale Anfragen verbrauchen ihr Budget bis Ablauf weiter. Zusätzlich
sind 60 Aktionen je Principal/Minute und 2.048 aktive Rate-Zähler begrenzt.
Diese Grenzen betreffen nur Broadcast-Anfragen, nicht die Anzahl von Räumen.
Namen, OIDC-Tokens, Fingerprints, Medien und Decrypt-Schlüssel fehlen in der
Antwort; alle Antworten verwenden `no-store`. Es gibt keine Persistenz.

Unit-/Contracttests und ein echter lokaler HTTP-Lauf mit kryptografisch
verifizierten ephemeren OIDC-Tokens prüfen diese Grenzen. Room-Admission und
Packager-Admission sind in diesem isolierten HTTP-Test explizite Fixtures, keine
neue Produktionszulassung. Publisher-Consent und die tatsächliche
Remotequellen-Verarbeitung bleiben als nächste Implementierungsschritte offen.

### Angular-Bedienung der Anfragen

Im Broadcast-Bereich eines angemeldeten Raummitglieds öffnet „Quellenanfragen
öffnen“ das nachgeladene Panel. Erst „Anfragen vom Server laden“ liest Metadaten;
Panelöffnung und Scopewechsel lösen keinen Control-Request aus. Eingegangene
Anfragen lassen sich ablehnen, gesendete zurückziehen. Es gibt noch keinen
Annehmen-Button. Ablauf wird lokal angezeigt, aber allein der aktuelle Serverstand
ist maßgeblich. Manuelles Laden ist bewusst getrennt von Hintergrund-Polling.

Nur bei einer laufenden eigenen nativen Sendung erscheinen Teilnehmer- und
Quellenwahl. Maschinen werden nicht als Human-Ziel angeboten. Eine lokale
Bestätigung nennt Ziel und Quellenart; danach wird der aktuelle native
Kontrollstand derselben Programm-Epoche gelesen und die Anfrage gegen dessen
Revision gesendet. Bei Handoff, Scope-/Konto-/Gerätewechsel oder abweichendem
Snapshot erfolgt keine nachträgliche Mutation. Eine Mutation wird nie automatisch
wiederholt. Antworten sind geschlossen, auf 64 KiB und 40 Einträge begrenzt,
raum-/peergebunden und auf `authority: none` geprüft. Das gemeinsame 15-Sekunden-
Budget umfasst Kontrollstand und Mutation; Teil-/Fehlerantworten leeren den
lokalen Stand und fordern zum erneuten Laden auf.

Die Session veröffentlicht ihre eigene Peer-ID ausschließlich aus dem aktuellen
Welcome und löscht sie vor Disconnect-/Leave-Cleanup. Panelende bricht Requests
und den rein lokalen Ablauf-Anzeigetimer ab. Das bestehende Standby-Panel wird
ebenfalls nach Eintritt in die Broadcast-Ansicht nachgeladen, ohne zusätzlichen
Bedienklick oder automatischen Control-Request; das Initial-Hardlimit bleibt
unverändert. Ein tatsächlicher Chromium-Tastaturtest am isolierten aktuellen
Build prüft normalen signierten OIDC-/P-256-Join, Panelöffnung ohne Anfrage,
Laden und Ablehnen derselben serverseitigen Einladung mit genau zwei Requests,
serverbestätigtem Endzustand und null Capture-Aufrufen. Der Program-Publisher
und seine native Admission sind dabei ausdrücklich Test-Fixtures; dies ist
keine produktive Remotequellen-/Decrypt-Abnahme.

### Sicherheitsgrenze für wiederholte Quellenfreigaben

Die noch nicht öffentlich angeschlossene `TrustedDecryptConsentAuthority`
prüft auch bei derselben Request-ID die **aktuelle** Identität, aktive
Raumzugehörigkeit, Quelle, Programm-Epoche, Packager-Zulassung und Lease.
Ein gespeicherter Treffer ersetzt diese Autorisierung nicht. Die Wiederholung
ist zusätzlich an das ursprüngliche Grantor-Konto und dessen konkretes Gerät
gebunden; die Gerätebindung bleibt interner Zustand und erweitert den
öffentlichen Consent-Vertrag nicht.

Widerrufene oder abgelaufene Freigaben werden nicht erneut ausgegeben. Eine
inzwischen kürzere Lease darf keinen länger gültigen alten Consent bestätigen.
Ein erlaubter identischer Aufruf liefert unverändert denselben Consent, ohne
seine Laufzeit zu verlängern oder eine weitere Grant-Auditmeldung zu erzeugen.
Die Negativtests für Autoritätsverlust, fremdes Konto/Gerät und terminale
Freigaben scheiterten vor der Korrektur und bestehen danach. Das ist ein
Domain-Nachweis, noch kein angeschlossener Fremdquellen- oder Decrypt-Pfad.

## Angeschlossene native Übergabe-API

### Keylose Standby-Vormerkung

Das Live-Cockpit bietet „Standby-Geräte vormerken“. Erst „Auswahl vom Server
laden“ liest die aktuelle Auswahl; Panelöffnung und Raumwechsel senden nichts.
Bis zu zwei weitere eigene, online und für den Raum freigegebene Packager sind
per nativer Checkbox wählbar. Speichern verlangt einen eigenen lokalen
Bestätigungsdialog. Alle Geräte abzuwählen und zu bestätigen entfernt die
Vormerkung; nicht mehr geeignete vormerkte Geräte lassen sich weiterhin entfernen.

`POST /api/broadcasts/:programId/native-standby-control` nimmt ausschließlich
`requestVersion: 1` und den Fingerprint des bestehenden Raumgeräts an.
`PUT /api/broadcasts/:programId/native-standbys` ergänzt den expliziten Trigger,
erwartete Programmrevision/-epoche, `expectedStandbyRevision`, maximal zwei
eindeutige `standbyPackagerIds` und das zu prüfende Rendition-/Hardwareprofil.
Die geschlossenen Verträge liegen in `contracts/native-packager/standby-*.v1.schema.json`.

Beide Routen benötigen OIDC, exakten Origin und dieselbe aktive
Creator-Peer-/Gerätebindung wie der laufende Writer. Die Auswahl besitzt eine
separate Compare-and-Swap-Revision; veraltete Änderungen liefern 409. Alle
Kandidaten werden vor einer atomaren Änderung auf aktuelle Kontobindung,
Raumfreigabe, Capability, Health und freie Assignment-Zuordnung geprüft.
Der aktuelle Writer darf nicht gleichzeitig Standby sein.

Die Vormerkung lebt nur im flüchtigen Programmrecord. Sie erstellt **keine**
Lease, kein Assignment, keine Kapazitätsreservierung und kein Agent-Kommando.
Es fließen weder Medien noch Schlüssel. Stop und Ausgabe-Epochenwechsel
verwerfen die gesamte Auswahl. Online-Status und Eignung können sich später
ändern; die Vormerkung autorisiert deshalb keine Übernahme. Der vorhandene
explizite Handoff prüft beim tatsächlichen Wechsel alle Bedingungen erneut.
Automatische Übernahme, Standby-Medienvorwärmung und beliebige Cross-Host-
Origin-Anbindung werden damit nicht behauptet.

Der Browser bricht Metadatenrequests nach 15 Sekunden und bei Scopewechsel ab.
Verspätete Antworten dürfen weder einen anderen Raum noch ein anderes Konto
oder Gerät befüllen. Nach einem unklaren Schreibfehler muss der Serverstand
erneut geladen werden; die Mutation wird nicht automatisch wiederholt.
Registry- und echte lokale HTTP-/WebSocket-Tests prüfen Auswahl, Ablehnung,
Revisionen, unveränderten Writer, fehlendes Standby-Assignment und Handoff-
Invalidierung. Komponenten-/Service-Tests prüfen Bestätigung und Lifecycle;
die zusätzliche physische Accessibility-Abnahme steht noch aus.

Der isolierte Zwei-Packager-Produktionsgate ergänzt vor jeder Übergabe einen
Standby-Schritt mit echten Tastaturaktionen: Laden per Enter, Setzen/Entfernen/
erneutes Setzen per Space und jeweils bestätigtes Speichern per Enter. Er
akzeptiert ausschließlich gleich-originige Antworten des geschlossenen
Control-Vertrags und exakt fortschreitende Standby-Revisionen bei unveränderter
Programmrevision/-epoche. Capture-Aufrufliste, PeerConnection-Anzahl und
Programm-Erstellungen müssen unverändert bleiben. Sechs reine Beobachtertests
prüfen diese Auswertung einschließlich Fehlantwort und unerlaubter Capture-
Änderung; sie ersetzen keinen erfolgreichen tatsächlichen Produktionslauf.

Der erste Versuch nach dem Rollout scheiterte schon beim temporären Keycloak-
Provisioning mit 401; eine getrennte Anmeldung und Cleanup-Prüfung danach waren
erfolgreich. Der nächste Lauf erreichte Standby-Control und Checkboxbedienung,
beobachtete aber keine Antwort auf Speichern. Der Tastatur-Gate wartet jetzt
zusätzlich auf den aktivierten Button: Ein echter lokaler Chromium-Test belegt,
dass `press("Enter")` auf einem deaktivierten Button nicht auf dessen Freigabe
wartet und keinen Klick erzeugt. Fehlende Commit-Antworten werden anhand von
Request-/Dialog-Flags, geschlossenen Transportcodes und begrenzten UI-Codes
unterschieden. Der anschließende isolierte Lauf auf Produktionsrevision
`c20f453` bestand die tatsächliche Standby-Auswahl: Setzen, Entfernen und erneutes
Setzen mit drei bestätigten HTTP-200-Antworten, fortschreitender CAS-Revision und
unverändertem Programm, Capture und Verbindungen. Zwei echte Enrollment-Vorgänge
und dekodierte HLS-Wartebild-/Quellenrückkehr bestanden ebenfalls. Erst der
nachfolgende öffentliche Handoff scheiterte erneut an `net::ERR_NETWORK_CHANGED`;
der Gesamtlauf bleibt Exit 1, nicht Handoff-PASS. Unabhängige Nachprüfung fand
keine Testcontainer, Identity-Volumes, Ausgabe-Ressourcen oder Keycloak-Testnutzer;
der öffentliche Healthcheck meldete null Räume und Teilnehmer.

### Native Handoff-Routen

`POST /api/broadcasts/:programId/native-handoff-control` liefert dem aktuellen
Owner-Gerät den geschlossenen Programm-/Writer-Snapshot. Der Body enthält nur
`requestVersion: 1` und den Fingerprint des bereits P-256-geprüften Raumgeräts.
`POST /api/broadcasts/:programId/native-handoffs` bindet die ausdrücklich
angeforderte Übernahme an diesen Snapshot: `expectedProgramRevision`,
`expectedProgramEpoch`, `expectedFencingRevision`, Ziel-`packagerId`,
`requestedRenditions`, `allowHardwareAcceleration`, `deviceFingerprint`,
`requestVersion: 1` und `trigger: "user-action"`. Der JSON-Schema-Vertrag liegt
unter `contracts/native-packager/handoff.v1.schema.json`.

Beide Routen benötigen OIDC, den exakten Origin und aktive Creator-Membership
derselben Browser-Peer-/Gerätebindung wie die laufende native Publikation.
Zielgerät, Kontobindung, Room-Consent, Health, Capability und freie Kapazität
werden vor dem Eingriff und unmittelbar vor Nachfolgeraktivierung geprüft.

Der `output-restart`-Befehl erhält Programm-ID, Titel, Quellen und Audience.
Er erhöht ausdrücklich Broadcast-/Lease-Epoch, entzieht alle alten Writer und
Grants und weist eine noch nie verwendete opaque Ausgabe-Ressource zu. Alte
HLS-Init-/Segment-URLs werden nicht wiederverwendet. Dann sendet ausschließlich
der Server `assignment-stop` und wartet maximal zwölf Sekunden auf den echten
terminalen `stopped`-ACK. `failed`, Disconnect oder ein verschwundener Eintrag
zählen nicht als bestätigter Stop. Erst danach entsteht ein neues Assignment.
Ein internes, nicht serialisiertes Fortsetzungsobjekt verhindert doppelte oder
gefälschte Abschlüsse. Abort, Deadline, Membership-/Consentverlust und
Zustellfehler enden ohne verspäteten Nachfolgerstart; nach bereits begonnener
Umstellung bleibt die Sendung sichtbar beendet statt unbemerkt zurückzufallen.
Der Abschluss bindet außerdem die exakte vorbereitete Revision, Epoch und
Ausgabe. Das Drain-Budget verwendet zusätzlich eine monotone Uhr. Vor dem
Eingriff werden genügend Plätze im begrenzten Command-Ledger für Nachfolger,
Readiness und terminalen Cleanup reserviert; bei Erschöpfung wird eine weitere
Übergabe abgewiesen, während der laufende Writer noch regulär stoppbar bleibt.
Die Ownership-Prüfung erfolgt vor jedem Blick auf fremden Assignment-State,
sodass private Programme nicht über unterschiedliche Übergabefehler aufgezählt
werden können.

Lokale HTTP-/WebSocket-Tests mit zwei getrennten P-256-Packagern belegen diese
Reihenfolge und einen abgebrochenen HTTP-Aufruf mit verspätetem Stop-ACK.
Ein separater Test prüft den Widerruf eines tatsächlich signierten Playback-
Grants vor Nachfolgeraktivierung. Das ist noch **kein** Nachweis dekodierbarer
Medien über die Übergabe: Origin-Pfad, Browser-Publikationswechsel,
bewusste UI-Bestätigung und kontrollierte Player-Reautorisierung/-Neustart
müssen noch zusammen real geprüft werden. Insbesondere
ist ein Agent auf einem beliebigen anderen Host nicht allein durch seine
Registrierung an den aktuell konfigurierten HLS-Origin angebunden.

### Angular-Publikationswechsel

Während einer nativen Own-Source-Sendung steht unter der stets sichtbaren
Stop-Leiste „Trusted Packager wechseln“. Die Zielauswahl enthält nur andere,
online/gesund gemeldete eigene Geräte mit bestätigtem Room-Consent. Der lokale
Bestätigungsdialog nennt das Ziel, den nicht SFrame-E2EE-geschützten Broadcast-
Zweig, die Unterbrechung und die notwendige Origin-Anbindung. Auswahl allein,
Panelöffnung oder Remotesignale lösen keine Übergabe aus.

Der Workflow lädt einen frischen autoritativen Writer-Snapshot und verwendet
dessen Revisionen. Nach dem bestätigten Serverwechsel stoppt er ausschließlich
die alte lokale Publikation und deren Assignment. Er erstellt **kein** neues
Programm: dieselben bereits laufenden Originalquellen werden für die neue
Programm-Epoch neu geklont/komponiert. Kamera, Mikrofon und Bildschirm werden
nicht erneut angefordert; beendete oder fehlende Quellen brechen den Wechsel ab.
Alte Captions und Kompositionshandles werden beim lokalen Cleanup entfernt.

Ein Gesamtbudget von 75 Sekunden begrenzt Vorbereitung, Drain und Nachfolger-
Readiness. Stop und Sessionwechsel brechen auch den laufenden Coordinator-Start
ab. Nach Fehlern darf der alte Stream nur weiterlaufen, wenn eine erneute,
auf fünf Sekunden begrenzte Serverabfrage denselben frischen Writer/Fence in
derselben Live-/Degraded-Epoch bestätigt. Ein unklarer oder bereits umgestellter
Ausgang führt zu lokalem Cleanup und einem unabhängigen serverseitigen Stop-
Versuch. Fehlgeschlagene Netzwerkzustellung wird nicht als bewiesener Widerruf
ausgegeben. Verspätete Nachrichten anderer Assignments werden ignoriert;
fehlerhafte Nachrichten des aktuellen Assignments bleiben fail-closed.
Unabhängige Cleanup-Aufrufe besitzen eigene Fristen: maximal 15 Sekunden für
Assignment-Stop/Bestätigung und zwölf Sekunden für Program-Stop. Diese
Sicherheitsbereinigung kann über das 75-Sekunden-Startbudget hinauslaufen.

Unit- und Template-Gates prüfen diese Grenzen. Das ist noch kein realer
Medien-Handoff-/Accessibility-Nachweis. Die folgende Player-Erweiterung versucht
die autorisierte Fortsetzung mit Unterbrechung; die Oberfläche verspricht weder
nahtlosen Wechsel noch automatische Standby-Übernahme.

### Kontrollierte Zuschauer-Fortsetzung

`BroadcastViewerWorkflowService` besitzt den Zuschauer-Lifecycle getrennt von
der Oberfläche. Erst der lokale Wiedergabe-Klick erlaubt automatisches Fortsetzen
derselben Sendung. Ein neuer Output benötigt eine frische Autorisierung, dieselbe
Program-ID und Sichtbarkeits-/Playbackpolicy, eine höhere Program-Epoch und
Policy-Revision sowie eine andere opaque Ressource. Alte Cookies und Player
werden geschlossen; bestehende Lautstärke, Stummschaltung, Qualitätsmodus,
manuelle maximale Höhe und Untertitelwahl bleiben erhalten. Ein anderer
Programm-Link startet niemals automatisch. Browser-Autoplayregeln bleiben wirksam.

Die Wiederherstellung versucht höchstens sechs Autorisierungen in 75 Sekunden;
höchstens drei Session-Ersetzungen pro Minute sind erlaubt. 429, Scopewechsel und
unbekannte Fehler lösen keine Wiederholung aus. Stop, Destroy, Logout und
Seitenausblendung brechen Timer und laufende Requests ab. Alte asynchrone
Player-/Caption-Antworten können keinen Nachfolger verändern. Ein fehlgeschlagener
Remote-Widerruf wird nicht als bestätigt ausgegeben; lokal bleibt die Sitzung
geschlossen und ihre Serverberechtigung läuft spätestens mit dem Grant ab.

Nach einer vorübergehenden Unterbrechung darf die Control Plane auch dieselbe
weiterhin laufende Ausgabe erneut autorisieren: Program-ID, Epoch, Policy,
Sichtbarkeit, Playbackmodus und Resource müssen dann exakt gleich bleiben.
Die alte Cookie-Sitzung wird geschlossen und eine **neue** Sitzung angelegt.
Der Player bindet seinen Lifecycle deshalb zusätzlich an die Playback-Session-ID;
auch bei unveränderter Manifest-URL entsteht ein neues MediaSource-Objekt.
Ein bloß wieder erreichbares Manifest, ein alter Cookie oder eine veränderte
Policy genügen nicht. Ohne vorherigen Play-Klick erfolgt keine Wiederaufnahme.

Diese Ergänzung reagiert auf einen realen Fehlversuch: Nach einer einmaligen
404-Autorisierung antwortete die Control Plane wiederholt mit 201 für dieselbe
Sendung; der bisherige Viewer wartete dennoch ausschließlich auf eine höhere
Generation. Lokale Tests prüfen jetzt Wiederaufnahme, folgende normale Renewal,
Ablehnung wiederverwendeter Session-IDs, Offline-Zustand und das gemeinsame
Wiederholungsbudget. `LIVE_PRODUCTION_VIEWER_RECOVERY=1` ergänzt einen realen
isolierten Lauf um genau eine im Testbrowser injizierte Autorisierungsablehnung;
die anschließenden Grants/Cookies müssen vom echten Server stammen und
dekodierte Frames der identischen Ausgabe müssen wieder fortschreiten. Dieser
Fault-Injection-Gate bestand am 2026-09-06 auf Revision `16b25af`: Firefox setzte
mit frischem Servercookie dieselbe Ausgabe fort, behielt den niedrigen
Qualitätsmodus und dekodierte neue Frames ohne zweiten Play-Klick.

Browser-Gateway-Tests prüfen späte open-/renew-Antworten nach close, getrennte
alte/neue Handles und begrenztes Cleanup. Der Server prüft nach asynchroner
Grantvalidierung erneut die aktuelle Session-Identität: paralleles close,
Prune, ID-Neuvergabe und konkurrierende Renewals können keinen alten Eintrag
wiederbeleben. Normale Verlängerung invalidiert nicht unnötig laufende
Medienautorisierungen derselben unveränderten Grant-Scope.

Das optionale Gate `LIVE_PRODUCTION_NATIVE_HANDOFF=1` der isolierten
Produktionssuite provisioniert zwei eigene temporäre native Packager. Es prüft
private und öffentliche Zuschauer-Fortsetzung, Stop-ACK vor Nachfolger-Readiness,
neue tatsächlich abgespielte Ausgabe, alten Manifest-Widerruf und unveränderte
Capture-Aufrufzahl. Beide Agenten werden regulär widerrufen und entfernt.
Das Gate ist erst nach einem erfolgreichen realen Lauf Produktionsnachweis;
sein gemeinsamer Mini-PC-Origin beweist keinen beliebigen Cross-Host-Origin.

### Ausgelieferter Stand und getrennte Produktionsnachweise

Aktuell ausgeliefert ist `c20f4533308ee783807af7c9396f5b51fea965a1`, nach
[allen sieben erfolgreichen CI-Jobs](https://github.com/ananta888/webrtc-minimize-server/actions/runs/34142790479).
Web-App, Native-Packager und HLS-Origin laufen auf genau dieser Revision;
externer Smoke, Identitätserhalt und unabhängiger Artefaktvergleich sind bestanden.
Die fünf Binaries im Image entsprechen dem attestierten CI-Manifest; das
öffentliche Manifest und der Linux-Download sind bytegleich. Manifest-SHA-256:
`b7cd6c8a94d7ac61a756330d56fbea7b999fd6466e339183ba72652f1870cd2d`.
Auth und SFrame bleiben `required`, Maschinenaufnahme bleibt deaktiviert.
Dies ist kein neuer erfolgreicher Handoff-Lauf.

### Mediennachweise auf dem vorherigen Stand

Revision `16b25af54933ee6d17cb30fcdde4da4a5c33df0d` wurde nach
[allen sieben erfolgreichen CI-Jobs](https://github.com/ananta888/webrtc-minimize-server/actions/runs/34051512640)
auf Web-App, Native-Packager und HLS-Origin gemeinsam ausgeliefert. Vor dem
Deployment waren Räume, Teilnehmer und Ausgaben leer; Geräteidentität,
verpflichtende Anmeldung und deaktivierte Maschinenzulassung blieben erhalten.
Alle fünf Binaries stimmen mit attestierter CI überein, ebenso öffentliches
Manifest und Linux-Download. Manifest-SHA-256:
`a51921a42c1a688807d17c1ef9552e1e5e3be54486b25396c1fbcab5030bebda`.

Der reale isolierte Lauf bestand die private Packager-Übergabe und die oben
beschriebene Same-Output-Recovery. Die anschließende öffentliche Rückübergabe
erhielt HTTP 201, aber binnen 90 Sekunden folgte kein neues Zuschauermanifest.
Der Gesamtlauf endete deshalb mit Exit 1. Unabhängige Nachprüfungen bestätigten
null Testcontainer, Test-Identity-Volumes, Ausgaben, temporäre Keycloak-Nutzer,
Räume und Teilnehmer. Die erweiterte Diagnose erfasst beim Manifesttimeout nur
begrenzte Assignment-, Publisher- und Viewer-Zustände; kein vollständiger
öffentlicher Handoff-Nachweis wird aus dem privaten Teilerfolg abgeleitet.

Ein öffentlicher Isolationslauf am 2026-09-07 ohne vorherigen privaten
Zuschauer-Handoff scheiterte schon beim ersten Packager-Verbindungsaufbau:
`native-packager-connection-timeout`, null RTP-Bytes, zuletzt ICE `checking`
und DTLS `new`. Beide Test-Packager waren registriert und online. Dieser
Exit-1-Lauf erreichte die Übergabe nicht und klärt deren Ursache deshalb nicht.
Testkonten, Container und Identitätsvolumes wurden unabhängig als entfernt
bestätigt; Räume und Teilnehmer waren anschließend leer. Die ausschließlich
im isolierten Testbrowser installierte Diagnose ergänzt nun monotones Alter,
SDP-Vorhandensein als Boolean sowie aggregierte ICE-Kandidaten-/Pair-Zustände.
Sie speichert höchstens acht Stichproben für je drei Verbindungen, ohne
SDP-Inhalte, Kandidatenadressen, Credentials oder Identifikatoren.

`LIVE_PRODUCTION_BROADCAST_SCENARIO=public-handoff-only` ist ein getrennter
Diagnoselauf: Er startet direkt öffentlich und benötigt zwei Test-Packager.
Er lässt sich nicht mit privatem Zuschauer oder Refresh-Restore kombinieren.
Sein eigener Ergebnistext schließt Privatwiedergabe, Sichtbarkeitswechsel und
Rückübergabe ausdrücklich aus. Das Standardszenario bleibt `full`; ein Erfolg
dieser Isolation ersetzt dessen noch fehlende Abnahme nicht. Fehlerzustände
werden vor dem Browser-Cleanup auf feste UI-Zustände und begrenzte Codes
reduziert, damit auch ein früher Visibility-Fehler untersuchbar bleibt.

Der erste direkt öffentliche Lauf auf `56cdeb3` bestand Enrollment, Inventar
und dekodierte HLS-Bildregie. Die Handoff-Kontrollabfrage war erfolgreich,
aber die eigentliche schreibende Anfrage brach mit `net::ERR_NETWORK_CHANGED`
ab. Eine angenommene Übergabe oder Zuschauerfortsetzung ist damit nicht
nachgewiesen. Die Suite endete mit Exit 1, wiederholte den schreibenden Aufruf
nicht automatisch und entfernte ihre Testressourcen; die separate Kontrolle
fand keine Testcontainer, Identitätsvolumes, Keycloak-Testnutzer oder Teilnehmer.

Die folgenden Einträge dokumentieren frühere Revisionen und deren jeweilige
Nachweisgrenzen; sie sind keine Angaben zur aktuell ausgelieferten Version.

Revision `f6be45be8ca4586f378c51ed3caa551fe91f15cb` wurde am 2026-09-06 nach
[allen sieben erfolgreichen CI-Gates](https://github.com/ananta888/webrtc-minimize-server/actions/runs/34044416649)
auf `webrtc.ananta.de` ausgerollt. Web-App, nativer Packager und HLS-Origin
liefen auf dieser identischen Revision. Die Umschaltung erfolgte ohne aktive
Teilnehmer oder Broadcast-Ausgabe; der persistente Geräteschlüssel blieb
unverändert. OIDC bleibt `required`, Maschinenzulassung default-aus.

Das Image enthält dieselben fünf Binärdateien wie die unabhängig attestierten
CI-Artefakte. Das öffentliche Release-Manifest ist bytegleich; sein SHA-256 ist
`c29469c519b2e2c538677c6509dec2d82671be94db179bc9f7db358d7d95d3d0`.
Auch der öffentliche Linux-amd64-Download wurde gegen dieses Manifest geprüft.

Die isolierte Produktionssuite bestand anschließend mit synthetischer
Chromium-Publikation, dekodierter lokaler HLS-Bildregie, privaten und anonymen
Firefox-Zuschauern, Session-Renewal, terminalem Stop, Refresh ohne automatischen
Capture-Neustart und normalem Packager-Widerruf. Die unabhängige Nachprüfung
fand null Testcontainer, Test-Identity-Volumes, Ausgabe-Ressourcen und temporäre
Keycloak-Testnutzer. Das belegt den unverändert funktionierenden **einzelnen**
Packager-Pfad auf dem neuen Release, nicht den weiterhin ausstehenden realen
Zwei-Packager-Medienwechsel.

Revision `0e37b9911d1727aee3052b41b4810eadc4d4e8ad` folgte am 2026-09-06 nach
[allen sieben erfolgreichen CI-Gates](https://github.com/ananta888/webrtc-minimize-server/actions/runs/34046987480)
auf allen drei Diensten. Der Vorab-Build erfolgte ohne Dienstwechsel; vor der
Aktivierung waren Räume, Teilnehmer und Ausgaben leer. Die externe Readiness
bestand, der native Geräteschlüssel blieb unverändert, OIDC `required` und
Maschinenzulassung ausgeschaltet. Alle fünf Image-Binaries stimmen mit den
unabhängig attestierten CI-Dateien überein. Das öffentliche Manifest ist
bytegleich (SHA-256 `22d3f507460e52561f70c8ae7bf7b2bff79a2a61c98b81be67aa24cc888dd473`),
ebenso der separat geprüfte Linux-amd64-Download.

Ein isolierter Ein-Packager-Produktionslauf auf diesem Release bestand mit
privaten und anonymen Firefox-Zuschauern, dekodierter Bildregie, Renewal, Stop,
Refresh/Restore und normalem Widerruf. Der erste Zwei-Packager-Lauf scheiterte
vor dem Handoff an `native-packager-output-timeout`. Ein zweiter erreichte die
fertige Publikation, scheiterte beim Playback-Bootstrap aber an einem realen
Chromium-`ERR_NETWORK_CHANGED`. Gleichzeitig ausgeführte lokale Docker-Tests
sind dafür eine plausible, nicht bewiesene Ursache. Diese Fehler bleiben
verzeichnet; sie werden weder als erfolgreicher Handoff noch als endgültig
diagnostizierter Produktfehler gewertet. Weitere Mediengates laufen getrennt
von lokalen Container-Tests. Die Testfixture sammelt nur begrenzte ICE-/DTLS-
Zustände und RTP-Zähler, keine Adressen, SDP, Token oder Medieninhalte.

Ein dritter Zwei-Packager-Lauf ohne parallele lokale Container-Tests endete
bereits beim OIDC-Login, vor Capture und Publikation. Die Quellprüfung zeigt
eine dazu passende offene UI-Start-Race: Der sichtbare Login-Schalter prüft
bislang nur `auth.busy()`, während `auth.configure()` erst nach dem asynchronen
Laden von `/config` aufgerufen wird. Dieser Befund ist noch kein Beweis, dass
alle drei unterschiedlichen Fehlversuche dieselbe Ursache haben. Die
Runtime-/Login-Bereitschaft muss separat gehärtet und getestet werden, bevor
der Zwei-Packager-Nachweis erneut bewertet wird.

Die folgende Runtime-/Login-Härtung ist inzwischen lokal implementiert:
Anmelde- und Registrierungsbuttons benötigen explizite Auth-Bereitschaft.
Auch ein direkter Methodenaufruf vor Konfiguration oder bei deaktiviertem OIDC
endet ohne Request, Redirect oder PKCE-Transaktion in einem sichtbaren,
begrenzten Fehler. Eine laufende Anmeldung blockiert konkurrierende Starts;
ein Konfigurationswechsel während Discovery oder PKCE-Erzeugung verhindert
die Verwendung des alten Auth-Snapshots. Runtime und Discovery besitzen
15-Sekunden-Fristen und akzeptieren keine nach Ablauf gelieferten Bodies.
Fehlgeschlagener Runtime-Start bietet ausschließlich einen lokalen Seiten-
Reload; dessen Abschluss startet weder Login noch Capture automatisch.

Die Produktionsfixtures warten nun auf den ausdrücklich gesetzten
`runtime-config-status[data-state=ready]`, nicht auf bloße Login-Button-
Sichtbarkeit. Vier echte Chromium-/Firefox-Fälle mit verzögerter bzw.
fehlgeschlagener Config und lokalem Reload bestanden ohne Capture, Redirect
oder PKCE-State. Zwölf gezielte Service-Tests bestehen einschließlich der
bestehenden PKCE-URL-Fälle. Dieser lokale Nachweis ersetzt noch nicht das
Deployment bzw. den weiterhin offenen Zwei-Packager-Mediennachweis.

Nach terminalem Ende aller Läufe bestätigte eine unabhängige Prüfung null
Testcontainer, Test-Identity-Volumes, `res_`-Ausgaben und temporäre Keycloak-
Gate-Nutzer. Health meldete `ok`, null Räume und null Teilnehmer. Es wurden
ausschließlich die von der Suite angelegten Testressourcen entfernt; bestehende
kontogebundene Agenten und ihre Identitäten blieben erhalten.

### Ausgelieferte Runtime-Härtung und private Handoff-Evidence

`cb0b0562845b4df349f41ecad3a7a97eaf9421f5` wurde nach
[allen sieben erfolgreichen CI-Gates](https://github.com/ananta888/webrtc-minimize-server/actions/runs/34049122053)
auf Web-App, Native-Packager und Origin ausgerollt. Vorher waren Räume,
Teilnehmer und Ausgaben leer; danach waren externe Health/Readiness grün.
Der Geräteschlüssel blieb identisch, OIDC `required`, Maschinenzulassung aus.
Alle fünf Image-Binaries entsprechen den unabhängig attestierten CI-Dateien;
öffentliches Manifest und Linux-amd64-Download sind byte-/hashgleich.
Manifest-SHA-256: `b937fb65c97f277d94802b49eda91f75f550cdea562f5569785145a440291aa0`.

Drei isolierte Läufe auf diesem Release bestätigten normale Anmeldung,
Enrollment/Inventar zweier Testagenten, dekodierte Regie und private Firefox-
Übergabe derselben Sendung. Die zwei späteren Läufe prüften zusätzlich den
Fortschritt des Video-Framezählers nach Wechsel des MediaSource-Objekts.
Stop-ACK des Vorgängers, höhere Epoch/Fence, neue Ressource, Widerruf der alten
Manifest-URL, erhaltene Qualitätswahl sowie ausbleibender neuer Capture- oder
Play-Klick wurden geprüft. Beide nativen Agenten nutzten den gemeinsamen
Mini-PC-Origin; das ist **kein** Cross-Host-Origin-Nachweis.

Alle drei Gesamtläufe endeten trotzdem mit Fehler: zweimal fehlte die
Handoff-Antwort bei der späteren öffentlichen Rückübergabe; beim dritten Lauf
scheiterte zuvor das anonyme Renewal an der oben beschriebenen Same-Resource-
Recovery-Lücke. Die neue Diagnose trennt abgewiesene Kontrollantwort, fehlenden
Request, Transportfehler, abgewiesene Mutation und fehlende neue Medien.
Vier reine Unit-Tests prüfen diese Diagnose ohne vorgetäuschte Real-PASS-Logs.
Nach Ende der Läufe fand die unabhängige Kontrolle null Testcontainer,
Testvolumes, Ausgaben und temporäre Keycloak-Nutzer; ein kurzzeitig nicht
routbarer Mini-PC-SSH-Pfad war wieder erreichbar, Health war `ok` mit null
Räumen/Teilnehmern. Die Same-Resource-Recovery ist eine **nachfolgende lokale**
Änderung und wird diesem ausgelieferten Release nicht rückwirkend zugeschrieben.

## Bereits angeschlossene lokale Bildregie

Während einer aktiven Own-Source-Sendung zeigt die Angular-Regie die bereits
freigegebenen eigenen Videoquellen. „Layout sofort anwenden“ wechselt zwischen
allen sieben Layouts. Einzel-/Sprecheransicht erlauben die manuelle Hauptquelle;
eine automatische Sprechererkennung wird nicht behauptet. Der lokale Klick
ändert ausschließlich die Darstellung der bestehenden Komposition, nicht ihre
Quellfreigaben, Writer-Zuordnung oder Ausgabeprofile.

Kompositions-ID, vollständige Quellbindung und eine lokale Revision schützen vor
veralteten Befehlen. Stopp/Destroy entfernt das Angebot sofort. Es gibt keinen
erneuten Capture-Aufruf, Program-POST oder Wechsel der Sendertracks. Warte-/Endbild
ändert nur Video; Audio und Publikation laufen bis zum separaten Stopp weiter.
Der Broadcast-Zweig bleibt ausdrücklich ein Trusted-Packager-Pfad, kein blinder
SFrame-Relay. Siehe [Compositor und gemessene Gates](trusted-video-compositor.md).

Die folgenden Rollen-, Consent- und Handoff-Abschnitte beschreiben weiterhin die
vorbereitete, noch nicht vollständig produktiv verdrahtete Servermoderation.
Ihre Schalter bleiben getrennt von der lokalen Bildregie deaktiviert.

## Rollen und Bestätigung

- Owner und Moderator dürfen Quellen anfragen oder entfernen, Layout ändern,
  Packager und Standbys auswählen, Handoffs anstoßen und die Sendung beenden.
- Presenter dürfen nur ihre eigene Quelle veröffentlichen oder widerrufen.
- Packager erhalten ausschließlich die eng gebundene Writer-Operation; Viewer
  erhalten keine Regierechte.
- Jede UI-Aktion benötigt einen konkreten lokalen Klick und eine zweite,
  höchstens zwei Minuten gültige Bestätigung. Request und Bestätigung binden
  Tenant, Raum, Programm, Rolle, Subject, Programmrevision und Program-Epoche.
  Ein Handoff bindet zusätzlich die Lease-Epoche.
- Stale Revision, Program-Epoche oder Lease-Epoche ist ein sichtbarer Konflikt.
  Die UI darf die Aktion nicht still gegen einen neueren Stand wiederholen.

### Browser-/Server-Vertrag und begrenzter Lebenszyklus

Das lokale `targetLabel` bleibt ausschließlich im Bestätigungsdialog und wird
nicht in den geschlossenen Server-Envelope übernommen. Jede der acht Aktionen
erlaubt nur ihre eigenen Pflichtfelder. Snapshot und Adapterergebnis werden
ebenfalls typstreng und geschlossen geprüft; rückläufige Revisionen/Epochen
sind keine gültigen Ergebnisse. Ein gemeinsamer Vertragstest kompiliert den
tatsächlichen Browserworkflow und übergibt seine serialisierten Nachrichten an
die produktive Serverpolicy. Er beweist Vertragskompatibilität, keine bereits
angeschlossene HTTP-Route oder vollzogene Writer-Übergabe.

Es gibt genau eine aktive Aktion pro Workflow mit einem standardmäßig zehn
Sekunden langen Gesamtbudget einschließlich lokalem Quellenstopp. Beide Ports
erhalten dasselbe AbortSignal. Destroy beendet auch bei ignorierendem Adapter
die lokale Warteoperation und ist terminal; verspätete Antworten dürfen keine
Folgeaktion oder erfolgreiche UI-Rückmeldung erzeugen. Nach ausstehendem lokalen
Widerruf wird vor dem Netzwerk nochmals die Bestätigungsfrist geprüft.

Ein Timeout während des Serveraufrufs beweist **keinen** Rollback: Die zukünftige
HTTP-Anbindung muss den autoritativen Stand neu laden und für einen weiteren
Versuch eine neue Bestätigung verlangen. Sie darf einen unklaren Ausgang nicht
als erfolgreiche Rücknahme darstellen. Die lokale Safety-Implementierung muss
selbst synchron fencen und ihr Cleanup abbrechbar ausführen; das Zeitlimit dieses
Workflows kann einen fehlerhaften externen Adapter nicht rückwirkend stoppen.

## Sofortiger eigener Quellenwiderruf

Der lokale Sicherheitsport läuft vor dem Netzwerkaufruf. Dadurch bleibt der
Widerruf auch dann lokal wirksam, wenn die Control Plane gerade nicht erreichbar
ist. Der verbindliche Effektplan lautet:

1. Eingang der Quelle fencen und den lokalen Broadcast-Klon stoppen,
2. quellengebundenes Decrypt-Material widerrufen,
3. Decoder zerstören,
4. Compositor-Fläche vollständig löschen,
5. auf ein neutrales Slate wechseln oder das Layout ohne Quelle neu setzen,
6. verbleibende Quell-Grants widerrufen.

`retainLastDecodedFrame` ist immer `false`. Weder ein eingefrorener letzter
Frame noch ein versteckter Audiozweig darf nach dem Widerruf weiterlaufen.

## Native-Packager-Auswahl

Die Kandidatenpolicy akzeptiert höchstens 16 aktuelle Capability-Reports und
filtert vor der Auswahl:

- exakt denselben Tenant und denselben Kontoinhaber,
- expliziten Consent für genau den aktuellen Raum,
- Operator-Allowlist,
- `healthy`, ausreichende Uploadklasse und die verlangte Energieklasse,
- AAC plus `libx264` als Software-Fallback,
- CPU-, Pixel-, Rendition- und optionale Hardwareencoder-Grenzen.

Regie und Kandidatenpolicy akzeptieren die tatsächlich registrierten
`pkr_…`-Geräte-IDs sowie kompatibel die bisherigen kurzen Agent-Slugs.
Ein passendes ID-Format allein verleiht keine Freigabe: Owner, Tenant, Raum,
Consent, Operatorpolicy und Capability müssen weiterhin übereinstimmen.
Array-Coercion ist verboten; die nächste Fencing-Revision darf den sicheren
Ganzzahlbereich nicht überschreiten.

Aus den verbleibenden Kandidaten wird genau ein aktiver Writer gewählt. Er
erhält die nächste Fencing-Revision und darf nach separatem Quellenconsent die
nötigen Decrypt-Schlüssel erhalten. Höchstens zwei Standbys werden als
`warm-no-media-key` geführt und erhalten keine Decrypt-Schlüssel. Der Schritt
ist eine Trusted-Packager-Policy und verwendet ausdrücklich nicht die bereits
installierten blinden Media-/Relay-Agenten.

## Inhaltsfreies Audit

Das begrenzte Audit hält höchstens 256 Datensätze mit Aktion, pseudonymen
Tenant-/Room-/Program-/Subject-Referenzen, erwarteter Revision/Epoche, Ergebnis,
Fehlercode und Zeitpunkt. Namen, Labels, SDP/ICE, Captions, Schlüssel,
Audio-/Videodaten und Nutzinhalte gehören nicht hinein.
Referenzen, Revisionen, Zeit und Fehlercode werden vor Aufnahme typstreng und
längenbegrenzt geprüft. Unbekannte/prototypgeerbte Aktionen, Array-Coercion oder
Rohtext als Identität erzeugen keinen Auditdatensatz; zusätzliche lokale Labels
und Nutzlastfelder werden nicht übernommen. Die künftige HTTP-Anbindung darf
abgewiesene Rohrequests nicht ungeprüft als Auditereignisse weiterreichen.

## Noch offene Gates

- OIDC- und Membership-gebundene Moderations-API sowie serverseitige
  Composition-Root; Raum-/Medienzustand bleibt flüchtig,
- verbleibende Plattform-/Keystore-/Betriebsgates aus TBP-016; Enrollment und
  nativer Publish-/Playback-Pfad sind bereits separat implementiert und getestet,
- vollständige Verdrahtung der serverseitigen Angular-Regie mit Serverzustand,
  Consent-Authority, Writer-Lease und Program-Compositor,
- echte Handoff-/Lease-Loss-/Netzunterbrechungstests mit zwei Geräten,
- manueller Tastatur-, Fokus-, Screenreader- und Mobile-Accessibility-Gate.

Bis diese Punkte bestehen, bleibt `[connected]="false"` für die Servermoderation
die öffentliche Voreinstellung. Die unabhängig angebundene lokale Bildregie
meldet ausdrücklich „Lokale Bildregie bereit“, nicht „Control Plane verbunden“.
Weder Sendestart noch Regieaktion werden simuliert; ein Stop mit Neuanlage gilt
nicht als vollständiges Writer-Handoff.
