# Verifizierte Broadcast-Produktionsarchitektur und Freigabestatus

Stand: 2026-09-04. Durchgezogene Kanten sind implementiert oder lokal real geprüft; gestrichelte Kanten sind geplant beziehungsweise produktiv deaktiviert. Der aktuell aktive öffentliche Dienst ist ausschließlich das interaktive Meet.

```mermaid
flowchart LR
  B["Browser: Raum-SFrame + DataChannels"] -->|"expliziter Own-Source-Fork"| P["Trusted Packager: Klartext-Komposition"]
  B -->|"OIDC, Device Proof, Consent"| C["Node Control Plane"]
  C -->|"kurzlebiger Grant + Fence"| P
  P -->|"WHIP / H.264 + AAC"| G["privates MediaMTX Gateway"]
  G -->|"LL-HLS über Grant-Proxy"| V["Zuschauer, kein Raumpeer"]
  G -.->|"erst nach Provider-/Privacy-/Kosten-Gate"| D["CDN"]
  P -.->|"experimentelle Secure Objects"| M["MoQ"]
```

```mermaid
sequenceDiagram
  actor U as lokaler Nutzer
  participant B as Browser
  participant C as Control Plane
  participant P as Trusted Packager
  participant G as Gateway
  participant V as Viewer
  U->>B: bereits aktive Quelle wählen + Preflight
  U->>B: Trust-Grenze und Publikum bestätigen
  B->>C: source-/device-/epochgebundener Consent
  C->>P: kurzlebige Lease, Key-Zugriff und monotone Fence
  P->>G: WHIP mit kurzlebigem pfadgebundenem Grant
  G-->>P: ICE/Session-Ressource
  V->>C: Playback-Autorisierung
  C-->>V: Secure HttpOnly Session, kein Token in URL
  V->>G: Manifest/Part über validierenden Proxy
  U->>B: Stop
  B->>C: revoke + cleanup
  C->>P: Lease/Key widerrufen
  P->>G: WHIP DELETE
```

```mermaid
flowchart TB
  OIDC["OIDC Token: nur Auth-Grenze"] --> GRANT["kurzlebiger ES256 Grant"]
  DEVICE["nicht exportierbarer P-256 Device Key"] --> CONSENT["Source + Device + Program Epoch Consent"]
  CONSENT --> LEASE["Writer Lease + Fencing Revision"]
  GRANT --> WHIP["WHIP/HLS Pfadrecht"]
  LEASE --> KEY["temporärer Broadcast-Decrypt-Key"]
  KEY --> PACKAGER["Trusted Packager Klartext"]
  PACKAGER --> OUTPUT["Transportverschlüsselte H.264/AAC-Ausgabe"]
```

```mermaid
flowchart LR
  P1["Packager A / Fence 12"] -->|"Crash oder Quorumverlust"| CP["Failover Coordinator"]
  CP -->|"Fence 13, frischer Consent"| P2["Packager B"]
  P1 -.->|"alte Fence: abgelehnt"| G["Gateway"]
  P2 -->|"Discontinuity + Player Restart"| G
  CP -->|"kein sicherer Kandidat/Deadline"| STOP["sichtbarer Stop"]
```

Die Portgrenze bleibt Default-Deny: öffentlich sind nur Caddy 443 und ausdrücklich aktiviertes TURN; Node 8080, Gateway-API/-Metrics, WHIP-Origin, HLS-Origin und Packager-Steuerung bleiben privat. Der Codecpfad ist lokal als VP8-WHIP-Eingang und native H.264/AAC-Dreifachrendition geprüft. MediaMTX liefert LL-HLS; der Player wählt natives HLS oder hls.js. Captions werden lokal erzeugt und nur nach gesonderter Freigabe in das Programm übernommen. Recording und Transcript-Retention sind nicht implementiert.

Details: Architektur/Trust in `docs/adr/0001-separated-interactive-broadcast-delivery-planes.md`, Ports in `infra/deployment/port-firewall-matrix.v1.json`, Codecs in `docs/broadcast-codec-admission.md`, Player in `docs/broadcast-player.md`, Captions in `docs/broadcast-live-captions.md`, Failover in `docs/broadcast-failover-and-disaster-recovery.md`, Datenschutz in `infra/security/broadcast-review.v1.json` und Rollout in `infra/deployment/broadcast-rollout.v1.json`.
