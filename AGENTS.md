# AGENTS.md

## Zweck

Diese Datei definiert Architektur-, Sicherheits- und Entwicklungsregeln für `webrtc-minimize-server`. Alle Agents, Automationen und Beitragenden müssen sie bei jeder Änderung beachten.

Das Projekt übernimmt Anantas contract-first Todo-Tracking, passt seine Architektur aber an dieses eigenständige WebRTC-System an. Ananta ist eine Herkunftsquelle, keine Runtime-Abhängigkeit.

## Kernarchitektur

Das System trennt eine kleine **Signaling Control Plane** von der **WebRTC Data Plane**.

### Signaling Control Plane

Der Node-Server ist allein verantwortlich für:

- statische Anwendung und öffentliche Runtime-Konfiguration,
- Room-Membership innerhalb der laufenden Instanz,
- Zuweisung kurzlebiger Peer-IDs,
- Prüfung und begrenzte Weiterleitung von SDP-/ICE-Signalen,
- Ausgabe absoluter, epochgebundener und zyklusfreier Trusted-Relay-Topologien aus aktueller Membership und Consent,
- getrennte Membership-/Route-/Topology-Epochen, kurzlebige Route-Leases und quorum-basiertes Relay-Health,
- eindeutige Media-Agent-Ingress-/Egress-Zuordnung, individuelle Layer-Pläne und höchstens zweistufige, zyklenfreie Agent-Föderations-DAGs aus aktueller Membership und Consent,
- kryptografische OIDC-Tokenprüfung und Ausgabe kurzlebiger Einmal-Tickets,
- Prüfung frischer, raumgebundener P-256-Gerätenachweise,
- Ausgabe kurzlebiger Coturn-REST-Credentials nach Session-Autorisierung,
- Teilnehmer-, Origin-, Größen- und Rate-Grenzen.
- optional persistente, OIDC-tenantgebundene Pair-Workspace-Metadaten, Rollen, Events/Outbox, Cursor und Presence.

Der Signaling-Server darf keine Audio-, Video-, Bildschirm- oder Chat-Inhalte terminieren, aufzeichnen oder persistieren.

### WebRTC Data Plane

Browser sind verantwortlich für:

- explizit vom Benutzer gestartete Capture-Lifecycles,
- eine isolierte `RTCPeerConnection` pro Gegenüber,
- DTLS-SRTP-Medientransport und SCTP-DataChannels,
- lokale Darstellung und Freigabestopps,
- Perfect Negotiation ohne globale Peer-Orchestrierungsloops,
- OIDC Authorization Code Flow mit PKCE und sitzungsgebundene Tokens,
- eine nicht exportierbare P-256-Geräteidentität im Browserprofil,
- lokale VAD-/Active-Speaker-Auswahl, per Peer begrenzte Senderqualität und ein lokales Inaktiv-Mosaik,
- Kamera-Simulcast mit `q`/`h`/`f`, lokaler maximaler Layerwahl und Receiver-ACK vor Abschalten des Direct-Fallbacks,
- Ausführung ausschließlich serverautorisierter Trusted-Relay-Kanten nach separatem Nutzerconsent,
- zielpeergebundene ECDH-/AES-GCM-Verschlüsselung für opaque Data-Overlay-Pakete einschließlich Replay-, TTL-, Hop-, Queue- und Chunk-Resume-Grenzen,
- RFC-9605-SFrame mit `AES_128_GCM_SHA256_128` über WebRTC Encoded Transform für Audio-, Kamera- und Bildschirmframes, einem exakt ausgehandelten versionierten Codec-Envelope und ausschließlich authentifizierten VP8-/Opus-Klartextpräfixen sowie
- publikations-, Zielpeer- und Membership-Epoch-gebundene SFrame-Schlüssel, die ausschließlich über den opaque Data-Overlay verteilt und vor Senderaktivierung quittiert werden.

Peers dürfen aus Signalen keine Room-Membership oder zusätzliche Autorität ableiten. Die Control Plane bleibt Eigentümerin der Membership.

## Systemgrenzen

- Ein Raum hat eine harte Membership-Grenze von 20 Teilnehmern.
- Eine Pair-Session hat eine harte Grenze von zwei unterschiedlichen Gerätefingerprints und kann nicht in einen normalen Raum umgedeutet werden.
- Die Anzahl gleichzeitig aktiver Räume besitzt keine anwendungsseitige Obergrenze. Praktische Ressourcenbudgets dürfen beobachtet und geschützt werden, aber keine feste globale Room-Anzahl in die Domain einführen.
- Das Control-/Audio-Mesh erzeugt bei 20 Teilnehmern bis zu 19 PeerConnections. Video wird Active-Speaker-, Stats- und profilabhängig gedrosselt; ein consentierter Trusted-Relay-Baum kann direkten Publisher-Fanout reduzieren, ist aber keine QoS-Garantie.
- Room-Membership, Peer-IDs und Medien bleiben flüchtig. Nur ausdrücklich aktivierte Pair-Workspace-Metadaten und Events dürfen im konfigurierten Store persistieren.
- Der Raumcode ist ein Bearer-Invite, keine Identität. Identität stammt ausschließlich aus verifizierten OIDC-Claims; das Gerät stammt ausschließlich aus einem serverseitig geprüften P-256-Nachweis.
- WebRTC bietet hopweise Transportverschlüsselung. Zusätzlich ist RFC-9605-SFrame für Browser mit WebRTC Encoded Transform implementiert; `required` muss bei fehlender Capability oder fehlendem quittiertem Schlüssel ohne Klartext-Fallback abbrechen.
- Der Medien-Envelope `codec-prefix-v1` lässt nur die für den Browser-Packetizer notwendigen VP8-Key-/Delta-Präfixe beziehungsweise das Opus-TOC sichtbar und authentisiert sie als AES-GCM-AAD. Unbekannte Envelope-Versionen oder Codecs bleiben fail-closed und dürfen keinen aktiven E2EE-Status erzeugen.
- STUN/TURN sind konfigurierbare Infrastrukturhilfen, keine Policy-Autorität. TURN-Credentials werden kurzlebig und erst nach Session-Autorisierung erzeugt.
- Ein decode/re-encode-fähiger Trusted-Video-Relay-Baum bleibt nur im expliziten Legacy-Modus `MEDIA_E2EE_MODE=disabled` vorhanden und darf nicht als blind bezeichnet werden. In `required`/`preferred` ist dieser Medienfanout deaktiviert; direkte ICE-Pfade, freiwillige Edge-TURN-Knoten und Infrastruktur-TURN transportieren SFrame-Ciphertext.
- SFrame allein reduziert den Peer-Fanout nicht. Ein portabler Ciphertext-Medien-DAG zwischen Browsern bleibt Backlog. Der optionale native Blind-Media-Agent implementiert dagegen einen selektiven SFrame-blinden SFU-Pfad mit Simulcast und direkter, ausschließlich serverautorisierter Agent-Föderation; er ist keine QoS-Garantie und erhält weder Frame-Schlüssel noch Membership-/Policy-Autorität. Ein zentral betriebener SFU, Workspace-HA/Backup und MLS-artige Gruppenschlüsselverwaltung bleiben Backlog-Fähigkeiten.
- Ein einzelner geeigneter nativer Media-Agent darf ab drei Raumteilnehmern geleast werden; Publisher-Sharding beginnt separat ab der konfigurierten größeren Schwelle. Ein Legacy-Browser-Relay-Baum darf unabhängig von seiner Mindestgröße nur entstehen, wenn seine Kindergrenze den direkten `N - 1`-Publisher-Fanout tatsächlich reduziert.
- Die SFrame-Peer-Key-Zuordnung stammt derzeit aus dem authentisierten Signaling-Pfad. Sie schützt Inhalte vor ehrlichen, aber neugierigen TURN-/Edge-/Control-Plane-Betreibern, beweist jedoch keine Ende-zu-Ende-Identität gegen einen vollständig kompromittierten Signaling-Server.

## Todo-gesteuerte Entwicklung

Jede nichttriviale Änderung muss über `todos/` verfolgt werden. Die Ordner haben folgende Bedeutung:

- `todos/active/`: ausführbare, aktuell bearbeitete Task-Tracks,
- `todos/backlog/`: Category-/Research-Todos und noch nicht angenommene Tracks,
- `todos/archive/`: vollständig abgeschlossene Tracks.

Category-Todos entsprechen `todos/todo.schema.json`. Sie ordnen Ideen und Forschung, erzeugen aber keine Implementierungsarbeit. Ein Category-Item wird vor Codeänderungen in einen Track nach `todos/todo.track.schema.json` überführt.

### Pflichtablauf

1. Vor einer Änderung das passende aktive Todo lesen.
2. Gibt es keinen passenden Task, zuerst einen kleinen Task mit Risiko, Priorität, Abhängigkeiten und prüfbaren Akzeptanzkriterien hinzufügen.
3. Beim Arbeitsbeginn den Task auf `in_progress` und `progress_percent` auf `1..99` setzen.
4. Code, Tests, Dokumentation und Todo-Status gemeinsam ändern.
5. Erst nach erfüllten Akzeptanzkriterien und realer Verifikation auf `done`/`100` setzen.
6. Abgeleitete Summen in derselben Änderung aktualisieren.
7. `npm run todos:validate` ausführen. `tasks[]` ist immer die Source of Truth; Summary-Blöcke sind nur geprüfte Caches.

Erlaubte Task-Status sind `todo`, `in_progress`, `partial`, `blocked`, `done`. `todo` hat 0 %, `done` 100 %, `in_progress` und `partial` haben 1–99 %. `blocked` muss einen konkreten Grund im Task oder in `summary_notes` nennen.

Ein Track kommt nur ins Archiv, wenn alle Tasks und Milestones `done` sind und das Todo-Gate erfolgreich ist. Historie und Akzeptanzkriterien dürfen beim Archivieren nicht entfernt werden.

## Sicherheitsprinzipien

- Default deny und Least Privilege anwenden.
- Keine Capture-API beim Laden, beim Öffnen eines Panels oder allein durch ein Remotesignal aufrufen. Nur ein sichtbarer lokaler Benutzerklick darf Browserrechte anfordern.
- Mikrofon, Kamera und Bildschirm als getrennte, idempotent stoppbare Publikationen behandeln.
- Sessionwechsel, Leave und Seitenende müssen alle lokalen Tracks stoppen.
- SDP, ICE, Room-Codes, Namen, Chat und Metadaten nie in Produktionslogs ausgeben.
- WebSocket-Origin, Room-Membership, Empfänger, Nachrichtentyp, Größe und Rate serverseitig prüfen.
- Unbekannte Contract-Felder oder Nachrichtentypen fail-closed behandeln.
- TURN-Secrets nie einchecken. Statische TURN-Credentials sind nur für lokale Tests; Produktion benötigt kurzlebige Credentials.
- OIDC-Tokens nie in URLs, Signaling-Nachrichten oder Logs schreiben. WebSockets verwenden ausschließlich kurzlebige, einmal verwendbare Session-Tickets.
- OIDC fail-closed auf Signatur, erlaubten Algorithmus, exakten Issuer, Audience, Ablaufzeit und Subject prüfen; JWKS-Fehler dürfen Auth nicht still deaktivieren.
- Gerätebeweise an die normalisierten Join-Felder binden, zeitlich begrenzen und gegen Replay schützen. Private Geräteschlüssel dürfen nicht exportierbar oder serverseitig gespeichert sein.
- `AUTH_MODE=disabled`, Keycloak `start-dev`, lokale Beispielpasswörter und unverschlüsseltes TURN sind ausschließlich Entwicklungsprofile und dürfen nicht als produktionssicher dokumentiert werden.
- Kein E2EE-, Anonymitäts- oder Identitätsversprechen machen, das der implementierte Pfad nicht beweist.
- Im `required`-SFrame-Modus dürfen fehlende Capability, ausstehende ACKs, unbekannte KIDs, Envelope-/Codecfehler, Authentifizierungsfehler oder Replays niemals einen Klartext-Fallback auslösen. Ein struktureller Transformfehler darf auch im `preferred`-Modus nicht nachträglich auf Klartext wechseln.
- Freiwillige TURN-Edge-Agenten besitzen keine Membership- oder Policy-Autorität, verwenden ausschließlich kurzlebige serverseitig ausgestellte Credentials und benötigen explizit erreichbare TURN- sowie Relay-Ports.
- Blind-Media-Agenten bleiben pro Raum/Owner default-aus und widerrufbar, besitzen keinen Decrypt-Port und dürfen nur die im aktuellen Lease genannten Browser, Links, Publikationen und Layer transportieren. Direkte Agent-Agent-Control-Nachrichten erweitern niemals die Serverautorität.
- Trusted Peer Relay bleibt operatorseitig begrenzt, nutzerseitig default-aus und widerrufbar; die UI muss die Medienverarbeitung, Upload-, CPU- und Batteriefolgen erklären.
- Overlay-Relays dürfen keinen Decrypt-Port besitzen; private ECDH-Schlüssel müssen nicht exportierbar sein und bei Leave/Destroy aus dem erreichbaren Browser-State verschwinden.
- Workspace-Rollen, Tenant, Membership-Revision, Event-Idempotency, Cursor und Presence-Leases werden für jede Operation serverseitig geprüft. Workspace-Rechte erweitern weder Room-Kapazität noch Medienrechte.
- Öffentliches Deployment ausschließlich über HTTPS/WSS. Secure Context ist für Medienzugriff erforderlich.

## Engineering-Regeln

SOLID gilt bei allen Änderungen:

- **SRP:** Konfiguration, Protokollvalidierung, Room-State, HTTP/WS-Infrastruktur und Browser-Medienlifecycle getrennt halten.
- **OCP:** Neue Transport- oder Topologieadapter ergänzen, statt zentrale Contracts fallweise zu patchen.
- **LSP:** Mock-, P2P-, TURN-, Blind-SFU- und spätere zentrale SFU-Adapter müssen ihre deklarierten Capabilities ehrlich und austauschbar erfüllen.
- **ISP:** Kleine Ports für Membership, Signaling, Publication, Subscription, Stats und DataChannel-Traffic bevorzugen.
- **DIP:** Domain- und Contract-Code darf nicht von konkreten SFU-/Identity-Vendor-SDKs abhängen.
- **ISP:** Angular-Services für Runtime-Konfiguration, OIDC, Geräteidentität, Signaling, Peer-Mesh und Capture bleiben getrennt; UI-Komponenten besitzen keine Token- oder PeerConnection-Policy.

Zusätzlich:

- Funktionen und Module klein, deterministisch und testbar halten.
- Keine implizite globale Peer-Liste außerhalb des klar besitzenden Browser-State bzw. RoomRegistry einführen.
- Backpressure und harte Größenlimits vor neuen DataChannel-Nutzlasten definieren.
- Additive, kompatible Protokollversionen gegenüber stillen Bedeutungsänderungen bevorzugen.
- Keine experimentelle Browser-API als portable Produktionsbasis deklarieren, bevor Browsermatrix und Fallback entschieden sind.
- Bei bewussten SOLID-Schulden Problem, betroffenes Prinzip und späteren Extraktionspfad im Todo dokumentieren.

## Verifikation

Vor Abschluss mindestens:

```bash
npm run check
```

Je nach Änderung zusätzlich:

- zwei echte Browseridentitäten für Medien/DataChannel,
- zwei getrennte Browserkontexte für Pair-Gerätebindung,
- Chromium/Firefox-Matrix bei Capture-/Negotiation-Änderungen,
- reale Multi-Peer-Evidence für Relay-Fanout, Mosaik, Active Speaker, Senderparameter und epochgebundenen Mesh-Fallback,
- NAT-/TURN-Test bei ICE-Konfigurationsänderungen,
- realer PKCE-/JWKS-/TURN-Live-Gate bei Identity- oder Coturn-Änderungen; fehlende Infrastruktur muss als sichtbarer Skip erscheinen,
- Negativtests für unbekannte Messages, falsche Rooms, Oversize, Rate-Limit und Disconnect,
- Prüfung, dass ohne Benutzeraktion keine Capture-Berechtigung erscheint.

Tests dürfen externe STUN-/TURN-Dienste sauber überspringen, aber nicht stillschweigend als bestanden melden.

## Output- und Repository-Grenzen

| Pfad | Kategorie | Versionieren |
|---|---|---|
| `src/`, `frontend/`, `test/`, `scripts/` | Source/Test | ja |
| `.github/workflows/` | CI-Infrastruktur | ja |
| `AGENTS.md`, `README.md`, `LICENSE`, `docs/` | Dokumentation/Lizenz | ja |
| `todos/**/*.json`, `todos/archive/README.md` | Planung | ja |
| `.env.example`, `Dockerfile`, `compose.yaml`, `infra/keycloak/` | reproduzierbare Infrastruktur | ja |
| `.env`, TURN-Secrets, Tokens, Zertifikat-Private-Keys | Secret | niemals |
| `node_modules/`, `dist/`, Logs, Coverage, Test-Results | generiert | nein |

Vor einem Commit `git status` prüfen und Dateien gezielt stagen; niemals ungeprüft `git add .` oder `git add -A` verwenden. Commit-Schema ist Conventional Commits, beispielsweise `feat(signaling): bound room relay` oder `test(webrtc): cover peer departure`.

## Quellen- und Behauptungsregel

Die Herkunftsmatrix in `docs/ananta-webrtc-adoption.md` ist die lokale Referenz für übernommene Ideen. Keine Quellpfade, Tests oder Produktionsfähigkeiten erfinden. Ein nicht reproduzierbar verifizierter Browser-, Netzwerk- oder Security-Pfad bleibt `unverified`, `partial` oder `blocked`.

## Oberste Regel

**Die Control Plane besitzt Membership und Policy. Browser führen nur autorisierte, explizit vom lokalen Benutzer gestartete Datenpfade aus. Nicht implementierte Sicherheit wird niemals behauptet.**
