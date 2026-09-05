# Runbook: Produktionsdeployment und Rollback

1. `git status --short` muss leer sein; `npm run check` und CI müssen grün sein.
2. Secret-Dateien ausschließlich root-/service-lesbar außerhalb des Repositories ablegen und über `*_FILE` referenzieren.
3. Firewall gegen `infra/deployment/port-firewall-matrix.v1.json` prüfen. Keine Broadcast-/MoQ-Ports ohne aktivierte Capability öffnen. Die Produktions-Compose-Datei startet den digest-fixierten Egress-Guard und wartet auf dessen Healthcheck; geänderte OIDC-, Control- oder TURN-Hostnamen müssen zugleich in `WEBRTC_CONTROL_EGRESS_HTTPS_HOSTS`, `WEBRTC_PACKAGER_EGRESS_HTTPS_HOSTS` beziehungsweise `WEBRTC_PACKAGER_EGRESS_TURN_HOSTS` gesetzt werden.
4. `WEBRTC_REVERSE_PROXY_NETWORK=bbb-edge PRODUCTION_ORIGIN=https://webrtc.ananta.de scripts/production-deploy.sh deploy` ausführen.
5. Ausgabe des externen Smoke-Gates und `docker compose ... ps` prüfen. Der Runner übergibt den erwarteten Native-Broadcast-Zustand; bei aktivem Native-Pfad müssen Agent und interner Origin in `/readyz` gesund sein, sonst erfolgt Rollback. Private/public Broadcastwiedergabe und Stop/Cleanup nur testen, wenn Broadcast ausdrücklich aktiviert ist; dabei keine Inhalte oder Tokens aufzeichnen.
6. Bei später erkannter Regression `scripts/production-deploy.sh rollback` ausführen. Danach `/healthz`, `/readyz`, `/config`, Login, Raumbeitritt, Medien-Stopp und Leave-Cleanup prüfen.
7. Fehler nur mit Commit, Image-Digest, Zeit, anonymisiertem Alertcode und Readiness-Komponente dokumentieren. Keine Tokens, Raumcodes, IPs, SDP/ICE, Medien oder Captions erfassen.

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
Owner privat und danach anonym öffentlich ab und verlangt nach Stop sofort 404:

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
