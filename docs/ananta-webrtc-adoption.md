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
| Direkte Peer-Verbindung und Räume | Angular-Perfect-Negotiation-Mesh bis 20; Active-Speaker-Top-5, Stats-Hysterese, Focus/Balanced/Thumbnail/Paused und Screenshare-Priorität | ressourcenbasierte Join-Admission und optionaler SFU-Fallback |
| Austauschbares STUN/TURN | mitgelieferter Coturn-Stack; serverseitige HMAC-Credentials mit kurzer Gültigkeit nach Session-Autorisierung | TURN/TLS, Secret-Rotation, IP-Privacy und Multi-Region-Failover |
| Bounded DataChannel | getrennte Chat-/Control-Kanäle mit Queuecaps; Chat, Aktivität und Quality Feedback sind geschlossen versioniert | Artefakt-Chunks und mehrstufige Bulk-Queues |
| Keycloak/OIDC | Authorization Code Flow mit PKCE im Angular-Client; JWKS-Prüfung von Signatur, Issuer, Audience, Ablaufzeit und Subject im Server | organisationsbezogene Rollen, Grants und produktiver Keycloak-HA-Betrieb |
| Geräteidentität | nicht exportierbares P-256-Schlüsselpaar im Browser; frischer signierter Join-Nachweis und serverseitiger Replay-Schutz | gegenseitige Peer-Key-Bestätigung und Gerätewiderruf |
| E2EE und Security-Epochen | WebRTC-Transportverschlüsselung plus signierte Gerätebindung; keine zusätzliche Frame-E2EE | SFrame/Encoded Transform, Peer-Key-Epochen, Frame-Replay-Fenster und Rotation |
| View-/Cursor-/Workspace-Sync | nicht Bestandteil des Raumservers | transportneutrale Events, Presence, Cursor, Threads und Replay |
| SFU-/Broadcast-Fanout | kein zentraler Medienserver; Active-Speaker- und Trusted-Peer-Fanout reduzieren Video-Upload | optionaler LiveKit/vendorneutraler Fallback für garantierte Großräume |
| Publikationsbezogener Peer-DAG | serverautorisierter, epochgebundener Trusted-Video-Baum mit Fanout-/Hopcap, Consent und Mesh-Fallback | nicht entschlüsselnder SFrame-/Ciphertext-DAG bleibt bis positiver Browser-/Security-Evidence offen |
| Günstige Sammelansicht | inaktive gedrosselte Kameras werden einmal lokal in ein 1-Hz-Canvas-Mosaik gerendert | optionale zustandsbasierte statt pixelbasierte Workspace-Synchronisation |
| Inhaltsfreie Observability | `/healthz` zählt nur Räume und Teilnehmer | SLOs, ICE-/TURN-Aggregate ohne SDP, IP oder Medieninhalt |

## Bewusste Abweichungen

Der Raumserver übernimmt keine Ananta-Anwendungslogik und keine Python-Abhängigkeiten. Das Frontend ist eine kleine eigenständige Angular-Anwendung; Anantas große Control-Center-Oberfläche und deren Runtime-Services werden nicht gekoppelt. Der Server ist keine SFU: Medien und DataChannel-Inhalte passieren ihn nicht. Coturn kann verschlüsselte WebRTC-Pakete relayn, erhält aber keine Raum- oder Identitätspolicy. Ein ausdrücklich zustimmender Trusted-Relay-Browser kann fremde Tracks hopweise verarbeiten und re-encodieren; diese Funktion ist nicht mit Ciphertext-Fanout oder Frame-E2EE gleichzusetzen.

Ein Raumcode bleibt ein Bearer-Invite, reicht allein aber nicht für den Join: Je nach Auth-Modus kommen ein gültiges OIDC-Token, ein frischer P-256-Gerätenachweis und ein kurzlebiges Einmal-Ticket hinzu. Das schützt nicht gegen bewusst weitergegebene Invites, kompromittierte angemeldete Browser oder einen kompromittierten Signaling-Server. Frame-E2EE, dauerhafte Autorisierung, Gerätewiderruf und produktiver SFU-Betrieb bleiben im Backlog.
