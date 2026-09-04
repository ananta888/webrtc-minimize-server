# Gepinnter MediaMTX-Gateway-Adapter

## Reproduzierbare Basis

Das lokale Integrationsprofil verwendet ausschließlich
`bluenviron/mediamtx:1.20.1` mit dem Multi-Arch-OCI-Digest
`sha256:1b029d11049be75630e9b73bb0d5f47b08a7db4eaee89a80bf8f53bc40e56414`.
Version, Digest, MIT-Lizenz und ein minimales CycloneDX-Inventar liegen unter
`infra/mediamtx/`. Ein Tag ohne Digest ist nicht zulässig.

## Aktivierte Capabilities

- WebRTC/WHIP-Ingest auf Container-Port 8889,
- LL-HLS auf Container-Port 8888,
- Control API 9997 und Metrics 9998 ausschließlich in Docker-Netzen,
- UDP-ICE auf 8189,
- flüchtige In-Memory-HLS-Parts ohne Recording- oder DVR-Pfad.

RTSP, RTMP, SRT, MoQ, Playback-Archiv und pprof sind deaktiviert. Zulässige
Pfadnamen entsprechen ausschließlich der programgebundenen, nicht erratbaren
`res_`-Resource-Referenz plus 16 bis 64 URL-sicheren Zeichen. Publisher dürfen
einander nicht überschreiben.

Das lokale Profil veröffentlicht HLS, WHIP und ICE ausschließlich an
`127.0.0.1`. API und Metrics besitzen kein Host-Port-Mapping. Der Container
läuft ohne Linux-Capabilities, mit `no-new-privileges`, Read-only-Dateisystem,
kleinem `tmpfs`, nicht privilegierter UID sowie CPU-, RAM- und PID-Grenzen.

## Start und Stop

```bash
docker compose --project-directory . -p webrtc-broadcast-gateway \
  -f infra/mediamtx/compose.yaml \
  --profile broadcast-gateway up -d

docker compose --project-directory . -p webrtc-broadcast-gateway \
  -f infra/mediamtx/compose.yaml \
  --profile broadcast-gateway down
```

Die Portvorgaben `18888/tcp`, `18889/tcp` und `18189/udp` kollidieren nicht mit
Caddy 80/443, WebRTC 8080, Keycloak oder Coturn 3478. Sie sind über
`MEDIAMTX_HLS_PORT`, `MEDIAMTX_WHIP_PORT` und `MEDIAMTX_ICE_PORT` nur für ein
explizites lokales Gate verschiebbar.

## Sicherheitsgrenze

Die aktuelle Netzwerk-Authentisierung erlaubt Publish/Read/Playback nur aus
dem internen Docker-Adressraum und ist ausschließlich für das loopback-
gebundene Integrationsprofil bestimmt. Sie ist keine Produktionsautorisierung.
Die geschlossene externe Auth-Grenze und das Compose-Overlay sind in
[`mediamtx-gateway-security.md`](./mediamtx-gateway-security.md) beschrieben.
Vor einer öffentlichen Proxyfreigabe müssen zusätzlich Composition-Root,
Program-Orchestrierung und das echte Live-Gate aktiv sein. Deshalb wird dieses
Profil nicht durch das normale Deployment gestartet.

Primärquellen: [MediaMTX v1.20.1 Release](https://github.com/bluenviron/mediamtx/releases/tag/v1.20.1),
[gepinntes Upstream-Konfigurationsschema](https://github.com/bluenviron/mediamtx/blob/v1.20.1/mediamtx.yml),
[Upstream-Lizenz](https://github.com/bluenviron/mediamtx/blob/v1.20.1/LICENSE).
