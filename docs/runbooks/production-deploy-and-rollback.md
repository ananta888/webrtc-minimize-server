# Runbook: Produktionsdeployment und Rollback

Aktueller dokumentierter Software-Rollout: `76e8866` am 8. September 2026 nach
CI 34275497102 (alle sieben Jobs grün). Alle drei Dienste, Native-Preflight,
externer Smoke und Identitätserhalt sind geprüft; Snapshot
`image-set-v1` / `rollback.VAm8DR` bewahrt den vorherigen Satz (`219e4ef`).
Maschinenaufnahme bleibt ausgeschaltet. Die unabhängige öffentliche Release-
und UI-Prüfung ist unter [Ananta-Betreiberstatus](../machine-admission-status.md)
dokumentiert. Dies ist kein neuer Rollback-/Medien- oder Hub-Trust-Drill.

1. `git status --short` muss leer sein; `npm run check` und CI müssen grün sein.
2. Secret-Dateien ausschließlich root-/service-lesbar außerhalb des Repositories ablegen und über `*_FILE` referenzieren.
   Maschinenaufnahme bleibt standardmäßig aus. Für bereits vorautorisierten Hub-Trust zuerst die [explizite Legacy-/Profil-Auswahl](../machine-production-compose.md) konfigurieren und `node scripts/machine-deployment-config.mjs` prüfen. Das strukturelle Ergebnis ersetzt weder den versionierten Rollout-Preflight noch Projekt-/Raumfreigaben.
3. Firewall gegen `infra/deployment/port-firewall-matrix.v1.json` prüfen. Keine Broadcast-/MoQ-Ports ohne aktivierte Capability öffnen. Die Produktions-Compose-Datei startet den digest-fixierten Egress-Guard und wartet auf dessen Healthcheck; geänderte OIDC-, Control- oder TURN-Hostnamen müssen zugleich in `WEBRTC_CONTROL_EGRESS_HTTPS_HOSTS`, `WEBRTC_PACKAGER_EGRESS_HTTPS_HOSTS` beziehungsweise `WEBRTC_PACKAGER_EGRESS_TURN_HOSTS` gesetzt werden.
4. `WEBRTC_REVERSE_PROXY_NETWORK=bbb-edge PRODUCTION_ORIGIN=https://webrtc.ananta.de scripts/production-deploy.sh deploy` ausführen.
5. Ausgabe des externen Smoke-Gates und `docker compose ... ps` prüfen. Der Runner übergibt den erwarteten Native-Broadcast-Zustand; bei aktivem Native-Pfad müssen Agent und interner Origin in `/readyz` gesund sein, sonst erfolgt Rollback. Private/public Broadcastwiedergabe und Stop/Cleanup nur testen, wenn Broadcast ausdrücklich aktiviert ist; dabei keine Inhalte oder Tokens aufzeichnen.
6. Bei später erkannter Regression `scripts/production-deploy.sh rollback` ausführen. Danach `/healthz`, `/readyz`, `/config`, Login, Raumbeitritt, Medien-Stopp und Leave-Cleanup prüfen.
7. Fehler nur mit Commit, Image-Digest, Zeit, anonymisiertem Alertcode und Readiness-Komponente dokumentieren. Keine Tokens, Raumcodes, IPs, SDP/ICE, Medien oder Captions erfassen.

Der Docker-Buildkontext schließt `.deploy`, Laufzeit-`data`, `.env`-Varianten,
Private-Key-/Zertifikatscontainer (`pem`, `key`, `p12`, `pfx`) sowie verschachtelte
Git-/Dependency-Verzeichnisse aus. `.env.example` bleibt als öffentliche Vorlage
erlaubt. Das ersetzt keine sichere Secret-Ablage: Andere Secret-Dateinamen
gehören ebenfalls außerhalb des Buildkontexts. Der echte Scratch-Build in
`test/docker-build-context.test.js` prüft mit ausschließlich synthetischen
Canaries, dass Docker diese Dateien schon vor `COPY` herausfiltert und normale
Quellen erhält. Die Produktionsimages verwenden zusätzlich explizite COPY-Pfade.

Der produktive Caddy-Virtual-Host muss inhaltlich
`infra/reverse-proxy/Caddyfile.webrtc.production` entsprechen. Vor Reload mit
`caddy validate` prüfen; danach müssen GET `/healthz`, der WebSocket-Upgrade
und OIDC weiter funktionieren, während TRACE/CONNECT 405 liefern und ein
Request-Body über dem kleineren anwendbaren Caddy-/Node-Limit verworfen wird
(die Node-JSON-Grenze antwortet bereits vor 256 KiB mit 400). Gateway-API,
Metrics und Debugpfade dürfen nicht zum MediaMTX-Container geroutet werden.

Nach einem Netzwerk- oder DNS-Wechsel zeigt folgender Check ausschließlich die
Regelstruktur und Paketzaehler, keine Secrets:

```bash
docker compose -f compose.yaml \
  -f infra/reverse-proxy/compose.caddy-network.yaml \
  -f infra/deployment/compose.production.yaml \
  exec production-egress-firewall \
  sh /opt/ananta/production-egress-firewall.sh verify
```

Ein neuer HTTPS-Aufbau von der Control Plane zu einem nicht freigegebenen Ziel
muss scheitern; Keycloak-Discovery und Packager-Control/TURN muessen danach
weiter funktionieren. Der Guard aktualisiert aufgeloeste Zieladressen alle
fuenf Minuten und aktiviert die neue Chain erst, nachdem alle Hostnamen
erfolgreich aufgeloest wurden.

## Broadcast-Signierschlüssel rotieren

Die Rotation beendet bewusst alle flüchtigen Broadcast-Programme und macht
sämtliche zuvor ausgegebenen Publisher-, Packager- und Playback-Grants sofort
ungültig. Sie ändert weder OIDC- noch TURN-Schlüssel. Vorher muss deshalb ein
Wartungsfenster beziehungsweise ein sichtbarer Broadcast-Stop bestätigt sein:

```bash
CONFIRM_BROADCAST_KEY_ROTATION=1 \
WEBRTC_REVERSE_PROXY_NETWORK=bbb-edge \
PRODUCTION_ORIGIN=https://webrtc.ananta.de \
scripts/production-deploy.sh rotate-broadcast-key
```

Der Runner erzeugt den neuen P-256-Schlüssel in einer Datei mit Modus 0600,
tauscht ihn atomar aus, startet ausschließlich die Control Plane mit demselben
unveränderlichen Image neu und verlangt Readiness sowie den externen Smoke.
Scheitert einer dieser Schritte, setzt er den alten Schlüssel atomar zurück und
prüft auch den Rückweg. Nach Erfolg wird die temporäre Vorversion entfernt; sie
darf nicht in Backups, Logs oder Deployment-Ausgaben übernommen werden.

Der Runner sichert vor jedem Build die tatsächlich laufenden Containerimages
von Web-App, Native-Packager und HLS-Origin unter einem gemeinsamen zufälligen
`rollback.XXXXXX`-Suffix. Das vierzeilige `image-set-v1`-Manifest in
`.deploy/previous-images` wird erst nach vollständiger Sicherung atomar ersetzt.
Ein Rebuild derselben Git-Revision kann diese Rücksprungtags nicht überschreiben.
Ist ein alter Multi-Plattform-Index nicht mehr verfügbar, wird der konfigurierte
Tag einmal in eine unveränderliche lokale Image-ID aufgelöst. Nur wenn deren
Linux-amd64-/arm64-Manifest exakt dem im laufenden Container gespeicherten
Manifest-Digest entspricht, darf dieser Index als gleichwertige Sicherung dienen.
Fehlt diese Docker-Metadatenfähigkeit oder weicht der Digest ab, erfolgt Abbruch
vor dem Build. Ein veränderlicher Tag allein ist niemals ausreichende Evidenz.
Tags aus früheren Snapshots werden nicht automatisch gelöscht; vor manuellem
Pruning den aktuellen Snapshot und den gewünschten Rücksprungzeitraum sichern.

Alle Kandidaten werden fertig gebaut, bevor einer der drei Dienste ersetzt
wird. Der Native-Kandidat muss mit der vorhandenen Dienstkonfiguration und
Geräteidentität `preflight` bestehen; der einmalige Prüfcontainer wird entfernt,
Identitäts- und Medienvolumes nicht. Build-/Preflight-Fehler lassen laufende
Dienste unverändert. Fehler bei Native-/Web-Aktivierung oder externem Smoke
stellen den kompletten vorherigen Satz wieder her und prüfen ihn erneut.
Rollback validiert zuerst das gesamte Manifest und alle lokal vorhandenen
Images und verwendet anschließend ausschließlich `--no-build --pull never`.
Bei einer fehlgeschlagenen Erstinstallation ohne Vorgänger werden ausschließlich
die neuen Dienste gestoppt; kein Volume wird gelöscht.

Die atomare Manifestdatei macht die Docker-Umschaltung **nicht** atomar oder
unterbrechungsfrei. Raum-/Broadcast-Sessions sind flüchtig und müssen nach einem
Neustart neu freigegeben werden. Datenbank-, Compose-, Firewall-, Secret- und
Konfigurationsmigrationen werden nicht zurückgesetzt und müssen separat kompatibel
geplant werden. Die [Desktop-Agent-Updater](../native-packager.md) verwenden
getrennte ID-lokale Wartungsdateien und keine Docker-Images. Linux und Windows
besitzen real geprüfte Update-/Recovery-Pfade; für den ergänzten macOS-Adapter
ist zusätzlich der macOS-CI-Lifecycle maßgeblich. Bestandsmigration und die
getrennten Plattform-/Reboot-Freigaben bleiben offen.
Ein Fehler im Rückweg bleibt ausdrücklich ein Fehler, keine erfolgreiche Freigabe.

`.deploy/operation.lock` schließt parallele Deployments, Rollbacks und
Schlüsselrotationen aus. Nach SIGKILL/Hostabbruch kann die Sperre zurückbleiben:
erst laufende Prozesse und Container prüfen, dann ausschließlich das leere
Lock-Verzeichnis mit `rmdir` entfernen und den gespeicherten Image-Satz gezielt
zurückspielen. Die Sperre wird nie aufgrund ihres Alters automatisch entfernt.
Alte `.deploy/previous-image`-Dateien mit `webrtc-minimize-server:rollback`
bleiben nur ohne aktivierten Native-Pfad verwendbar; sonst wird ein gemischter
Rollback abgelehnt. Nackte BuildKit-Manifest-Digests bleiben ungeeignet.

Der frühere, ausschließlich auf die Web-App bezogene Produktionsdrill vom
5. September 2026 schaltete unter vier parallelen externen Health-Workern auf
das Vorgängerimage und anschließend wieder auf die aktuelle Revision. Alle
2.913 HTTPS-Anfragen blieben erfolgreich; der abschließende Status war 200.

Am 6. September 2026 bestand zusätzlich der reale Drei-Dienste-Drill mit
`d13cfff` auf dem Mini-PC. Nach vollständig grüner CI einschließlich echtem
Keycloak-/TURN-Gate wurde der neue Runner deployed. Er sicherte den laufenden
Satz und bewältigte dabei den dokumentierten Containerd-Index-Sonderfall;
der Native-Kandidat bestand `preflight` vor der Aktivierung.
Bei leerer, gesunder Instanz wurden anschließend Web-App, Native-Packager und
Origin auf die drei gespeicherten Rollback-Tags zurückgesetzt. Die tatsächlichen
Container-Image-Referenzen entsprachen danach exakt dem gespeicherten Satz.
Der externe Smoke bestätigte Control Plane und Broadcast als bereit.
Der anschließende erneute Deploy stellte alle drei Dienste auf `d13cfff` und
bestand denselben externen Smoke. Ein nicht ausgegebener SHA-256-Vergleich der
vorhandenen Geräteidentität vor dem Drill, nach Rollback und nach erneutem
Deploy bestätigte unveränderten Schlüsselinhalt. Die Operation-Lock blieb nicht
zurück. Es wurden keine Identitäts- oder Medienvolumes gelöscht.

Beim ersten Beobachtungslauf brach die SSH-Ausgabe ab. Nach Prüfung, dass der
Vorgang tatsächlich beendet und die Instanz wieder gesund war, wurde der Drill
mit serverseitiger, inhaltsfreier Ausgabe wiederholt und vollständig bestätigt.
Das ist ein Versions-/Readiness-/Identitätserhalt-Gate bei null Teilnehmern,
kein Nachweis für unterbrechungsfreie laufende Räume, Medien-Handoff,
Konfigurationsmigrationen oder den Desktop-Updater.

Zertifikatsprüfung ist Bestandteil von `curl`/Node TLS beim externen Smoke. Keycloak-, TURN-, private/public Playback- und optionale MoQ-Live-Gates benötigen ausdrücklich bereitgestellte Testkonten beziehungsweise aktivierte Adapter und werden sonst sichtbar übersprungen.

Ein isolierter, nach dem Lauf zu widerrufender Produktionsnutzer und ein nur
diesem Principal zugeordneter Native-Packager können den vollständigen
Playback-Pfad prüfen. Das Gate verwendet ausschließlich Chromiums synthetische
Kamera und Mikrofon, startet beide über sichtbare Klicks, spielt zuerst als angemeldeter
Owner privat und danach anonym öffentlich ab. Es prüft zusätzlich den dauerhaft
sichtbaren, beschrifteten und tastaturfokussierbaren Kill-Switch und verlangt
nach Stop sofort 404:

Die Installationsdatei für dieses isolierte Konto kann reproduzierbar über die
echte Angular-Oberfläche erzeugt werden. Das Ausgabeverzeichnis muss bereits
existieren, darf kein Symlink sein und muss Modus `0700` besitzen; Manifest und
Installer enthalten keine OIDC-Zugangsdaten und werden mit Modus `0600`
gespeichert:

```bash
RUN_LIVE_NATIVE_PACKAGER_ONBOARDING=1 \
LIVE_OIDC_USERNAME=... LIVE_OIDC_PASSWORD=... \
LIVE_NATIVE_PACKAGER_ACTION=download \
LIVE_NATIVE_PACKAGER_OUTPUT_DIR=/sicheres/temporaeres/verzeichnis \
npm run test:native-packager-onboarding
```

Der heruntergeladene Installer enthält absichtlich das kurzlebige einmalige
Enrollment-Ticket und muss deshalb nach Installation oder Ablauf vernichtet
werden. `verify-online` und `revoke` verwenden `LIVE_NATIVE_PACKAGER_IDS` und
prüfen anschließend denselben kontogebundenen UI-Pfad ohne Capture-Aufruf.

Für die dokumentierte Ananta-Produktionsumgebung kapselt der explizit
aktivierbare Operator-Gate den gesamten Weg. Er erzeugt sein zufälliges
Testpasswort nur im Prozessspeicher, überträgt es nicht als Kommandozeilenargument
und entfernt Testnutzer, Installer, Agent-Container und Identitätsvolume über
einen Trap auch bei Abbruch. Die Keycloak-Zuordnung läuft ausschließlich über
die Admin-API, die Packager-Zuordnung ausschließlich über den normalen
Einmal-Enrollment- und späteren UI-Widerrufspfad:

```bash
RUN_LIVE_PRODUCTION_SUITE=1 npm run test:production-broadcast-suite
```

```bash
RUN_LIVE_PRODUCTION_BROADCAST=1 \
LIVE_OIDC_USERNAME=... LIVE_OIDC_PASSWORD=... \
LIVE_NATIVE_PACKAGER_ID=pkr_... \
node scripts/live-production-broadcast-gate.mjs
```

Testkonto, Packager-Registrierung, Container/Volume und Room-Consent sind
isolierte Wegwerfressourcen. Der Packager wird vor dem Löschen des Testkontos
über dessen normale authentisierte API widerrufen; direkte Datenbanklöschung
ist kein zulässiger Cleanup-Pfad.

Am 7. September 2026 bestand Revision `4d40b45` nach sieben grünen CI-Jobs
den Drei-Dienste-Deploy mit unveränderter Agent-Identität. Das öffentliche
Release-Manifest und alle fünf Downloads entsprachen dem unabhängig
attestierten CI-Artefaktsatz. Der anschließende isolierte
`public-handoff-only`-Lauf bestand mit Exit 0: zwei regulär enrollte Packager,
erneuerbare anonyme Wiedergabe, decodierter Slate/Quellenrückweg,
Standby-Auswahl per Tastatur, bestätigter Vorgänger-Stop und neue decodierte
Handoff-Ausgabe ohne Recapture oder zweiten Zuschauerklick. Stop und normaler
Widerruf bestanden; eine getrennte Kontrolle fand keine Testcontainer,
Identitätsvolumes oder Medienausgaben mehr und bestätigte die leere, gesunde
Instanz. Die getrennte Keycloak-Admin-API-Abfrage fand ebenfalls keine
temporären Testnutzer mehr. Private Wiedergabe, Visibility-Wechsel, Rückübergabe, automatische
Übernahme und Cross-Host-Auslieferung waren nicht Teil dieses Szenarios.
Der frühere Lauf mit `ERR_NETWORK_CHANGED` bleibt ein fehlgeschlagener Lauf;
der spätere Erfolg erklärt nicht die Ursache jenes Netzwerkfehlers.

Am 8. September 2026 wurde `ba67caa` nach sieben erfolgreichen CI-Jobs
(34253165644) auf dieselben drei Mini-PC-Dienste ausgerollt. Die Instanz war
vor Start leer. Der neue Maschinen-Selektor blieb `disabled disabled`; der
Runner bestand Native-Preflight, Aktivierung und externen Smoke. Unabhängig
geprüft wurden alle drei laufenden Image-Revisionen, unveränderte Agent-
Identität, vorhandener gemeinsamer Rücksprungsnapshot und das Entfernen von
Operation-Lock und Preflightcontainer. Ein zweiter externer Smoke bestätigte
Control Plane und Broadcast als bereit, Maschinenaufnahme weiterhin aus.
Das öffentliche Release-Manifest und alle fünf Binärdownloads entsprachen
byte-/SHA-256-genau dem separat gegen GitHub-Attestation, Workflow und
Quellrevision geprüften CI-Artefaktsatz. Dies ist kein erneuter Rollback-Drill
oder produktiver Ananta-Hub-/Medien-/Langzeitnachweis. Hub-Trust, Projektpolicy,
Schlüssel und das Ananta-Repository wurden nicht geändert. Der später lokal
geprüfte Raw-Encoder-Baustein `e6eea5f` ist nicht Teil dieses Deployments.
