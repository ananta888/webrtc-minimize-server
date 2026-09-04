# Verifizierte Broadcast-Produktionsarchitektur und Freigabestatus

Stand: 2026-09-04. Durchgezogene Kanten sind implementiert oder lokal real geprüft; gestrichelte Kanten sind geplant beziehungsweise produktiv deaktiviert. Der aktuell aktive öffentliche Dienst ist ausschließlich das interaktive Meet.

```mermaid
flowchart LR
  B["Browser: Raum-SFrame + DataChannels"] -->|"expliziter Own-Source-Fork"| P["Trusted Packager: Klartext-Komposition"]
  B -->|"OIDC, Device Proof, Consent"| C["Node Control Plane"]
  C -->|"kurzlebiger Grant + Fence"| P
  P -->|"Browser: WHIP"| G["privates MediaMTX Gateway"]
  P -->|"Native: VP8/Opus -> H.264/AAC-ABR"| O["interner read-only HLS-Origin"]
  G -->|"LL-HLS über Grant-Proxy"| V["Zuschauer, kein Raumpeer"]
  O -->|"kurzes fMP4-HLS über denselben Grant-Proxy"| V
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
  alt Browser-Packager
    P->>G: WHIP mit kurzlebigem pfadgebundenem Grant
    G-->>P: ICE/Session-Ressource
  else Native-Packager
    P->>P: H.264/AAC-ABR in flüchtiges Segmentfenster
    P-->>C: OUTPUT_READY mit Assignment-Fence
  end
  V->>C: Playback-Autorisierung
  C-->>V: Secure HttpOnly Session, kein Token in URL
  V->>G: Manifest/Part/Segment über validierenden Proxy
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

Die Portgrenze bleibt Default-Deny: öffentlich sind nur Caddy 443 und ausdrücklich aktiviertes TURN; Node 8080, Gateway-API/-Metrics, WHIP-Origin, HLS-Origin und Packager-Steuerung bleiben privat. Der Codecpfad ist lokal als nativer VP8/Opus-WebRTC-Eingang und H.264/AAC-ABR-Ausgabe geprüft. MediaMTX liefert für den Browser-WHIP-Adapter LL-HLS; der native Adapter liefert kurzes fMP4-HLS und behauptet keine LL-HLS-Parts. Der Player wählt natives HLS oder hls.js. Captions werden lokal erzeugt und nur nach gesonderter Freigabe in das Programm übernommen. Recording und Transcript-Retention sind nicht implementiert.

`BROADCAST_NATIVE_OUTPUT_ENABLED=true` ist ein eigener, default-aus bleibender
Schalter. Der Produktions-Runner aktiviert die beiden portlosen
`native-packager`-Dienste nur, wenn zusätzlich eine gültige Packager-ID und der
exakte interne Origin konfiguriert sind. Er erzeugt beim ersten Lauf einen
P-256-Signaturschlüssel mit Modus `0600` unter dem ignorierten
`.deploy/secrets/`-Pfad, prüft ihn bei jedem Folge-Deploy und bindet ihn nur
read-only in die Node-Control-Plane ein. Agentenidentität und Medienfenster
liegen in getrennten Volumes; nur die Identität überlebt absichtlich, während
verwaiste `res_`-Ausgaben beim Agentstart entfernt werden.

Details: Architektur/Trust in `docs/adr/0001-separated-interactive-broadcast-delivery-planes.md`, Ports in `infra/deployment/port-firewall-matrix.v1.json`, Codecs in `docs/broadcast-codec-admission.md`, Player in `docs/broadcast-player.md`, Captions in `docs/broadcast-live-captions.md`, Failover in `docs/broadcast-failover-and-disaster-recovery.md`, Datenschutz in `infra/security/broadcast-review.v1.json` und Rollout in `infra/deployment/broadcast-rollout.v1.json`.
