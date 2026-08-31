# Freiwilliger WebRTC-Edge-Agent

Der optionale Edge-Agent ist ein kleiner TURN-Server für freiwillige, geeignete Rechner. Die Anwendung versucht für jede PeerConnection in dieser Reihenfolge:

1. direkte Host-/STUN-Kandidaten,
2. konfigurierte freiwillige Edge-TURN-Knoten,
3. zentrales Infrastruktur-TURN.

Ein erfolgreicher direkter Pfad wird nicht nur wegen eines abgelaufenen Timers neu gestartet. Die Oberfläche zeigt lediglich `direct`, `peer-edge` oder `infrastructure-relay`, niemals Kandidatenadressen, SDP oder ICE-Inhalte.

Der Agent ist keine Control Plane und keine SFU. Er kennt weder Räume noch Membership, OIDC-Tokens oder SFrame-Schlüssel. Er leitet DTLS-SRTP-Pakete weiter; im standardmäßigen `MEDIA_E2EE_MODE=required` enthalten diese zusätzlich SFrame-verschlüsselte Medienframes. Pion TURN ist dabei ein standardkonformer Paketrelay, kein browserübergreifender Medien-DAG.

## Eignung und Netzvoraussetzungen

Ein freiwilliger Rechner ist nur geeignet, wenn sein Betreiber der öffentlichen Relay-Funktion ausdrücklich zustimmt und er genügend stabile Upload-/Download-Kapazität besitzt. Ein Notebook im Akkubetrieb oder ein getakteter Anschluss ist meist ungeeignet.

Andere Teilnehmer müssen den Rechner erreichen können. Dafür braucht er entweder:

- eine öffentlich routbare IPv6-Adresse mit passender Firewallfreigabe oder
- eine öffentliche IPv4-Adresse und explizite Router-Portweiterleitungen.

Bei CGNAT ohne Public IPv6, Portmapping durch den Provider oder vorgelagerten Relay kann ein Rechner nicht selbst zum erreichbaren Edge werden. Der Agent umgeht diese Netzgrenze nicht.

Freizugeben sind standardmäßig:

| Protokoll | Port | Zweck |
|---|---:|---|
| UDP | 3478 | TURN-Listener, bevorzugter Transport |
| TCP | 3478 | optionaler TURN-over-TCP-Fallback |
| UDP | 49160–49259 | feste Relay-Allokationen |

TCP 3478 ist kein TURN/TLS. Der Agent implementiert derzeit kein `turns:` auf 5349; ein solcher URL darf für ihn nicht konfiguriert werden. SFrame und DTLS-SRTP schützen Medieninhalte davon unabhängig, ersetzen aber keine Transport-Metadaten- oder IP-Privacy.

## Agent installieren

Auf dem freiwilligen Rechner:

```bash
cd edge-agent
cp .env.example .env
openssl rand -base64 48
```

Die Ausgabe des letzten Befehls wird als `EDGE_AGENT_SHARED_SECRET` in die nicht versionierte `.env` eingetragen. Außerdem sind mindestens diese Werte anzupassen:

```dotenv
EDGE_AGENT_PUBLIC_IP=198.51.100.27
EDGE_AGENT_LISTEN_IP=0.0.0.0
EDGE_AGENT_REALM=webrtc.ananta.de
EDGE_AGENT_SHARED_SECRET=<zufaelliges-secret-mit-mindestens-32-zeichen>
```

`EDGE_AGENT_PUBLIC_IP` ist die von anderen Teilnehmern erreichbare Adresse, auch wenn der Container hinter NAT auf `0.0.0.0` lauscht. IPv6-Public-IP und Listen-IP müssen beide IPv6 sein. Danach:

```bash
docker compose up -d --build
docker compose logs edge-agent
```

Normale Logs enthalten nur Start-/Stopstatus, Transport, Ports, Quotenklasse und die Private-Peer-Policy. Secrets, Nutzernamen, Peer-IP-Adressen und ICE-Inhalte werden nicht protokolliert.

### Windows und WSL2

Bei WSL2 im NAT-Modus soll der Agent als natives Windows-Binary laufen. Ein nur in WSL/Docker gebundener UDP-Port ist vom LAN oder Router nicht automatisch bis zum Linux-Namespace durchgereicht. Das Repository enthält deshalb den fail-closed Launcher `run-windows.ps1`; er liest `edge-agent.env` aus demselben privaten Installationsordner, lehnt unbekannte oder doppelte Felder ab und gibt keine Secretwerte aus.

Das Binary kann aus WSL reproduzierbar cross-kompiliert werden:

```bash
cd edge-agent
docker run --rm --user 1000:1000 \
  -e GOCACHE=/tmp/go-cache -e GOMODCACHE=/tmp/go-mod \
  -e GOOS=windows -e GOARCH=amd64 -e CGO_ENABLED=0 \
  -v "$PWD:/src" -w /src golang:1.25.7-alpine3.23 \
  /usr/local/go/bin/go build -trimpath -ldflags="-s -w" -o /src/edge-agent.exe .
```

`edge-agent.exe`, `run-windows.ps1` und die nicht versionierte `edge-agent.env` werden in einen nur für den Windows-Nutzer lesbaren Ordner kopiert. `EDGE_AGENT_PUBLIC_HOST` kann dort statt einer festen Public-IP gesetzt werden; der Launcher verlangt beim Start genau eine IPv4-Adresse und übergibt sie als `EDGE_AGENT_PUBLIC_IP`. Windows-Firewall und Router müssen weiterhin Listener- und Relay-Ports gezielt auf die Windows-LAN-Adresse freigeben.

Die Defaults begrenzen den Agent auf 64 gleichzeitige Allokationen und vier je kurzlebigem Benutzer. Die Relay-Allokation lebt maximal 600 Sekunden. `EDGE_AGENT_ALLOW_PRIVATE_PEERS=false` sperrt private, Loopback-, Link-Local-, Multicast- und unspezifizierte Ziele. Die Option sollte nur für einen bewusst isolierten LAN-Test auf `true` gesetzt werden.

## Control Plane koppeln

Dasselbe Secret wird über das Secret-Management des WebRTC-Servers in dessen nicht versionierte `.env` eingetragen. Es gehört nie in Browsercode, Git oder einen Einladungslink:

```dotenv
EDGE_TURN_SERVERS_JSON='[{"id":"edge-home-1","urls":["turn:edge.example.org:3478?transport=udp","turn:edge.example.org:3478?transport=tcp"],"sharedSecret":"<dasselbe-secret>","realm":"webrtc.ananta.de"}]'
PEER_EDGE_FALLBACK_MS=4000
INFRASTRUCTURE_TURN_FALLBACK_MS=9000
```

Nach einem Neustart stellt `POST /api/sessions` einem autorisierten Teilnehmer je Agent separate, principalgebundene REST-Credentials mit höchstens zehn Minuten Laufzeit aus. `EDGE_AGENT_MAX_CREDENTIAL_TTL_SECONDS` muss mindestens diese tatsächlich verwendete Laufzeit erlauben; die beiden Defaults sind aufeinander abgestimmt. In `/config` und in der Session-Antwort erscheint niemals das Shared Secret. Mehrere Agenten können als getrennte Arrayelemente registriert werden; IDs müssen eindeutig sein.

## Verifizieren und entfernen

Der reproduzierbare lokale TURN-Allokationstest verwendet echte REST-Authentisierung gegen den Pion-Server:

```bash
cd edge-agent
go test ./...
docker build -t webrtc-edge-agent:local .
EDGE_AGENT_ENV_FILE=.env.example docker compose --env-file .env.example config --quiet
```

Für einen Netztest sollten zwei Browser aus unterschiedlichen Netzen verbunden werden. Die UI muss bei einem tatsächlich gewählten Agenten `peer-edge` anzeigen; bloße Erreichbarkeit von Port 3478 beweist noch keine Relay-Allokation. Eine echte NAT-/TURN-Prüfung darf fehlende externe Infrastruktur nur als sichtbaren Skip melden.

Zum Widerruf wird der Agent aus `EDGE_TURN_SERVERS_JSON` entfernt, die Control Plane neu gestartet und anschließend der Agent gestoppt. Bereits ausgestellte Credentials sind kurzlebig; bei Verdacht auf Offenlegung muss das Shared Secret auf beiden Seiten rotiert werden.

## Sicherheitsgrenze

RFC-9605-SFrame schützt Medienframes gegen einen ehrlichen, aber neugierigen Edge-/TURN-/Control-Plane-Betreiber. Der Peer-Public-Key wird derzeit jedoch durch das authentisierte Signaling zugeordnet. Ein vollständig kompromittierter Signaling-Server liegt daher außerhalb dieses E2EE-Nachweises. Ebenso reduziert der Agent nicht die bis zu 19 PeerConnections eines 20-Personen-Raums; ein nicht entschlüsselnder Browser-Ciphertext-DAG bleibt eine getrennte Backlog-Fähigkeit.

Normative Grundlagen: [RFC 9605 – SFrame](https://www.rfc-editor.org/rfc/rfc9605.html), [W3C WebRTC Encoded Transform](https://www.w3.org/TR/webrtc-encoded-transform/) und [Pion TURN](https://github.com/pion/turn).
