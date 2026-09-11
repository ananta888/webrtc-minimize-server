# Operator-gesteuerter Live-Reload des Hub-Trusts

Der optionale Maschinenpfad erlaubt Schlüsselrotation und Entzug exakter
Subject-/Tenant-/Projekt-/Capability-Scope ohne Neustart menschlicher Räume.
Er lädt ausschließlich die schon vom Betreiber ausgewählte öffentliche Datei.
Keine HTTP-Adminroute, Fernkonfiguration, JWKS-Suche, Dateibeobachtung oder
automatische produktive Aktivierung. Hub-Privatschlüssel bleiben im Hub.

## Lokaler Node-Dienst

`MACHINE_HUB_TRUST_RELOAD=signal` benötigt eine absolute
`MACHINE_HUB_TRUST_PROFILE_JSON_FILE`. Inline-Profile und Legacy-Key/Issuer
sind damit unzulässig. Ohne diese Einstellung bleibt der statische Startpfad.
Erst `startServer()` bindet den POSIX-Signalhandler; ein eingebetteter
`createAppServer()` registriert keine globalen Prozesshandler. Beim Schließen
wird nur der eigene Handler entfernt.

Nach atomarem Austausch der fertig geschriebenen Datei kann der Betreiber dem
betreffenden Node-Prozess SIGHUP senden, nicht einem beliebigen Shell-/npm-
Elternprozess. Die Antwort im Dienstlog enthält ausschließlich:

```json
{"schema":"ananta.meet-trust-reload.v1","status":"updated"}
```

Weitere feste Zustände sind `unchanged` und `blocked`. Keine Profile, Grants,
Dateipfade, Schlüssel, Projekte oder Rohfehler werden ausgegeben.

## Revisionen und Widerruf

- Der HTTPS-Issuer bleibt für die laufende Instanz unveränderlich. Ein Wechsel
  benötigt einen bewussten Neustart mit neuer Betreiberkonfiguration.
- Höhere valide Revisionen ersetzen das Profil synchron. Ein identisches
  aktuell gültiges Profil ist idempotent; der Replaycache bleibt erhalten.
- Eine niedrigere Revision, geänderter Inhalt unter derselben Revision oder ein
  Lese-/Validierungsfehler sperrt die gesamte Maschinenaufnahme. Wiederaufnahme
  verlangt eine gültige Revision oberhalb der zuletzt akzeptierten Revision.
- Eine während der JWT-Prüfung ersetzte Policy lässt das alte Ergebnis nicht
  mehr zu. Eine frühere Signaturprüfung allein erzeugt keine neue Autorität.
- Bestehende und noch nicht angehängte Leases behalten private, flüchtige
  Verifikationsevidenz. Key-ID und Schlüsselmaterial, Audience, gesamtes
  Grant-Zeitfenster und exakte Scope müssen weiterhin passen.
- Entzug eines Grant-Rechts beendet die ganze betroffene Maschinen-Lease;
  eine bestehende Identität wird nicht still auf weniger Rechte umgedeutet.
  Normale Membership-Entfernung erfolgt vor dem Reload-ACK. Der vorhandene
  Socket-Cleanup beendet unkooperative Verbindungen nach seinem Ein-Sekunden-
  Budget. Zulässige Maschinen und Human-OIDC bleiben unberührt. Ein fehlerhafter
  Detach-Port kann die Membership-Entfernung nicht garantieren; Lease-Autorität
  und Socket werden dennoch widerrufen.

Persönliche Quellenfreigaben, Geräteschlüssel und Raumkapazität ändern sich
nicht. Reaktivierung eines Profils stellt keine entfernte Sitzung wieder her;
der Hub benötigt einen neuen autorisierten Ablauf. Bereits entschlüsselte
Inhalte können nicht zurückgerufen werden. Browserabnahme des Medienstopps
bleibt zusätzlich erforderlich.

Die Revision ist eine instanzlokale Schranke, keine persistente Anti-Rollback-
Marke. Nach Neustart ist die operatorseitige Datei wieder die Startautorität.
Dateisystem-, Release- und Backup-Policy müssen deren Aktualität absichern.

## Reproduzierbares Docker-Deployment

Ein einzelner bind-gemounteter Dateiinode folgt einem atomaren Host-`rename`
nicht zuverlässig. Deshalb gibt es einen eigenen expliziten Modus:

```dotenv
MACHINE_DEPLOYMENT_MODE=profile-reload
MACHINE_HUB_TRUST_PROFILE_DIRECTORY=/etc/ananta/meet-public-trust
MACHINE_HUB_TRUST_PROFILE_JSON_FILE=/etc/ananta/meet-public-trust/machine-trust.json
MACHINE_ALLOWED_CAPABILITIES=chat.read,chat.send
```

Der Selektor fordert exakt `machine-trust.json` innerhalb des absoluten
Verzeichnisses und prüft das öffentliche Profil vor Docker-Mutationen. Die
Datei muss schon vorhanden und für den Dienst lesbar sein. Das Verzeichnis
ist ausschließlich für öffentliche Trust-Dateien bestimmt, betreiberverwaltet
und nicht dienstseitig schreibbar; keine privaten Schlüssel oder Secrets dort.

`production-deploy.sh` wählt `compose.machine-profile-reload.yaml`. Nur die
Web-Control-Plane erhält das Verzeichnis read-only unter `/run/machine-trust`;
Docker darf keinen fehlenden Hostpfad anlegen. Node liest darin
`machine-trust.json`. Der Modus bleibt bei Deploy und Rollback ausgewählt.

Der Runner verlangt für Kandidat und Rücksprungimage den Capability-Marker
`io.ananta.meet.trust-reload=sighup-v1`. Ein inkompatibler laufender Vorgänger
wird schon vor Build/Aktivierung abgewiesen, ein inkompatibler Rücksprungsatz
vor Dienständerungen. Daher zunächst neue Software im bisherigen statischen
Modus deployen und prüfen; erst im nächsten bewussten Schritt den Live-Modus
aktivieren. Der Marker im eigenen attestierten Image ist eine deklarierte
Versionsfähigkeit, kein Ersatz für den tatsächlichen Signal-/Containertest.

Erst nach Deployment einer Version mit diesem Signalhandler, Prüfung des
aktivierten Modus und atomarem Dateiaustausch darf der Betreiber mit denselben
Compose-Dateien `docker compose … kill --signal SIGHUP webrtc` ausführen.
Der Produktions-Init-Prozess muss das Signal an Node weiterleiten; der unten
beschriebene isolierte Image-Test prüft diesen Pfad. Nicht an alte oder nicht aktivierte Dienste
senden: Deren Standard-SIGHUP kann sie beenden. Ein bewusstes Rollback auf Software vor
Einführung dieses Pfads benötigt vorher einen Wechsel zu statischem `profile`
und reguläres Neuanlegen des Dienstes. Software-Rollback setzt weder Trust-Datei
noch Betreiberpolicy zurück.

Windows-Prozessbetrieb besitzt keinen portablen SIGHUP-Pfad; dort bleibt der
bewusste Dienstneustart erforderlich. Linux-Container unter Windows sind
getrennt. Keine aktuelle Produktionsaktivierung wird hier behauptet.

## Gezielte Verifikation

Node-Tests verwenden kurzlebige echte Ed25519-Signaturen und P-256-Proofs,
keine Browser oder Audiogeräte. Geprüft sind Scope-/Capability-/Audience-/Key-
Entzug, Schlüsselmaterialwechsel unter gleicher ID, Replay, schwebende
Verifikation, ungültige Profile, Wiederaufnahme, ausstehende Tickets und
Human-OIDC. Ein Node-Unterprozess prüft reale SIGHUP-Signale und atomare
Dateiersetzung. Compose-Rendering und begrenzte Deployment-Runner-Tests prüfen
Auswahl und Rückweg ohne Produktionsmutation. Die erste Signal-Fixture hatte
fehlende explizite OIDC-Konfiguration; die Testidentität wurde vervollständigt,
nicht Auth deaktiviert.

### Compose-Darstellung und tatsächliche Mount-Sicherheit

Die YAML-Quelle muss ausdrücklich `bind.create_host_path: false` enthalten.
Docker beschreibt diese [Absicherung für lange Bind-Mount-Syntax](https://docs.docker.com/reference/compose-file/services/#long-syntax-5).
Im [compose-go-v2.9.1-Modell](https://github.com/compose-spec/compose-go/blob/v2.9.1/types/types.go)
wird das boolesche Feld mit `json:"create_host_path,omitempty"` serialisiert;
ein gerendertes `bind: {}` ist deshalb dort mit explizitem `false` vereinbar.
Der Regressionstest akzeptiert nur diese beiden JSON-Formen, prüft die
explizite YAML-Policy unabhängig und lehnt `true`, `null`, Strings, fremde
Bind-Optionen oder abweichende Source-/Target-/Read-only-Felder ab.
Ein echter CLI-Negativtest bestätigt zusätzlich: Fehlt das eigene
Test-Trust-Verzeichnis, endet der Selektor mit seinem festen Fehlercode,
ohne es anzulegen oder den Pfad auszugeben.

### Isolierter Linux-Container-Test

```bash
RUN_MACHINE_TRUST_CONTAINER_TEST=1 \
MACHINE_TRUST_CONTAINER_IMAGE=<lokales-produktionsimage> \
MACHINE_TRUST_CONTAINER_EXPECTED_REVISION="$(git rev-parse HEAD)" \
node --test test/machine-trust-container.test.js
```

Das Image muss lokal vorliegen. Der Test pinnt seine Image-ID, prüft Revision,
Reload-Marker, Benutzer und Node-CMD. Er startet ausschließlich sein zufällig
benanntes Compose-Projekt mit `network_mode: none`, ohne veröffentlichte Ports,
mit flüchtigen Testidentitäten und In-Memory-Stores. Der echte Reload-Override
wird unverändert eingemischt. Getestet werden:

- fehlender Hostpfad: konkrete Mount-Ablehnung, kein neu angelegtes Verzeichnis;
- vorhandenes öffentliches Profil: read-only, auch ein Root-Schreibversuch scheitert mit `EROFS`;
- reales `docker compose kill --signal SIGHUP`, Init-Weiterleitung und exakt ein festes ACK;
- atomarer Host-Dateiersatz, Scopeentzug, ungültiges Profil und Revisionsrückschritt;
- Wiederaufnahme nur mit höherer gültiger Revision, unveränderter Prozess/Container und kein Restart.

Begrenzte Docker-Aufrufe und eigener Cleanup entfernen nur die Testressourcen.
Ohne explizite Aktivierung meldet der normale Node-Testlauf einen sichtbaren
Skip. Im Docker-CI-Job ist der Test dagegen verpflichtend: ein gecachter Build
derselben Revision wird geladen, das gebaute Image ohne Source-Mount geprüft.
Das ist kein Vergleich der Archivbytes mit dem separat geprüften OCI-Archiv.

Für einen kurzen Entwicklungscheck darf ausdrücklich
`MACHINE_TRUST_CONTAINER_SOURCE_FIXTURE=1` mit `MACHINE_TRUST_CONTAINER_IMAGE=node:22-alpine`
gesetzt werden. Dann werden nur Projektquellen, Contracts und Node-Abhängigkeiten
read-only eingebunden; der Bericht lautet `source-mounted-runtime`, nicht
`production-image-runtime`. Dieser Pfad bestand lokal am 11.09.2026 in 6,53 s.
Die erste Fixture scheiterte an der nicht bereitgestellten Standard-Datenbank;
explizite In-Memory-Teststores beheben dies ohne produktive DB-Änderung.
Die echte Image-Abnahme bestand am 11.09.2026 für `2ae0445` im
[Docker-Job der CI 34548642305](https://github.com/ananta888/webrtc-minimize-server/actions/runs/34548642305/job/103109083794):
zwei Prüfungen, kein Skip, 9,148 Sekunden. Der Bericht bestätigt ausdrücklich
`production-image-runtime`, fehlenden Hostpfad abgewiesen, Read-only,
Init-Signalweiterleitung, atomaren Austausch, ungültige und alte Revisionen
abgewiesen sowie Wiederaufnahme mit höherer Revision ohne Prozesswechsel.
Auch Artefaktvergleich und OCI-Canary-Scan dieses Jobs bestanden.

Die Gesamt-CI blieb wegen des separaten Ananta-TURN-Proxy-Startfehlers rot.
Weder dieser Image-Test noch ein grüner Healthcheck aktiviert produktiven
Hub-/Projekttrust oder beweist Hub-Dialog, Medienstopps und Netzwerk-/TURN-Verhalten.

Gemeinsame Browser-, Agent-, TURN- und Langzeitabnahme folgen gebündelt.
