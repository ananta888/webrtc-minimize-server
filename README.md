# WebRTC Minimize Server

[![CI](https://github.com/ananta888/webrtc-minimize-server/actions/workflows/ci.yml/badge.svg)](https://github.com/ananta888/webrtc-minimize-server/actions/workflows/ci.yml)

Ein eigenständiger, Keycloak-fähiger Raumserver mit Angular-Oberfläche für Audio, Video, Bildschirmfreigabe und Peer-Chat. Der Node-Server autorisiert Membership, Topologie und SDP/ICE, terminiert aber keine Medien. Audio, Video und Chat laufen direkt zwischen Browsern, über ausdrücklich erlaubte Browser-Relays oder bei schwierigen NAT-/Firewall-Pfaden über Coturn.

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

## Adaptive Bandbreite und Active Speaker

Normale Räume verwenden weiterhin eine isolierte PeerConnection je Gegenüber, übertragen aber nicht mehr zwangsläufig jede Kamera in voller Qualität zu jedem Peer:

- lokale Audioanalyse verteilt ausschließlich begrenzte Aktivitätswerte über einen eigenen Control-DataChannel;
- Sprecher 1–2 erhalten Focus-, Sprecher 3–5 Balanced-Qualität;
- inaktive Kameras werden abhängig von Raumgröße, Profil und Linkzustand auf Thumbnail reduziert oder pausiert;
- Screenshare hat Vorrang vor Kameravideo; Mikrofon und Control behalten ein eigenes Mindestbudget;
- WebRTC-Stats können Qualität nur absenken; Recovery benötigt eine stabile Haltezeit;
- höchstens fünf Fokusvideos bleiben einzeln sichtbar, die übrigen Kameras werden in genau einem lokalen Canvas-Mosaik dargestellt;
- `Auto`, `Ausgewogen` und `Datensparend` können ohne erneuten Capture-Aufruf gewechselt werden.

Das Canvas allein spart keine Netzwerkbytes. Die Ersparnis entsteht aus den gleichzeitig angewandten Senderstufen `focus`, `balanced`, `thumbnail` und `paused`.

Ab sechs Teilnehmern kann die Control Plane einen zyklusfreien Video-Relay-Baum mit begrenzter Kinder- und Hopzahl ausstellen. Das geschieht nur, wenn der Betreiber den Pfad erlaubt und genügend Browser ihre separate Relay-Zustimmung erteilen. Bei fehlender Zustimmung, Capability, Membership oder nach einem Leave fällt jede Publikation epochgebunden auf das adaptive Mesh zurück. Ein Trusted Relay verarbeitet und re-encodiert empfangene Medien; es ist daher kein nicht entschlüsselnder SFrame-Relay und wird in der UI entsprechend erklärt.

## Öffentliche Ananta-Voreinstellung

Das Compose-Deployment verwendet ohne Domain-Overrides bereits diese öffentlichen Endpunkte:

- Anwendung: `https://webrtc.ananta.de`
- Identity Provider: `https://keycloak.ananta.de/realms/ananta`
- Browser-Client: `webrtc-browser`
- Access-Token-Audience: `webrtc-room-server`

Die OIDC-Discovery des Realms ist öffentlich erreichbar. Damit der Login funktioniert, muss der öffentliche Keycloak-Client zusätzlich im Realm `ananta` registriert sein; DNS und HTTPS für `webrtc.ananta.de` müssen auf dieses Deployment zeigen. Das Repository verändert den externen Realm nicht automatisch.

Die passende, geschlossene Keycloak-Clientdefinition lässt sich ohne Secret erzeugen:

```bash
npm run --silent keycloak:client-config
```

Sie enthält exakt `https://webrtc.ananta.de/oidc-callback`, den Web Origin, PKCE S256 und den Audience-Mapper. Ein Realm-Administrator kann die Ausgabe über Keycloak Admin oder `kcadm.sh` importieren. Für eigene Domains werden nur die Betreiberwerte ersetzt:

```dotenv
PUBLIC_ORIGIN=https://call.example.org
KEYCLOAK_ORIGIN=https://login.example.org
KEYCLOAK_REALM=company
OIDC_CLIENT_ID=webrtc-browser
OIDC_AUDIENCE=webrtc-room-server
```

`OIDC_ISSUER` bleibt normalerweise leer und wird daraus als `KEYCLOAK_ORIGIN/realms/KEYCLOAK_REALM` abgeleitet. Ein explizites `OIDC_ISSUER` hat für abweichende Provider Vorrang. `OIDC_JWKS_URL` bleibt normalerweise ebenfalls leer und wird aus dem exakt geprüften Issuer abgeleitet.

## Vollständiger lokaler Stack

Das öffentliche Standardprofil startet nur die Anwendung. Das ausdrücklich gewählte Profil `local` ergänzt Keycloak 26.6.1 und Coturn 4.6.3 mit localhost-Werten:

```bash
cp .env.local.example .env
# Vor gemeinsamem oder öffentlichem Betrieb mindestens alle Beispielpasswörter
# und TURN_SHARED_SECRET ersetzen.
docker compose --profile local up --build
```

Danach:

- Anwendung: `http://localhost:8080`
- Keycloak: `http://localhost:8081`
- STUN/TURN: `localhost:3478` über UDP und TCP
- Relay-UDP-Ports: `49160-49200`

Im Browser `Mit Keycloak anmelden` wählen und bei Bedarf über Keycloak ein Konto registrieren. Der importierte öffentliche Client verwendet Authorization Code Flow mit PKCE S256; Implicit Flow und Direct Access Grants sind deaktiviert. `start-dev`, die H2-Datenbank, unverschlüsseltes lokales TURN und die Beispielzugänge sind ausschließlich für lokale Entwicklung vorgesehen.

## Konfiguration

Die öffentliche Voreinstellung steht in `.env.example`, das getrennte localhost-Profil in `.env.local.example`. Die Anwendung lädt `.env` nicht selbst; Variablen werden von Shell, Compose oder Secret-Management gesetzt.

- `PUBLIC_ORIGIN`: exakte öffentliche HTTPS-Origin für Invite-Links und WebSocket-Origin-Prüfung.
- `AUTH_MODE`: `required`, `optional` oder `disabled`; Compose verwendet `required`, direkter Node-Start standardmäßig `disabled`.
- `KEYCLOAK_ORIGIN`, `KEYCLOAK_REALM`: leicht austauschbare Kurzform, aus der der OIDC-Issuer gebildet wird; beide müssen gemeinsam gesetzt sein.
- `OIDC_AUDIENCE`, `OIDC_CLIENT_ID`: browserseitig sichtbare und serverseitig exakt geprüfte Clientwerte.
- `OIDC_ISSUER`: optionaler vollständiger Issuer-Override mit Vorrang vor der Keycloak-Kurzform.
- `OIDC_JWKS_URL`: optional getrennte interne JWKS-Adresse, etwa der lokale Compose-Service `keycloak`; öffentlich wird sie sicher aus dem Issuer abgeleitet.
- `SESSION_TICKET_TTL_MS`, `DEVICE_PROOF_MAX_AGE_MS`: enge Gültigkeitsfenster für Ticket und signierten Gerätenachweis.
- `STUN_URLS`: kommaseparierte STUN-URLs.
- `TURN_URLS`, `TURN_SHARED_SECRET`, `TURN_REALM`, `TURN_CREDENTIAL_TTL_MS`: Coturn-REST-Credentials mit HMAC und kurzer Gültigkeit.
- `TURN_SERVERS_JSON`: optionales statisches `RTCIceServer`-Array für ausdrücklich kontrollierte Tests; nicht für Produktion empfohlen.
- `MAX_ROOM_PARTICIPANTS`: Betreiberlimit von 2 bis höchstens 20; Default ist 20.
- `ROOM_IDLE_TTL_MS`: Obergrenze für inaktive Room-Metadaten.
- `SIGNAL_RATE_LIMIT`: Nachrichten je Peer und 10 Sekunden.
- `ACTIVE_SPEAKER_LIMIT`: Zahl einzeln fokussierter Sprecher, begrenzt auf 2 bis 5.
- `PEER_MEDIA_RELAY_ENABLED`: Betreiberfreigabe für Trusted Peer Relay; Nutzerzustimmung bleibt trotzdem standardmäßig aus.
- `PEER_MEDIA_RELAY_MIN_PARTICIPANTS`: kleinste Raumgröße für einen Relay-Baum, Default 6.
- `PEER_MEDIA_RELAY_MAX_CHILDREN`, `PEER_MEDIA_RELAY_MAX_HOPS`: harte Fanout- und Tiefengrenzen.

Beispiel für einen externen Coturn-Dienst:

```bash
TURN_URLS='turns:turn.example.org:5349' \
TURN_SHARED_SECRET='aus-secret-management' \
TURN_REALM='call.example.org' npm start
```

Das Shared Secret bleibt ausschließlich auf Server und Coturn. Der Browser erhält erst nach autorisiertem `POST /api/sessions` einen zeitlich begrenzten Benutzernamen und das zugehörige HMAC-Credential.

### Kapazitätsgrenze

20 ist die harte Membership-Grenze je Raum, keine garantierte Medienqualität. Jeder Teilnehmer hält für direkten Control-, Chat- und Audiotransport weiterhin bis zu 19 `RTCPeerConnection`-Verbindungen. Kamera und Screenshare werden jedoch nach Active-Speaker-, Link- und Nutzerprofil gedrosselt; ein autorisierter Trusted-Relay-Baum begrenzt den direkten Video-Fanout des Publishers standardmäßig auf drei Kinder. Relay-Peers übernehmen dafür zusätzliche CPU-, Akku- und Uploadlast. Für nicht vertrauenswürdige Relays, zusätzliche Frame-E2EE oder garantierte Großraumqualität bleiben SFrame beziehungsweise ein optionaler SFU-Fallback im Backlog.

## Öffentliches Deployment

Für das Ananta-Preset muss ein HTTPS-Reverse-Proxy `webrtc.ananta.de` auf Port 8080 weiterleiten und WebSocket-Upgrades für `/signal` durchreichen. Für eine eigene Installation werden `PUBLIC_ORIGIN`, `KEYCLOAK_ORIGIN` und gegebenenfalls `KEYCLOAK_REALM` in `.env` ersetzt; dieselbe Origin muss in der erzeugten Keycloak-Clientdefinition registriert werden. Keycloak und Coturn benötigen produktive Datenbank, TLS, gesicherte Adminzugänge und Secret-Management. `TURN_EXTERNAL_IP` muss die von Clients erreichbare Adresse enthalten; für TURN/TLS werden `turns:` und ein gültiges Zertifikat benötigt. Der lokale Compose-Stack ist keine unveränderte Produktionsvorlage.

## API

- `GET /`: Browser-App
- `GET /healthz`: inhaltsfreier Health-/Room-Zähler
- `GET /config`: öffentliche ICE-Konfiguration
- `POST /api/rooms`: nach Auth-Policy einen flüchtigen Room- oder Pair-Invite erstellen
- `POST /api/sessions`: Bearer-Token und P-256-Gerätebeweis prüfen; Einmal-Ticket und kurzlebige TURN-Credentials ausstellen
- `GET /signal?ticket=…`: WebSocket-Signaling mit einmal verwendbarem Session-Ticket

## Sicherheitsstatus

Im `required`- oder `optional`-Modus prüft der Server Access Tokens über JWKS auf Signatur, erlaubten Algorithmus, Issuer, Audience, Ablaufzeit und Subject. Join-Nachweise werden zusätzlich durch eine nicht exportierbare Browser-P-256-Identität signiert. WebRTC verschlüsselt Medien auf jedem direkten, TURN- oder Trusted-Relay-Hop mit DTLS-SRTP und DataChannels mit DTLS/SCTP. Ein zustimmender Relay-Browser kann weitergeleitete Medien verarbeiten; eine zusätzliche Insertable-Streams-/SFrame-Frameverschlüsselung gegen diesen Relay ist noch nicht implementiert und wird nicht behauptet.

Die vollständige Herkunfts- und Lückenmatrix steht in [docs/ananta-webrtc-adoption.md](docs/ananta-webrtc-adoption.md). Produktionsschritte stehen schema-validiert unter `todos/backlog/`.

## Entwicklung

`AGENTS.md` macht das Todo-Tracking verbindlich. Der vollständige lokale Gate ist:

```bash
npm run check
npm audit --omit=dev
docker compose config --quiet
docker compose --profile local --env-file .env.local.example config --quiet
docker build --tag webrtc-room-server:local .
```

`npm run check` umfasst Todo-/Workflow-Schemas, Angular-Unit-Tests, Angular-Produktionbuild und Node-/Integrationstests. Die Browsermatrix prüft Room, Pair Dev und einen realen Sechs-Chromium-Relay-Baum einschließlich Sender-Fanout, Active Speaker, Datensparprofil, Mosaik und Churn-Fallback; zwei Firefox-Peers belegen den kompatiblen Direct-/Adaptive-Mesh-Pfad. Fehlende Browser werden ausschließlich mit sichtbarer Begründung übersprungen.

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
