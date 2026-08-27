# Übernahme der Ananta-WebRTC-Ideen

Stand: 2026-08-27. Analysiert wurden insbesondere Anantas WebRTC-Contracts, Signaling-Route, Browser-WebRTC-App, Pair-Dev-Mediendokumentation sowie die Tracks für dezentrales Peer-Media, Public Rendezvous, günstigen View-Sync, verschlüsselten Artefaktaustausch und SFU-Broadcast.

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
| Audio, Kamera und Bildschirm als getrennte Publikationen | getrennte Start-/Stop-Lifecycles; Bildschirmton wird verwendet, falls der Browser ihn liefert | Device-Wechsel, Mute, Limits, signed media contract |
| Direkte Peer-Verbindung und Räume | Angular-Perfect-Negotiation-Mesh in isolierten Räumen mit harter Membership-Grenze 20; Pair Dev ist auf zwei Geräte begrenzt | stats-basierte dynamische Mediengrenze und SFU-Fallback |
| Austauschbares STUN/TURN | mitgelieferter Coturn-Stack; serverseitige HMAC-Credentials mit kurzer Gültigkeit nach Session-Autorisierung | TURN/TLS, Secret-Rotation, IP-Privacy und Multi-Region-Failover |
| Bounded DataChannel | Chat v1, 2.000 Zeichen, geschlossener Nachrichtentyp | Traffic-Klassen, Prioritätsqueue, Backpressure, Artefakt-Chunks |
| Keycloak/OIDC | Authorization Code Flow mit PKCE im Angular-Client; JWKS-Prüfung von Signatur, Issuer, Audience, Ablaufzeit und Subject im Server | organisationsbezogene Rollen, Grants und produktiver Keycloak-HA-Betrieb |
| Geräteidentität | nicht exportierbares P-256-Schlüsselpaar im Browser; frischer signierter Join-Nachweis und serverseitiger Replay-Schutz | gegenseitige Peer-Key-Bestätigung und Gerätewiderruf |
| E2EE und Security-Epochen | WebRTC-Transportverschlüsselung plus signierte Gerätebindung; keine zusätzliche Frame-E2EE | SFrame/Encoded Transform, Peer-Key-Epochen, Frame-Replay-Fenster und Rotation |
| View-/Cursor-/Workspace-Sync | nicht Bestandteil des Raumservers | transportneutrale Events, Presence, Cursor, Threads und Replay |
| SFU-/Broadcast-Fanout | nicht implementiert | LiveKit/vendorneutraler Adapter, Admission, Layers, Observability |
| Publikationsbezogener Peer-DAG | nicht implementiert; kein Produktionsversprechen | bounded Experiment erst nach Browser-/Security-/QoS-Gates |
| Inhaltsfreie Observability | `/healthz` zählt nur Räume und Teilnehmer | SLOs, ICE-/TURN-Aggregate ohne SDP, IP oder Medieninhalt |

## Bewusste Abweichungen

Der Raumserver übernimmt keine Ananta-Anwendungslogik und keine Python-Abhängigkeiten. Das Frontend ist eine kleine eigenständige Angular-Anwendung; Anantas große Control-Center-Oberfläche und deren Runtime-Services werden nicht gekoppelt. Der Server ist keine SFU: Medien und DataChannel-Inhalte passieren ihn nicht. Coturn kann verschlüsselte WebRTC-Pakete relayn, erhält aber keine Raum- oder Identitätspolicy.

Ein Raumcode bleibt ein Bearer-Invite, reicht allein aber nicht für den Join: Je nach Auth-Modus kommen ein gültiges OIDC-Token, ein frischer P-256-Gerätenachweis und ein kurzlebiges Einmal-Ticket hinzu. Das schützt nicht gegen bewusst weitergegebene Invites, kompromittierte angemeldete Browser oder einen kompromittierten Signaling-Server. Frame-E2EE, dauerhafte Autorisierung, Gerätewiderruf und produktiver SFU-Betrieb bleiben im Backlog.
