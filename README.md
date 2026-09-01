# WebRTC Minimize Server

[![CI](https://github.com/ananta888/webrtc-minimize-server/actions/workflows/ci.yml/badge.svg)](https://github.com/ananta888/webrtc-minimize-server/actions/workflows/ci.yml)

Ein eigenständiger, Keycloak-fähiger Raumserver mit Angular-Oberfläche für Audio, Video, Bildschirmfreigabe und Peer-Chat. Der Node-Server autorisiert Membership, Topologie und SDP/ICE, terminiert aber keine Medien. Jede PeerConnection versucht zuerst einen direkten Pfad, danach freiwillige Edge-TURN-Knoten und erst zuletzt Infrastruktur-TURN. Audio-, Kamera- und Bildschirmframes sind im Standardmodus zusätzlich mit RFC-9605-SFrame Ende-zu-Ende verschlüsselt.

## Lokal starten

Voraussetzung: Node.js 22.5 oder neuer (für den eingebauten SQLite-Workspace-Store). Der anonyme Entwicklungsmodus benötigt keine externe Infrastruktur:

```bash
npm install
npm run build
npm start
```

Danach `http://localhost:8080` in zwei Browserfenstern öffnen. `npm start` verwendet ohne weitere Environment-Variablen bewusst `AUTH_MODE=disabled`; auch dann wird jeder Join durch eine im Browser erzeugte, nicht exportierbare P-256-Geräteidentität signiert. `localhost` gilt als sicherer Entwicklungskontext. Andere Geräte benötigen HTTPS/WSS.

Medien werden niemals automatisch angefordert. Mikrofon, Kamera und Bildschirm starten nur über ihre jeweiligen Buttons. Beim Verlassen stoppt die App alle eigenen Tracks.

Bildschirmfreigabe ist standardmäßig video-only. Bildschirmton muss unter `Einstellungen → Video & Bandbreite` separat und bewusst aktiviert werden, weil Tab- oder Systemaudio den laufenden Gesprächston erneut in den Raum senden und dadurch Echo erzeugen kann. Das Opt-in allein startet keinen Capture-Aufruf und gilt beim nächsten Bildschirm-teilen-Klick. Wird es während einer Freigabe ausgeschaltet, stoppt ausschließlich der Bildschirm-Audiotrack; das geteilte Bild läuft weiter. Unterstützte Browser werden zusätzlich um `restrictOwnAudio` gebeten, diese experimentelle Eigentonfilterung ist jedoch nur Zusatzschutz und keine portable Echo-Garantie. Für Bildschirmton werden Kopfhörer empfohlen.

## Räume

Ein normaler Raum erhält einen Namen, einen kryptografisch zufälligen Einladungslink und die Sichtbarkeit `private` oder `public`. Öffentliche Räume kann jeder Besucher ohne Token im Raumverzeichnis sehen; angemeldete Nutzer sehen daneben alle von ihrer exakten OIDC-Identität erstellten Räume. Nur dieser Ersteller darf Name oder Sichtbarkeit ändern. `private` entfernt einen Raum aus der öffentlichen Liste, widerruft aber keinen bereits bekannten Bearer-Invite. Für einen echten Widerruf muss ein neuer Raumcode verwendet werden.

Ein Raum entsteht flüchtig beim ersten Join, besitzt eine vollständig getrennte Teilnehmerliste und akzeptiert standardmäßig höchstens 20 gleichzeitig verbundene Browser. Signale können ausschließlich an Teilnehmer desselben Raums adressiert werden. Es gibt keine anwendungsseitige Obergrenze für die Anzahl gleichzeitig aktiver Räume; praktisch begrenzen nur die verfügbaren Serverressourcen. Leere Membership wird sofort verworfen. Die ebenfalls nur im Arbeitsspeicher gehaltenen Verzeichnismetadaten bleiben nach der letzten Aktivität höchstens `ROOM_IDLE_TTL_MS` erhalten und gehen bei einem Serverneustart verloren; Membership, Medien und Raumverlauf werden nicht persistiert.

`Neue Pair-Session` erzeugt einen eigenen Sessiontyp für Pair Dev. Er akzeptiert höchstens zwei unterschiedliche P-256-Geräte. Ein vorhandener Raum kann nicht zwischen Pair- und Room-Modus wechseln; derselbe Gerätefingerprint darf nicht zweimal derselben Pair-Session beitreten.

Angemeldete Nutzer können zusätzlich einen persistenten Pair-Workspace anlegen. Der OIDC-Issuer bildet die Tenant-Grenze; der Ersteller wird Owner und genau ein authentifizierter Einladungsnutzer Editor. Owner, Editor und Viewer werden bei jeder Operation neu geprüft. Membership-Änderungen verwenden eine Compare-and-Set-Revision; Timeline-Events sind idempotent und entstehen atomar mit einem Outbox-Eintrag. Monotone Read-Cursor und kurzlebige, epochgebundene Presence-Leases überleben einen Serverneustart. Persistiert werden ausschließlich Workspace-Metadaten und ausdrücklich gespeicherte Events, niemals Medien oder übertragene Dateiinhalte.

Vor jedem WebSocket-Upgrade autorisiert `POST /api/sessions` Identität, Gerät, Raum, Modus und Origin. Das Access Token wird niemals in eine WebSocket-URL geschrieben. Stattdessen erhält der Browser ein zufälliges, kurzlebiges und nur einmal verwendbares Signaling-Ticket.

## Adaptive Bandbreite und Active Speaker

Normale Räume verwenden weiterhin eine isolierte PeerConnection je Gegenüber, übertragen aber nicht mehr zwangsläufig jede Kamera in voller Qualität zu jedem Peer:

- lokale Audioanalyse verteilt ausschließlich begrenzte Aktivitätswerte über einen eigenen Control-DataChannel;
- Sprecher 1–2 erhalten Focus-, Sprecher 3–5 Balanced-Qualität;
- inaktive Kameras werden abhängig von Raumgröße, Profil und Linkzustand reduziert; bei bis zu fünf Teilnehmern halten `Auto` und `Ausgewogen` mindestens ein bewegtes Thumbnail (vor Prioritätsgewichtung 400 kbit/s, 12 FPS und vierfache Skalierung), während größere Räume und das explizite Datensparprofil weiterhin aggressiv reduzieren oder pausieren dürfen;
- die gewählte Medienstrategie ordnet Mikrofon, Screenshare und Kamera relativ; Sprache behält unabhängig von der Reihenfolge ein eigenes Mindestbudget;
- WebRTC-Stats können Qualität nur absenken; eine niedrige Bandbreitenschätzung allein führt höchstens zu `constrained`, während `critical` starke RTT- oder Verlustwerte benötigt. Recovery benötigt eine stabile Haltezeit;
- höchstens fünf Fokusvideos bleiben einzeln sichtbar, die übrigen Kameras werden in genau einem lokalen Canvas-Mosaik dargestellt;
- `Auto`, `Ausgewogen` und `Datensparend` können ohne erneuten Capture-Aufruf gewechselt werden.

Unter `Einstellungen → Medienstrategie` stehen die Presets `Gespräch`, `Präsentation`, `Ausgewogen`, `Kamera-Fokus`, `Datensparen` und `Musik / Studio` bereit. Jedes Preset verbindet ein Audioprofil, die adaptive Video-Regel und eine eindeutige Reihenfolge für Mikrofon, Bildschirm und Kamera. Jede einzelne Auswahl kann geändert werden; dann speichert der Browser eine benutzerdefinierte Strategie. Ein Positionswechsel tauscht Quellen, statt doppelte oder fehlende Prioritäten zuzulassen.

Die Audioprofile setzen best-effort Capture-Ziele sowie Senderobergrenzen: sparsame Sprache verwendet Mono und 24 kbit/s, klare Sprache Mono und 48 kbit/s, Musik Stereo und 128 kbit/s. Ein aktives Mikrofon wird per `applyConstraints()` ohne neuen Capture-Aufruf angepasst; angezeigt werden ausschließlich die anschließend von `getSettings()` gemeldeten tatsächlichen Werte. Das Musikprofil deaktiviert bewusst Echo-, Rausch- und Pegelfilter und ist deshalb nur mit Kopfhörern empfohlen. Die Reihenfolge wird zusätzlich als `high`, `medium` und `low` an die RTP-Sender übergeben und begrenzt Video-Bitrate/FPS passend zur Quelle. Diese Prioritäten beeinflussen lokale Bandbreitenzuteilung und gegebenenfalls DSCP, sind aber keine QoS-Garantie; Browser und Netz dürfen sie teilweise ignorieren. Fällt die Priority-Erweiterung aus, bleiben die getesteten Senderobergrenzen aktiv. Audio wird nie allein wegen einer niedrigen Position deaktiviert und behält mindestens 20 kbit/s.

Unter `Einstellungen → Video & Bandbreite` lassen sich Kamera und Bildschirm zusätzlich getrennt begrenzen. Verfügbar sind `Automatisch` sowie 240p, 360p, 480p, 540p, 720p, 900p, 1080p, 1440p und 2160p; die FPS-Obergrenzen reichen von 2 bis 60. Die Auswahl wird nur lokal im Browser gespeichert und startet keine Aufnahme. Bei einem bereits aktiven Track verwendet die Anwendung `applyConstraints()` ohne einen weiteren Berechtigungsdialog und zeigt die danach von `getSettings()` gemeldete tatsächliche Auflösung und Bildrate. Die Werte sind Obergrenzen: Browser und adaptive Sendersteuerung dürfen darunter bleiben. Insbesondere 360p mit 5–10 FPS oder 240p mit 2–5 FPS reduziert den Upload deutlich, eignet sich aber eher für ruhige Bilder als für flüssige Bewegung.

Das Canvas allein spart keine Netzwerkbytes. Die Ersparnis entsteht aus den gleichzeitig angewandten Senderstufen `focus`, `balanced`, `thumbnail` und `paused`.

Ab sechs Teilnehmern kann die Control Plane im expliziten Legacy-Modus `MEDIA_E2EE_MODE=disabled` einen zyklusfreien Video-Relay-Baum mit begrenzter Kinder- und Hopzahl ausstellen. Membership-, Route- und Topology-Epochen sind getrennt; jede Publikationsroute besitzt eine kurzlebige Lease, Primary und – soweit topologisch möglich – Backup. Relay-Auswahl berücksichtigt ausdrückliche Zustimmung, Sichtbarkeit, Energie-/Netzklasse, Eigenkapazität und beobachtete Lieferqualität. Dieser Browser-Relay dekodiert und re-encodiert fremde Medien und ist daher nicht blind. In den Modi `required` und `preferred` bleibt er deaktiviert; dort transportieren Direct-, Edge-TURN- und Infrastruktur-TURN-Pfade SFrame-Ciphertext.

Pair-Sessions besitzen daneben einen eigenständigen Daten-Overlay-Kanal. Jeder Browser erzeugt pro Session einen nicht exportierbaren ECDH-P-256-Schlüssel und verschlüsselt Events oder bewusst ausgewählte Dateien mit AES-GCM für den Zielpeer. Zwischenbrowser sehen nur Ciphertext und begrenzte Routing-Metadaten. Digest, TTL, Membership-/Route-Epoch, schleifenfreier Pfad, Hopzahl, Replay-Fenster, Chunkzahl und per Traffic-Class begrenzte Queues werden geprüft. Fehlende Chunks werden verschlüsselt quittiert und gezielt erneut gesendet; ohne nutzbare Relay-Route wird direkt, aber weiterhin Ende-zu-Ende verschlüsselt übertragen. Ein Download startet ausschließlich durch einen weiteren Nutzerklick.

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
- `EDGE_TURN_SERVERS_JSON`: serverseitige Liste freiwilliger Edge-TURN-Knoten mit `id`, `urls`, `realm` und jeweiligem `sharedSecret`; Secrets werden niemals an den Browser ausgegeben.
- `PEER_EDGE_FALLBACK_MS`, `INFRASTRUCTURE_TURN_FALLBACK_MS`: begrenzte Eskalation von Direct/STUN zu Edge und anschließend Infrastruktur-TURN; der zweite Wert muss größer sein.
- `MEDIA_E2EE_MODE`: `required` (Default, kein Klartext-Fallback), `preferred` (sichtbarer Fallback nur ohne Encoded-Transform-Capability) oder `disabled` (Legacy-Relay, keine Frame-E2EE).
- `MAX_ROOM_PARTICIPANTS`: Betreiberlimit von 2 bis höchstens 20; Default ist 20.
- `ROOM_IDLE_TTL_MS`: Obergrenze für inaktive Room-Metadaten.
- `SIGNAL_RATE_LIMIT`: Nachrichten je Peer und 10 Sekunden.
- `ACTIVE_SPEAKER_LIMIT`: Zahl einzeln fokussierter Sprecher, begrenzt auf 2 bis 5.
- `PEER_MEDIA_RELAY_ENABLED`: Betreiberfreigabe für Trusted Peer Relay; Nutzerzustimmung bleibt trotzdem standardmäßig aus.
- `PEER_MEDIA_RELAY_MIN_PARTICIPANTS`: kleinste Raumgröße für einen Relay-Baum, Default 6.
- `PEER_MEDIA_RELAY_MAX_CHILDREN`, `PEER_MEDIA_RELAY_MAX_HOPS`: harte Fanout- und Tiefengrenzen.
- `PEER_ROUTE_LEASE_MS`, `PEER_ROUTE_RENEW_MS`: Lease-Gültigkeit und frühere Erneuerung; Renewal muss kürzer sein.
- `PEER_RELAY_HEALTH_WINDOW_MS`, `PEER_RELAY_HEALTH_COOLDOWN_MS`: Quorum-Beobachtungsfenster und Failover-Cooldown.
- `PEER_DATA_OVERLAY_ENABLED`: schaltet nur den browserseitig E2EE-geschützten Daten-Overlay ab; Direct Chat/Control bleiben erhalten.
- `PAIR_WORKSPACE_ENABLED`, `PAIR_WORKSPACE_DB`: optionaler persistenter Pair-Workspace und Pfad seines SQLite-Volumes.

Beispiel für einen externen Coturn-Dienst:

```bash
TURN_URLS='turns:turn.example.org:5349' \
TURN_SHARED_SECRET='aus-secret-management' \
TURN_REALM='call.example.org' npm start
```

Das Shared Secret bleibt ausschließlich auf Server und Coturn. Der Browser erhält erst nach autorisiertem `POST /api/sessions` einen zeitlich begrenzten Benutzernamen und das zugehörige HMAC-Credential.

### Freiwilliger Edge-Agent

Unter [`edge-agent/`](edge-agent/) liegt ein optionaler nativer TURN-Agent auf Basis von Pion. Ein geeigneter Rechner kann damit freiwillig zum bevorzugten zweiten ICE-Pfad werden. Er erhält keine Room-Membership, keine OIDC-Tokens und keine SFrame-Schlüssel; er leitet nur WebRTC-Pakete weiter. Globales und nutzerbezogenes Allocation-Limit, feste UDP-Relay-Ports, kurzlebige REST-Credentials und eine standardmäßige Sperre privater Zielnetze begrenzen den Dienst.

Der Rechner muss von den anderen Teilnehmern erreichbar sein: per öffentlicher IPv6-Adresse oder per IPv4-Portweiterleitung für `3478/udp`, optional `3478/tcp` und den konfigurierten UDP-Relay-Bereich. Ein Rechner hinter CGNAT ohne öffentliche IPv6-Adresse, Portmapping oder vorgelagerten Relay kann nicht allein durch den Agent zum erreichbaren Relay werden. Installation, Firewall, Secret-Kopplung und Verifikation beschreibt [docs/edge-agent.md](docs/edge-agent.md).

Beispiel für die ausschließlich serverseitige Registrierung eines Agenten:

```dotenv
EDGE_TURN_SERVERS_JSON='[{"id":"edge-1","urls":["turn:edge.example.org:3478?transport=udp","turn:edge.example.org:3478?transport=tcp"],"sharedSecret":"aus-secret-management","realm":"webrtc.ananta.de"}]'
```

### Kapazitätsgrenze

20 ist die harte Membership-Grenze je Raum, keine garantierte Medienqualität. Im SFrame-Standardpfad hält jeder Teilnehmer weiterhin bis zu 19 `RTCPeerConnection`-Verbindungen; Kamera und Screenshare werden nach Active-Speaker-, Link- und Nutzerprofil gedrosselt. SFrame schützt Inhalte, reduziert aber weder Verbindungszahl noch Publisher-Fanout. Der freiwillige Edge-Agent verbessert Erreichbarkeit bei schwierigen NAT-/Firewall-Pfaden, nicht die Mesh-Skalierung; ein geeigneter nativer Host kann seine begrenzten Port-Leases optional per PCP selbst erneuern. Ein portabler, browserübergreifender Ciphertext-Medien-DAG und ein optionaler SFU-Fallback für garantierte Großraumqualität bleiben im Backlog. Nur der nicht blinde Legacy-Relay kann derzeit direkten Video-Fanout reduzieren.

## Öffentliches Deployment

Für das Ananta-Preset muss ein HTTPS-Reverse-Proxy `webrtc.ananta.de` auf Port 8080 weiterleiten und WebSocket-Upgrades für `/signal` durchreichen. Für eine eigene Installation werden `PUBLIC_ORIGIN`, `KEYCLOAK_ORIGIN` und gegebenenfalls `KEYCLOAK_REALM` in `.env` ersetzt; dieselbe Origin muss in der erzeugten Keycloak-Clientdefinition registriert werden. Keycloak und Coturn benötigen produktive Datenbank, TLS, gesicherte Adminzugänge und Secret-Management. `TURN_EXTERNAL_IP` muss die von Clients erreichbare Adresse enthalten; für TURN/TLS werden `turns:` und ein gültiges Zertifikat benötigt. Der lokale Compose-Stack ist keine unveränderte Produktionsvorlage.

## API

- `GET /`: Browser-App
- `GET /healthz`: inhaltsfreier Health-/Room-Zähler
- `GET /config`: öffentliche ICE-Konfiguration
- `GET /api/rooms`: öffentliche Räume und – mit gültigem Bearer-Token – die eigenen Räume auflisten
- `POST /api/rooms`: privaten/öffentlichen Room-Invite, Pair-Invite oder authentifizierten persistenten Pair-Workspace erstellen
- `PATCH /api/rooms/:roomId`: Name oder Sichtbarkeit ausschließlich als verifizierter Room-Owner ändern
- `POST /api/sessions`: Bearer-Token und P-256-Gerätebeweis prüfen; Einmal-Ticket und kurzlebige TURN-Credentials ausstellen
- `GET /api/workspaces`, `GET /api/workspaces/:id`: eigene Workspaces und revisionierte Membership lesen
- `GET|POST /api/workspaces/:id/events`: permission-aware Timeline fortsetzen oder idempotentes Event schreiben
- `PUT /api/workspaces/:id/cursor|presence`: monotonen Cursor beziehungsweise epochgebundene Presence-Lease setzen
- `POST /api/workspaces/:id/roles`: Rolle mit erwarteter Membership-Revision ändern oder widerrufen
- `GET /signal?ticket=…`: WebSocket-Signaling mit einmal verwendbarem Session-Ticket

## Sicherheitsstatus

Im `required`- oder `optional`-Auth-Modus prüft der Server Access Tokens über JWKS auf Signatur, erlaubten Algorithmus, Issuer, Audience, Ablaufzeit und Subject. Join-Nachweise werden zusätzlich durch eine nicht exportierbare Browser-P-256-Identität signiert. WebRTC verschlüsselt jeden Direct-/TURN-Pfad mit DTLS-SRTP beziehungsweise DTLS/SCTP. Im standardmäßigen Media-Modus `required` schützt RFC-9605-SFrame Audio-, Kamera- und Bildschirmframes zusätzlich mit `AES_128_GCM_SHA256_128`; Key-Material wird pro Publikation, Zielpeer und Membership-Epoch erzeugt, ausschließlich im zielpeergebundenen ECDH-/AES-GCM-Overlay verteilt und erst nach ACK verwendet. Unbekannte KIDs, Authentifizierungsfehler und Replays werden verworfen. Fehlende Browser-Capability oder fehlende ACK ergibt fehlende Medien statt Klartext.

Die Peer-Public-Key-Zuordnung für diesen Overlay stammt weiterhin aus dem authentisierten Signaling-Pfad. Damit verbirgt SFrame Inhalte vor ehrlichen, aber neugierigen TURN-, Edge- und Control-Plane-Betreibern; es beweist keine Ende-zu-Ende-Identität gegen einen vollständig kompromittierten Signaling-Server. `MEDIA_E2EE_MODE=disabled` aktiviert bewusst den alten Decode/Re-encode-Relay und besitzt diese Frame-E2EE-Eigenschaft nicht. SQLite ist kein HA-/Backup-System; Betreiber müssen Volume-Sicherung, Dateirechte und Wiederherstellung selbst verantworten.

Die vollständige Herkunfts- und Lückenmatrix steht in [docs/ananta-webrtc-adoption.md](docs/ananta-webrtc-adoption.md). Produktionsschritte stehen schema-validiert unter `todos/backlog/`.

## Entwicklung

`AGENTS.md` macht das Todo-Tracking verbindlich. Der vollständige lokale Gate ist:

```bash
npm run check
npm audit --omit=dev
docker compose config --quiet
docker compose --profile local --env-file .env.local.example config --quiet
docker build --tag webrtc-room-server:local .
(cd edge-agent && go test ./...)
docker build --tag webrtc-edge-agent:local edge-agent
(cd edge-agent && EDGE_AGENT_ENV_FILE=.env.example docker compose --env-file .env.example config --quiet)
```

`npm run check` umfasst Todo-/Workflow-Schemas, Angular-Unit-Tests, Angular-Produktionbuild und Node-/Integrationstests. Die Browsermatrix prüft SFrame im `required`-Modus mit echten Chromium- und Firefox-Kontexten ohne automatische Capture-Anfrage. Der getrennte Sechs-Chromium-Gate prüft den expliziten Legacy-Relay-Baum einschließlich Sender-Fanout, Active Speaker, Datensparprofil, Mosaik und Churn-Fallback. Fehlende Browser werden ausschließlich mit sichtbarer Begründung übersprungen. Der Edge-Agent besitzt zusätzlich einen echten lokalen TURN-Allokationstest.

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
