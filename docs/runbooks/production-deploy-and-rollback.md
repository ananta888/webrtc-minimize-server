# Runbook: Produktionsdeployment und Rollback

1. `git status --short` muss leer sein; `npm run check` und CI müssen grün sein.
2. Secret-Dateien ausschließlich root-/service-lesbar außerhalb des Repositories ablegen und über `*_FILE` referenzieren.
3. Firewall gegen `infra/deployment/port-firewall-matrix.v1.json` prüfen. Keine Broadcast-/MoQ-Ports ohne aktivierte Capability öffnen.
4. `WEBRTC_REVERSE_PROXY_NETWORK=bbb-edge PRODUCTION_ORIGIN=https://webrtc.ananta.de scripts/production-deploy.sh deploy` ausführen.
5. Ausgabe des externen Smoke-Gates und `docker compose ... ps` prüfen. Private/public Broadcastwiedergabe und Stop/Cleanup nur testen, wenn Broadcast ausdrücklich aktiviert ist; dabei keine Inhalte oder Tokens aufzeichnen.
6. Bei später erkannter Regression `scripts/production-deploy.sh rollback` ausführen. Danach `/healthz`, `/readyz`, `/config`, Login, Raumbeitritt, Medien-Stopp und Leave-Cleanup prüfen.
7. Fehler nur mit Commit, Image-Digest, Zeit, anonymisiertem Alertcode und Readiness-Komponente dokumentieren. Keine Tokens, Raumcodes, IPs, SDP/ICE, Medien oder Captions erfassen.

Zertifikatsprüfung ist Bestandteil von `curl`/Node TLS beim externen Smoke. Keycloak-, TURN-, private/public Playback- und optionale MoQ-Live-Gates benötigen ausdrücklich bereitgestellte Testkonten beziehungsweise aktivierte Adapter und werden sonst sichtbar übersprungen.
