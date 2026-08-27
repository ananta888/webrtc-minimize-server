# WebRTC Minimize Server

[![CI](https://github.com/ananta888/webrtc-minimize-server/actions/workflows/ci.yml/badge.svg)](https://github.com/ananta888/webrtc-minimize-server/actions/workflows/ci.yml)

Ein eigenständiger MVP für Audio, Video, Bildschirmfreigabe und Peer-Chat. Ein kleiner Node-Server liefert die Browser-App und vermittelt SDP/ICE über WebSocket; Medien und Chat laufen danach direkt im WebRTC-Mesh zwischen bis zu vier Browsern.

## Lokal starten

Voraussetzung: Node.js 20 oder neuer.

```bash
npm install
npm run check
npm start
```

Danach `http://localhost:8080` in zwei Browserfenstern öffnen, einen Raum erzeugen, den Link im zweiten Fenster öffnen und mit unterschiedlichen Namen beitreten. `localhost` gilt im Browser als sicherer Entwicklungskontext. Andere Geräte benötigen HTTPS/WSS.

Medien werden niemals automatisch angefordert. Mikrofon, Kamera und Bildschirm starten nur über ihre jeweiligen Buttons. Beim Verlassen stoppt die App alle eigenen Tracks.

## Konfiguration

Die Variablen sind in `.env.example` dokumentiert. Die Anwendung lädt `.env` nicht selbst; Variablen werden von Shell, Compose oder Secret-Management gesetzt.

- `PUBLIC_ORIGIN`: exakte öffentliche HTTPS-Origin für Invite-Links und WebSocket-Origin-Prüfung.
- `STUN_URLS`: kommaseparierte STUN-URLs.
- `TURN_SERVERS_JSON`: JSON-Array im `RTCIceServer`-Format.
- `MAX_ROOM_PARTICIPANTS`: 2 bis 4.
- `ROOM_IDLE_TTL_MS`: Obergrenze für inaktive Room-Metadaten.
- `SIGNAL_RATE_LIMIT`: Nachrichten je Peer und 10 Sekunden.

Beispiel für TURN:

```bash
TURN_SERVERS_JSON='[{"urls":"turn:turn.example.org:3478","username":"short-lived","credential":"secret"}]' npm start
```

Statische TURN-Credentials sollten nicht produktiv verwendet werden. Das geplante Produktionsmodell nutzt kurzlebige Credentials.

## Docker

```bash
docker compose up --build
```

Der Container exponiert HTTP auf Port 8080. Für ein öffentliches Deployment muss ein HTTPS-Reverse-Proxy WebSocket-Upgrades für `/signal` durchreichen und `PUBLIC_ORIGIN` auf die öffentliche Origin gesetzt werden.

## API

- `GET /`: Browser-App
- `GET /healthz`: inhaltsfreier Health-/Room-Zähler
- `GET /config`: öffentliche ICE-Konfiguration
- `POST /api/rooms`: flüchtigen, kryptografisch zufälligen Invite-Code erstellen
- `GET /signal?room=…&name=…`: WebSocket-Signaling

## Sicherheitsstatus

WebRTC verschlüsselt Medien mit DTLS-SRTP und DataChannels mit DTLS/SCTP. Der Signaling-Server sieht SDP, ICE-Kandidaten, Raumzuordnung und Anzeigenamen. Der MVP hat noch keine verifizierte Benutzeridentität und keine zusätzliche Insertable-Streams-/SFrame-E2EE-Schicht. Der Raumcode ist ein Einladungsgeheimnis und wird nicht persistiert.

Die vollständige Herkunfts- und Lückenmatrix steht in [docs/ananta-webrtc-adoption.md](docs/ananta-webrtc-adoption.md). Produktionsschritte stehen schema-validiert unter `todos/backlog/`.

## Entwicklung

`AGENTS.md` macht das Todo-Tracking verbindlich. Vor nichttrivialen Änderungen wird ein Task in `todos/active/` gewählt oder angelegt; danach laufen:

```bash
npm run todos:validate
npm test
```

Der Browser-E2E-Test nutzt Playwright Chromium. Fehlt das Browser-Binary, wird genau dieser Test mit sichtbarer Skip-Begründung übersprungen; installieren lässt es sich mit `npx playwright install chromium`.

## Lizenz

Dieses Projekt steht unter der [BSD-3-Clause-Lizenz](LICENSE). Copyright © 2026 Peter Stuiber.
