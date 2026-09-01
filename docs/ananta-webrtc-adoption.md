# Übernahme der Ananta-WebRTC-Ideen

Stand: 2026-09-01. Zusätzlich commitgenau geprüft wurden `e6edf1c84`, `22126b8ce`, `8d34030f8`, `51ffe79ae` und `345f0d4ce` für Collaboration-Workspace und governed Peer-Overlay. Übernommen wurden nur transportneutrale Verträge und Policies, nicht Anantas Python-/Agent-/LiveKit-Laufzeit. Die SFrame-Umsetzung folgt [RFC 9605](https://www.rfc-editor.org/rfc/rfc9605.html) und [WebRTC Encoded Transform](https://www.w3.org/TR/webrtc-encoded-transform/); der optionale Edge-Agent verwendet [Pion TURN](https://github.com/pion/turn). Die getrennte Sicherheits- und Wahlentscheidung fuer einen nativen, SFrame-blinden Medien-Agenten steht in [blind-media-edge-agent.md](blind-media-edge-agent.md).

## Analysierte lokale Quellen

- `~/ananta/AGENTS.md` und `~/ananta/docs/planning-pipeline.md`
- `~/ananta/todos/todo.schema.json` und `~/ananta/todos/todo.track.schema.json`
- `~/ananta/todos/todo.decentralized-webrtc-peer-media-overlay.json`
- `~/ananta/todos/active/todo.webrtc-sfu-broadcast-fanout.json`
- `~/ananta/todos/archiv/todo.angular-pair-dev-cheap-view-sync.json`
- `~/ananta/todos/archiv/todo.public-ananta-rendezvous-defaults-keycloak-webrtc.json`
- `~/ananta/todos/archiv/todo.encrypted-artifact-exchange-webrtc-oidc.json`
- `~/ananta/docs/user/pair-dev-audio-video.md`
- `~/ananta/agent/routes/webrtc_signaling.py`
- `~/ananta/ananta_contracts/webrtc_datachannel.py`, `webrtc_security.py` und `webrtc_security_negotiation.py`
- `~/ananta/client_surfaces/operator_tui/visual/browser/webrtc_app/`
- `~/ananta/public-rendezvous/keycloak/ananta-realm.json` und `rendezvous/oidc_auth.py`
- `~/ananta/frontend-angular/src/app/services/oidc-auth.service.ts`
- `~/ananta/frontend-angular/src/app/services/webrtc-media-session.service.ts` und `webrtc-media-publication.service.ts`
- `~/ananta/frontend-angular/src/app/features/pair-view/webrtc-media-panel.component.ts`
- `~/ananta/docker-compose.semantic-media.yml` und `config/coturn/sfu-broadcast-turn.conf`

| Ananta-Idee | Umsetzung hier | Weiterführung |
|---|---|---|
| Hub/Control Plane besitzt Membership und Policy | flüchtige `RoomRegistry`, zielgebundenes Signaling, OIDC-geprüfte Einmal-Tickets | langlebige Grants und signierte Membership-Epochen |
| Keine implizite Medienaufnahme | jede Quelle startet nur durch separaten Klick | zeitgebundene, signierte Publication-Consents |
| Audio, Kamera und Bildschirm als getrennte Publikationen | getrennte Start-/Stop-Lifecycles; Bildschirmton nur nach separatem Opt-in und mit sofortigem Einzeltrack-Stopp | Device-Wechsel, Mute, signed media contract |
| Direkte Peer-Verbindung und Räume | Angular-Perfect-Negotiation-Mesh bis 20; Active-Speaker-Top-5, Stats-Hysterese, Focus/Balanced/Thumbnail/Paused sowie konfigurierbare Audio-/Bildschirm-/Kamera-Prioritäten und Sendergrenzen | ressourcenbasierte Join-Admission und optionaler SFU-Fallback |
| Austauschbares STUN/TURN | gestufte ICE-Policy: Direct/STUN, freiwillige Edge-TURN-Knoten und zuletzt Infrastruktur-TURN; alle dynamischen TURN-Zugänge erhalten kurzlebige HMAC-Credentials erst nach Session-Autorisierung | TURN/TLS im Edge-Agent, Secret-Rotation, IP-Privacy und Multi-Region-Failover |
| Bounded DataChannel | Chat/Control plus browserseitiger ECDH-/AES-GCM-Overlay; Traffic-Class-Queues, Digest, Replay, TTL, Hop-/Path-Cap, Chunk-ACK und Resume | verbindlicher Delivery-SLO und große Artefakte außerhalb des Browser-Speichers |
| Keycloak/OIDC | Authorization Code Flow mit PKCE im Angular-Client; JWKS-Prüfung von Signatur, Issuer, Audience, Ablaufzeit und Subject im Server | organisationsbezogene Rollen, Grants und produktiver Keycloak-HA-Betrieb |
| Geräteidentität | nicht exportierbares P-256-Schlüsselpaar im Browser; frischer signierter Join-Nachweis und serverseitiger Replay-Schutz | gegenseitige Peer-Key-Bestätigung und Gerätewiderruf |
| E2EE und Security-Epochen | WebRTC-Transportverschlüsselung plus RFC-9605-SFrame (`AES_128_GCM_SHA256_128`) über Encoded Transform; publikations-/Zielpeer-/Membership-Epoch-Keys laufen quittiert durch den ECDH-/AES-GCM-Overlay; Frame-Replay wird begrenzt | gegenseitige Peer-Key-Bestätigung außerhalb des Signaling-Vertrauens, Gerätewiderruf und MLS-artige Gruppenschlüssel |
| View-/Cursor-/Workspace-Sync | tenantgebundener SQLite-Store für Pair-Workspace, Rollenrevision, Event/Outbox, monotone Cursor und Presence-Leases | HA-Store, Backup/Restore, Threads und CRDT-Editor |
| SFU-/Broadcast-Fanout | kein zentraler Medienserver; Active-Speaker- und Trusted-Peer-Fanout reduzieren Video-Upload | optionaler LiveKit/vendorneutraler Fallback für garantierte Großräume |
| Publikationsbezogener Peer-DAG | getrennte Membership-/Route-/Topology-Epochen, kurzlebige Leases, Primary/Backup, Ressourcen-Admission, Quorum-Health und Mesh-Fallback; der alte Browser-Relay dekodiert/re-encodiert und ist nur im expliziten Legacy-Modus aktiv; ein getrennter nativer SFrame-blinder Media-Agent ist feature-gegated lokal implementiert | ein portabler blinder Browser-DAG ist durch die aktuelle Frame-Owner-Regel blockiert; der reale Fuenf-Browser-/Zwei-Agent-/NAT-Produktionsnachweis des nativen Pfads bleibt BME-006 |
| Günstige Sammelansicht | inaktive gedrosselte Kameras werden einmal lokal in ein 1-Hz-Canvas-Mosaik gerendert | optionale zustandsbasierte statt pixelbasierte Workspace-Synchronisation |
| Inhaltsfreie Observability | `/healthz` zählt nur Räume und Teilnehmer | SLOs, ICE-/TURN-Aggregate ohne SDP, IP oder Medieninhalt |

## Bewusste Abweichungen

Der Raumserver übernimmt keine Ananta-Anwendungslogik und keine Python-Abhängigkeiten. Das Frontend ist eine kleine eigenständige Angular-Anwendung; Anantas große Control-Center-Oberfläche und deren Runtime-Services werden nicht gekoppelt. Der Signaling-Server ist keine SFU: Medien und DataChannel-Inhalte passieren ihn nicht. Coturn und freiwillige Edge-Agenten können verschlüsselte WebRTC-Pakete relayn, erhalten aber keine Raum- oder Identitätspolicy. Ein Edge-Agent ist nur dann hilfreich, wenn andere Teilnehmer seine TURN- und UDP-Relay-Ports über Public IPv4 mit Portweiterleitung oder Public IPv6 erreichen; CGNAT wird dadurch nicht umgangen.

Ein Raumcode bleibt ein Bearer-Invite, reicht allein aber nicht für den Join: Je nach Auth-Modus kommen ein gültiges OIDC-Token, ein frischer P-256-Gerätenachweis und ein kurzlebiges Einmal-Ticket hinzu. SFrame-Key-Nachrichten werden ausschließlich zielpeergebunden im ECDH-/AES-GCM-Overlay transportiert und vor Aktivierung quittiert. Der zugehörige Peer-Public-Key wird jedoch weiterhin durch das authentisierte Signaling zugeordnet; SFrame schützt daher vor einem ehrlichen, aber neugierigen Relay-/Control-Plane-Betreiber, nicht vor einem vollständig kompromittierten Signaling-Server. Bewusst weitergegebene Invites, kompromittierte Browser, Gerätewiderruf, Workspace-HA/Backup, große Artefakte außerhalb des Browser-Speichers und produktiver SFU-Betrieb bleiben außerhalb dieses Nachweises.

Der Decode/Re-encode-Trusted-Relay-Pfad ist weiterhin vorhanden, wird aber ausschließlich mit `MEDIA_E2EE_MODE=disabled` aktiviert und ist dann ausdrücklich nicht blind. `required` ist der produktive Default: fehlende Browser-Capability, fehlende Key-ACKs, unbekannte KIDs, Authentifizierungsfehler oder Replays ergeben fehlende Medien statt Klartext-Fallback. SFrame reduziert weder die bis zu 19 PeerConnections bei 20 Teilnehmern noch den Senderfanout; der paketbasierte Edge-TURN-Pfad verbessert Erreichbarkeit, nicht die Mesh-Skalierung.
