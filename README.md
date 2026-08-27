# WebRTC Minimize Server

[![CI](https://github.com/ananta888/webrtc-minimize-server/actions/workflows/ci.yml/badge.svg)](https://github.com/ananta888/webrtc-minimize-server/actions/workflows/ci.yml)

Ein eigenständiger, Keycloak-fähiger Raumserver mit Angular-Oberfläche für Audio, Video, Bildschirmfreigabe und Peer-Chat. Der Node-Server autorisiert Membership und vermittelt SDP/ICE; Medien und Chat laufen direkt zwischen den Browsern oder bei schwierigen NAT-/Firewall-Pfaden über den mitgelieferten Coturn-Dienst.

## Lokal starten

Voraussetzung: Node.js 20 oder neuer. Der anonyme Entwicklungsmodus benötigt keine externe Infrastruktur:

```bash
npm install
npm run build
npm start
```

Danach `http://localhost:8080` in zwei Browserfenstern öffnen. `npm start` verwendet ohne weitere Environment-Variablen bewusst `AUTH_MODE=disabled`; auch dann wird jeder Join durch eine im Browser erzeugte, nicht exportierbare P-256-Geräteidentität signiert. `localhost` gilt als sicherer Entwicklungskontext. Andere Geräte benötigen HTTPS/WSS.

Medien werden niemals automatisch angefordert. Mikrofon, Kamera und Bildschirm starten nur über ihre jeweiligen Buttons. Beim Verlassen stoppt die App alle eigenen Tracks.

## Räume

`Neuen Raum` erzeugt einen kryptografisch zufälligen Einladungslink. Ein Raum entsteht flüchtig beim ersten Join, besitzt eine vollständig getrennte Teilnehmerliste und akzeptiert standardmäßig höchstens 20 gleichzeitig verbundene Browser. Signale können ausschließlich an Teilnehmer desselben Raums adressiert werden. Es gibt keine anwendungsseitige Obergrenze für die Anzahl gleichzeitig aktiver Räume; praktisch begrenzen nur die verfügbaren Serverressourcen. Leere Räume werden sofort verworfen. Membership und Raumverlauf werden nicht persistiert.

`Neue Pair-Session` erzeugt einen eigenen Sessiontyp für Pair Dev. Er akzeptiert höchstens zwei unterschiedliche P-256-Geräte. Ein vorhandener Raum kann nicht zwischen Pair- und Room-Modus wechseln; derselbe Gerätefingerprint darf nicht zweimal derselben Pair-Session beitreten.

Vor jedem WebSocket-Upgrade autorisiert `POST /api/sessions` Identität, Gerät, Raum, Modus und Origin. Das Access Token wird niemals in eine WebSocket-URL geschrieben. Stattdessen erhält der Browser ein zufälliges, kurzlebiges und nur einmal verwendbares Signaling-Ticket.

## Vollständiger lokaler Stack

Compose startet die Angular-/Node-Anwendung, Keycloak 26.6.1 und Coturn 4.6.3:

```bash
cp .env.example .env
# Vor gemeinsamem oder öffentlichem Betrieb mindestens alle Beispielpasswörter
# und TURN_SHARED_SECRET ersetzen.
docker compose up --build
```

Danach:

- Anwendung: `http://localhost:8080`
- Keycloak: `http://localhost:8081`
- STUN/TURN: `localhost:3478` über UDP und TCP
- Relay-UDP-Ports: `49160-49200`

Im Browser `Mit Keycloak anmelden` wählen und bei Bedarf über Keycloak ein Konto registrieren. Der importierte öffentliche Client verwendet Authorization Code Flow mit PKCE S256; Implicit Flow und Direct Access Grants sind deaktiviert. `start-dev`, die H2-Datenbank, unverschlüsseltes lokales TURN und die Beispielzugänge sind ausschließlich für lokale Entwicklung vorgesehen.

## Konfiguration

Die Variablen sind in `.env.example` dokumentiert. Die Anwendung lädt `.env` nicht selbst; Variablen werden von Shell, Compose oder Secret-Management gesetzt.

- `PUBLIC_ORIGIN`: exakte öffentliche HTTPS-Origin für Invite-Links und WebSocket-Origin-Prüfung.
- `AUTH_MODE`: `required`, `optional` oder `disabled`; Compose verwendet `required`, direkter Node-Start standardmäßig `disabled`.
- `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_CLIENT_ID`: browserseitig sichtbare, exakt geprüfte OIDC-Autorität.
- `OIDC_JWKS_URL`: optional getrennte interne JWKS-Adresse, etwa der Compose-Service `keycloak`.
- `SESSION_TICKET_TTL_MS`, `DEVICE_PROOF_MAX_AGE_MS`: enge Gültigkeitsfenster für Ticket und signierten Gerätenachweis.
- `STUN_URLS`: kommaseparierte STUN-URLs.
- `TURN_URLS`, `TURN_SHARED_SECRET`, `TURN_REALM`, `TURN_CREDENTIAL_TTL_MS`: Coturn-REST-Credentials mit HMAC und kurzer Gültigkeit.
- `TURN_SERVERS_JSON`: optionales statisches `RTCIceServer`-Array für ausdrücklich kontrollierte Tests; nicht für Produktion empfohlen.
- `MAX_ROOM_PARTICIPANTS`: Betreiberlimit von 2 bis höchstens 20; Default ist 20.
- `ROOM_IDLE_TTL_MS`: Obergrenze für inaktive Room-Metadaten.
- `SIGNAL_RATE_LIMIT`: Nachrichten je Peer und 10 Sekunden.

Beispiel für einen externen Coturn-Dienst:

```bash
TURN_URLS='turns:turn.example.org:5349' \
TURN_SHARED_SECRET='aus-secret-management' \
TURN_REALM='call.example.org' npm start
```

Das Shared Secret bleibt ausschließlich auf Server und Coturn. Der Browser erhält erst nach autorisiertem `POST /api/sessions` einen zeitlich begrenzten Benutzernamen und das zugehörige HMAC-Credential.

### Kapazitätsgrenze

20 ist die harte Membership-Grenze je Raum, keine garantierte Medienqualität. Im aktuellen Full-Mesh hält jeder Teilnehmer bis zu 19 `RTCPeerConnection`-Verbindungen und ein Sender kann dieselbe Medienquelle bis zu 19-mal hochladen. Für zuverlässig hohe Videoqualität bei vollen Räumen ist der im Backlog geführte SFU-Pfad vorgesehen.

## Öffentliches Deployment

Für ein öffentliches Deployment müssen ein HTTPS-Reverse-Proxy WebSocket-Upgrades für `/signal` durchreichen, `PUBLIC_ORIGIN` exakt gesetzt und Keycloak sowie Coturn mit produktiver Datenbank, TLS, gesicherten Adminzugängen und Secret-Management betrieben werden. `TURN_EXTERNAL_IP` muss die von Clients erreichbare Adresse enthalten; für TURN/TLS werden `turns:` und ein gültiges Zertifikat benötigt. Der lokale Compose-Stack ist keine unveränderte Produktionsvorlage.

## API

- `GET /`: Browser-App
- `GET /healthz`: inhaltsfreier Health-/Room-Zähler
- `GET /config`: öffentliche ICE-Konfiguration
- `POST /api/rooms`: nach Auth-Policy einen flüchtigen Room- oder Pair-Invite erstellen
- `POST /api/sessions`: Bearer-Token und P-256-Gerätebeweis prüfen; Einmal-Ticket und kurzlebige TURN-Credentials ausstellen
- `GET /signal?ticket=…`: WebSocket-Signaling mit einmal verwendbarem Session-Ticket

## Sicherheitsstatus

Im `required`- oder `optional`-Modus prüft der Server Access Tokens über JWKS auf Signatur, erlaubten Algorithmus, Issuer, Audience, Ablaufzeit und Subject. Join-Nachweise werden zusätzlich durch eine nicht exportierbare Browser-P-256-Identität signiert. WebRTC verschlüsselt Medien mit DTLS-SRTP und DataChannels mit DTLS/SCTP. Signaling und TURN sehen notwendige Verbindungsmetadaten, aber TURN erhält keine Membership-Autorität. Eine zusätzliche Insertable-Streams-/SFrame-Frameverschlüsselung ist noch nicht implementiert und wird nicht behauptet.

Die vollständige Herkunfts- und Lückenmatrix steht in [docs/ananta-webrtc-adoption.md](docs/ananta-webrtc-adoption.md). Produktionsschritte stehen schema-validiert unter `todos/backlog/`.

## Entwicklung

`AGENTS.md` macht das Todo-Tracking verbindlich. Der vollständige lokale Gate ist:

```bash
npm run check
npm audit --omit=dev
docker compose config --quiet
docker build --tag webrtc-room-server:local .
```

`npm run check` umfasst Todo-/Workflow-Schemas, Angular-Unit-Tests, Angular-Produktionbuild, Node-Unit-/Integrationstests sowie zwei echte Chromium-E2E-Szenarien für Room und Pair Dev. Fehlt Chromium, wird der Browserteil mit sichtbarer Begründung übersprungen.

Der Live-Infrastruktur-Gate startet absichtlich nicht implizit. Mit laufendem Compose-Stack, einer eigens angelegten Testidentität und expliziten Variablen prüft er Keycloak Discovery, PKCE-Login, JWKS-Tokenprüfung, autorisierte Einmal-Tickets sowie eine echte Coturn-Relay-Allokation:

```bash
export KEYCLOAK_ADMIN_PASSWORD='lokales-admin-passwort'
export LIVE_OIDC_USERNAME='webrtc-gate'
export LIVE_OIDC_PASSWORD='eigenes-lokales-testpasswort'
bash scripts/prepare-live-keycloak-user.sh
RUN_LIVE_INFRASTRUCTURE=1 npm run test:infrastructure
```

Die erforderlichen Variablen stehen in `.env.example`; produktive Konten oder Secrets dürfen für diesen Gate nicht verwendet werden. GitHub Actions führt denselben Test mit einem vollständig ephemeren Stack aus.

## Lizenz

Dieses Projekt steht unter der [BSD-3-Clause-Lizenz](LICENSE). Copyright © 2026 Peter Stuiber.
