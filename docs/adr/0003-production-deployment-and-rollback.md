# ADR 0003: Produktionsdeployment und Rollback

- Status: angenommen für das bestehende Meet; Broadcast-Freischaltung bleibt ausstehend
- Datum: 2026-09-04

## Entscheidung

Die Control Plane läuft auf dem Mini-PC hinter dem vorhandenen Caddy. Keycloak und das Infrastruktur-TURN bleiben im getrennten Oracle-Ausfallradius. Der optionale Media-Gateway-/Packager-Pfad wird erst auf einem privaten `broadcast-control`-/`broadcast-media`-Netz aktiviert, wenn dessen Live-Gates grün sind. Ein späteres CDN erhält nur Playback-Ressourcen; MoQ bleibt standardmäßig aus.

Diese Platzierung priorisiert den bereits funktionierenden Meet-Pfad und niedrige LAN-Latenz. Der Mini-PC ist aktuell ein einzelner Control-Plane-Ausfallpunkt. Trusted-Packager benötigen ausreichend CPU/GPU und Upload; Gateway/Origin werden zur Vermeidung öffentlicher Adminports getrennt vom Browsernetz betrieben. Provider/CDN sind erst nach Datenschutz-, Kosten- und Ausfallradiusprüfung zulässig.

`infra/deployment/compose.production.yaml` härtet den App-Container mit read-only Root, eigener persistenter Datenmount, no-new-privileges, null Linux-Capabilities, PID-/CPU-/RAM-/Log-Limits, `tmpfs` und Readiness-Healthcheck. Caddy erreicht Port 8080 nur über das externe Proxy-Netz; das Produktionsprofil entfernt die Host-Portfreigabe und das zusätzliche Compose-Standardnetz. Die Control Plane hängt damit nur am Caddy-Netz und am internen Origin-Netz. Der Native-Packager besitzt nur sein ausgehendes Steuer-/ICE-Netz und teilt mit dem Origin ausschließlich das schreibende Datenvolume, kein Netzwerk. Gateway-Control und -Metriken bleiben auf internen Netzen.

Secrets werden nicht in Compose oder Images geschrieben. `TURN_SHARED_SECRET_FILE`, `EDGE_TURN_SERVERS_JSON_FILE` und `MEDIA_EDGE_AGENTS_JSON_FILE` lesen begrenzte Secret-Mounts; gleichzeitige Direkt- und Dateikonfiguration ist ein Fehler. Rotation ersetzt den Mount atomar, erzeugt den Container neu und widerruft alte Grants/Credentials.

Der Broadcast-Signierschlüssel besitzt einen eigenen bestätigungspflichtigen
Rotationspfad. Er erzeugt P-256-Material ausschließlich im nicht versionierten
Deployment-Verzeichnis mit Modus 0600, tauscht die Datei atomar, recreatet nur
die Control Plane und verlangt denselben externen Health-Gate wie ein Release.
Da Broadcastzustand flüchtig ist, beendet die Rotation absichtlich alle
Programme und Grants. Bei einem Fehler wird die unmittelbar vorherige Datei
zurückgesetzt und erneut gegatet; nach Erfolg bleibt keine Klartextvorversion
im Deployment-Verzeichnis liegen.

## Release und Rollback

`scripts/production-deploy.sh deploy` baut ein unveränderlich mit Git-SHA benanntes Image, verankert das aktuell laufende Image vor jedem Build unter dem lokalen Tag `webrtc-minimize-server:rollback`, ersetzt nur den App-Container und verlangt Docker-Readiness plus externen HTTPS-Smoke-Test. Der feste lokale Rollback-Tag ist nötig, weil ein nackter BuildKit-Manifest-Digest beim erneuten Build desselben Revisionstags unreferenziert werden und von Compose fälschlich als Registry-Image behandelt werden kann. Der Smoke-Test prüft Health, getrennte Readiness, OIDC required, SFrame required, 20er-Limit, Runtime-Config, CSP und Angular-Shell. Scheitert ein Gate, wird automatisch das verankerte vorherige Image gestartet und erneut extern geprüft. `rollback` ist auch manuell verfügbar.

Die Docker-Buildgraphen für Webserver, nativen Packager und Broadcast-Origin
sind getrennt. Das kleine Origin-Ziel kompiliert keine Agent-Artefakte; das
laufende Linux-Packager-Image kompiliert nur Linux/amd64. Erst das Webimage,
das die geprüften Self-Service-Downloads ausliefert, erzeugt die vollständige
Fünf-Plattform-Matrix. Identische Revision und Commitzeit bleiben dabei in
Laufzeitbinary und Download eingebettet.

Dies ist ein health-gated atomarer Recreate mit automatischem Rollback, kein verlustfreies Multi-Replica-Blue/Green: Room-Membership bleibt definitionsgemäß flüchtig. Contract-v1 bleibt additiv; unbekannte Felder werden fail-closed behandelt. Broadcast ist im Produktionsprofil nicht implizit aktiviert und kann daher einen fehlgeschlagenen Release des Meets nicht stillschweigend übernehmen.

## Netzwerk

Die verbindliche Default-deny-Matrix steht in `infra/deployment/port-firewall-matrix.v1.json`. Nur Caddy 443 (und 80, falls für ACME/Redirect benötigt) sowie aktiviertes TURN werden öffentlich exponiert. WHIP, HLS-Upstream, Gateway-API/-Metriken und Node 8080 bleiben privat. UDP 443 für MoQ wird erst nach tatsächlicher Capability und externem Test geöffnet.

Der kanonische Virtual Host liegt in
`infra/reverse-proxy/Caddyfile.webrtc.production`. Er akzeptiert nur die
benötigten HTTP-Methoden, begrenzt Request-Bodies vor Node auf 256 KiB,
entfernt nicht benötigte URL-Rewrite-Header, fixiert den weitergereichten Host,
setzt äußere Security-Header und besitzt begrenzte Dial-/Response-Timeouts.
Feingranulare Rate-, Origin-, Schema-, Pfad-, Body- und
Autorisierungsentscheidungen bleiben in der zuständigen Node-Grenze, weil der
verwendete stock Caddy kein ungeprüftes Rate-Limit-Plugin erhält. Gateway-API,
Metrics, Debug und MediaMTX werden von diesem öffentlichen Host nie direkt
proxied.

Ausgehende Ziele werden im Produktionsprofil zusätzlich erzwungen. Control Plane
und Native-Packager erhalten je ein ausschließlich von ihnen verwendetes,
festes Egress-Subnetz. Ein auf einen Image-Digest fixierter Firewall-Guard darf
als einzige Ausnahme `NET_ADMIN` im Host-Netz besitzen und hält zwei
generationell ausgetauschte `DOCKER-USER`-Chains aktiv. Die Control Plane darf
neue Verbindungen nur zum konfigurierten OIDC-/JWKS-Host auf TCP 443 beginnen.
Der Native-Packager darf nur sein Control-WSS auf TCP 443 sowie die exakt
konfigurierten TURN-Hosts auf UDP/TCP 3478 und TCP/TLS 5349 erreichen; alles
andere aus diesen Subnetzen wird verworfen. DNS-Namen werden vor einem
Regeltausch vollständig aufgelöst, die letzte gültige Generation bleibt bei
einem DNS-Fehler aktiv.

Damit die Ziel-Allowlist keine beliebigen ICE-Gegenstellen benötigt, verwendet
der Native-Packager in Produktion validiert `ICETransportPolicy=relay`.
Direkte Browser-Peer-Verbindungen und freiwillige Media-/TURN-Edge-Agenten sind
davon nicht betroffen. Eine Änderung der OIDC-, Control- oder TURN-Hostnamen
muss gemeinsam mit `WEBRTC_*_EGRESS_*_HOSTS` ausgerollt und durch den
Produktionsgate verifiziert werden. Buildcontainer gehören nicht zu den
geschützten Runtime-Subnetzen und dürfen Paketregistries nur während des
isolierten Builds erreichen.

Für den Oracle-Coturn beschreibt
[`infrastructure-turn-tls.md`](../runbooks/infrastructure-turn-tls.md) den
TCP/TLS-5349-Pfad. Caddys Schlüsselvolume wird nicht geteilt: Ein gehärteter
Timer validiert Hostname, Restgültigkeit und Schlüsselpaar, aktiviert eine
root-only Kopie atomar und startet genau den gelabelten Coturn neu. Die
`turns:`-URL bleibt bis zum externen TLS- und Allocation-Gate aus der Runtime.
