# Runbook: Produktionsdeployment und Rollback

1. `git status --short` muss leer sein; `npm run check` und CI müssen grün sein.
2. Secret-Dateien ausschließlich root-/service-lesbar außerhalb des Repositories ablegen und über `*_FILE` referenzieren.
3. Firewall gegen `infra/deployment/port-firewall-matrix.v1.json` prüfen. Keine Broadcast-/MoQ-Ports ohne aktivierte Capability öffnen. Die Produktions-Compose-Datei startet den digest-fixierten Egress-Guard und wartet auf dessen Healthcheck; geänderte OIDC-, Control- oder TURN-Hostnamen müssen zugleich in `WEBRTC_CONTROL_EGRESS_HTTPS_HOSTS`, `WEBRTC_PACKAGER_EGRESS_HTTPS_HOSTS` beziehungsweise `WEBRTC_PACKAGER_EGRESS_TURN_HOSTS` gesetzt werden.
4. `WEBRTC_REVERSE_PROXY_NETWORK=bbb-edge PRODUCTION_ORIGIN=https://webrtc.ananta.de scripts/production-deploy.sh deploy` ausführen.
5. Ausgabe des externen Smoke-Gates und `docker compose ... ps` prüfen. Der Runner übergibt den erwarteten Native-Broadcast-Zustand; bei aktivem Native-Pfad müssen Agent und interner Origin in `/readyz` gesund sein, sonst erfolgt Rollback. Private/public Broadcastwiedergabe und Stop/Cleanup nur testen, wenn Broadcast ausdrücklich aktiviert ist; dabei keine Inhalte oder Tokens aufzeichnen.
6. Bei später erkannter Regression `scripts/production-deploy.sh rollback` ausführen. Danach `/healthz`, `/readyz`, `/config`, Login, Raumbeitritt, Medien-Stopp und Leave-Cleanup prüfen.
7. Fehler nur mit Commit, Image-Digest, Zeit, anonymisiertem Alertcode und Readiness-Komponente dokumentieren. Keine Tokens, Raumcodes, IPs, SDP/ICE, Medien oder Captions erfassen.

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

Der feste lokale Tag `webrtc-minimize-server:rollback` wird vor jedem Build
atomar als einzig akzeptiertes Rücksprungziel hinterlegt. Er darf nicht durch
einen nackten BuildKit-Manifest-Digest ersetzt werden. Der Produktionsdrill vom
5. September 2026 schaltete unter vier parallelen externen Health-Workern auf
das Vorgängerimage und anschließend wieder auf die aktuelle Revision. Alle
2.913 HTTPS-Anfragen blieben erfolgreich; der abschließende Status war 200.

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
