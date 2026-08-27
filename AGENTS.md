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
- Teilnehmer-, Origin-, Größen- und Rate-Grenzen.

Der MVP-Server darf keine Audio-, Video-, Bildschirm- oder Chat-Inhalte terminieren, aufzeichnen oder persistieren.

### WebRTC Data Plane

Browser sind verantwortlich für:

- explizit vom Benutzer gestartete Capture-Lifecycles,
- eine isolierte `RTCPeerConnection` pro Gegenüber,
- DTLS-SRTP-Medientransport und SCTP-DataChannels,
- lokale Darstellung und Freigabestopps,
- Perfect Negotiation ohne globale Peer-Orchestrierungsloops.

Peers dürfen aus Signalen keine Room-Membership oder zusätzliche Autorität ableiten. Die Control Plane bleibt Eigentümerin der Membership.

## MVP-Grenzen

- Ein Raum hat höchstens vier Teilnehmer.
- Räume und Peer-IDs sind flüchtig und werden nicht persistiert.
- Der Raumcode ist im MVP ein Bearer-Invite, keine verifizierte Identität.
- WebRTC bietet Transportverschlüsselung; anwendungsseitige SFrame-/Insertable-Streams-E2EE ist noch nicht implementiert.
- STUN/TURN sind konfigurierbare Infrastrukturhilfen, keine Policy-Autorität.
- SFU, Peer-DAG, OIDC, langlebige Workspaces und Artefakttransfer sind Backlog-Fähigkeiten und dürfen nicht als MVP-Funktionen dargestellt werden.

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
- Kein E2EE-, Anonymitäts- oder Identitätsversprechen machen, das der implementierte Pfad nicht beweist.
- Öffentliches Deployment ausschließlich über HTTPS/WSS. Secure Context ist für Medienzugriff erforderlich.

## Engineering-Regeln

SOLID gilt bei allen Änderungen:

- **SRP:** Konfiguration, Protokollvalidierung, Room-State, HTTP/WS-Infrastruktur und Browser-Medienlifecycle getrennt halten.
- **OCP:** Neue Transport- oder Topologieadapter ergänzen, statt zentrale Contracts fallweise zu patchen.
- **LSP:** Mock-, P2P-, TURN- und spätere SFU-Adapter müssen ihre deklarierten Capabilities ehrlich und austauschbar erfüllen.
- **ISP:** Kleine Ports für Membership, Signaling, Publication, Subscription, Stats und DataChannel-Traffic bevorzugen.
- **DIP:** Domain- und Contract-Code darf nicht von konkreten SFU-/Identity-Vendor-SDKs abhängen.

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
- Chromium/Firefox-Matrix bei Capture-/Negotiation-Änderungen,
- NAT-/TURN-Test bei ICE-Konfigurationsänderungen,
- Negativtests für unbekannte Messages, falsche Rooms, Oversize, Rate-Limit und Disconnect,
- Prüfung, dass ohne Benutzeraktion keine Capture-Berechtigung erscheint.

Tests dürfen externe STUN-/TURN-Dienste sauber überspringen, aber nicht stillschweigend als bestanden melden.

## Output- und Repository-Grenzen

| Pfad | Kategorie | Versionieren |
|---|---|---|
| `src/`, `public/`, `test/`, `scripts/` | Source/Test | ja |
| `.github/workflows/` | CI-Infrastruktur | ja |
| `AGENTS.md`, `README.md`, `LICENSE`, `docs/` | Dokumentation/Lizenz | ja |
| `todos/**/*.json`, `todos/archive/README.md` | Planung | ja |
| `.env.example`, `Dockerfile`, `compose.yaml` | reproduzierbare Infrastruktur | ja |
| `.env`, TURN-Secrets, Tokens, Zertifikat-Private-Keys | Secret | niemals |
| `node_modules/`, Logs, Coverage, Test-Results | generiert | nein |

Vor einem Commit `git status` prüfen und Dateien gezielt stagen; niemals ungeprüft `git add .` oder `git add -A` verwenden. Commit-Schema ist Conventional Commits, beispielsweise `feat(signaling): bound room relay` oder `test(webrtc): cover peer departure`.

## Quellen- und Behauptungsregel

Die Herkunftsmatrix in `docs/ananta-webrtc-adoption.md` ist die lokale Referenz für übernommene Ideen. Keine Quellpfade, Tests oder Produktionsfähigkeiten erfinden. Ein nicht reproduzierbar verifizierter Browser-, Netzwerk- oder Security-Pfad bleibt `unverified`, `partial` oder `blocked`.

## Oberste Regel

**Die Control Plane besitzt Membership und Policy. Browser führen nur autorisierte, explizit vom lokalen Benutzer gestartete Datenpfade aus. Nicht implementierte Sicherheit wird niemals behauptet.**
