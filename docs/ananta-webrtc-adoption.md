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

| Ananta-Idee | MVP-Umsetzung hier | Weiterführung |
|---|---|---|
| Hub/Control Plane besitzt Membership und Policy | flüchtige `RoomRegistry`, zielgebundenes Signaling | OIDC, Grants, signierte Membership-Epochen |
| Keine implizite Medienaufnahme | jede Quelle startet nur durch separaten Klick | zeitgebundene, signierte Publication-Consents |
| Audio, Kamera und Bildschirm als getrennte Publikationen | getrennte Start-/Stop-Lifecycles; Bildschirmton wird verwendet, falls der Browser ihn liefert | Device-Wechsel, Mute, Limits, signed media contract |
| Direkte Peer-Verbindung und kleines Mesh | Perfect-Negotiation-Mesh bis maximal vier Teilnehmer | stats-basierte dynamische Grenze und SFU-Fallback |
| Austauschbares STUN/TURN | Server liefert ICE-Konfiguration aus Environment | kurzlebige TURN-Credentials, Quotas, IP-Privacy, Failover |
| Bounded DataChannel | Chat v1, 2.000 Zeichen, geschlossener Nachrichtentyp | Traffic-Klassen, Prioritätsqueue, Backpressure, Artefakt-Chunks |
| E2EE und Security-Epochen | nur WebRTC-Transportverschlüsselung, ausdrücklich als MVP-Grenze dokumentiert | SFrame/Encoded Transform, Geräteschlüssel, Replay-Fenster, Rotation |
| View-/Cursor-/Workspace-Sync | nicht Bestandteil des Medien-MVP | transportneutrale Events, Presence, Cursor, Threads und Replay |
| SFU-/Broadcast-Fanout | nicht implementiert | LiveKit/vendorneutraler Adapter, Admission, Layers, Observability |
| Publikationsbezogener Peer-DAG | nicht implementiert; kein Produktionsversprechen | bounded Experiment erst nach Browser-/Security-/QoS-Gates |
| Inhaltsfreie Observability | `/healthz` zählt nur Räume und Teilnehmer | SLOs, ICE-/TURN-Aggregate ohne SDP, IP oder Medieninhalt |

## Bewusste Abweichungen

Der MVP übernimmt keine Ananta-Anwendungslogik und keine Python-/Angular-Abhängigkeiten. Das reduziert die Oberfläche auf einen eigenständigen Node-Server und eine Browser-App. Der Server ist keine SFU: Medien und DataChannel-Inhalte passieren ihn nicht.

Ein Raumcode ist derzeit ein Bearer-Invite. Er schützt nicht gegen Weitergabe, erratene Codes oder einen kompromittierten Signaling-Server. Production-E2EE, verifizierte Identität und dauerhafte Autorisierung stehen daher in `todos/backlog/todo.webrtc-production-roadmap.json` auf dem kritischen Pfad.
