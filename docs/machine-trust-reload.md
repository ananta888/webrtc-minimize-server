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
Der Produktions-Init-Prozess soll das Signal an Node weiterleiten; die reale
Containerabnahme folgt getrennt. Nicht an alte oder nicht aktivierte Dienste
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
nicht Auth deaktiviert. Beim Compose-Test wurde die erwartete Darstellung von
`create_host_path: false` korrigiert, nicht die Absicherung entfernt.
Gemeinsame Browser-, Agent-, TURN- und Langzeitabnahme folgen gebündelt.
