# SFrame-blinder Media-Edge-Agent

Stand: 2026-09-01. Dieses Dokument trennt den feature-gegateten Media-Agenten vom
bereits vorhandenen TURN-Edge-Agenten und legt die Sicherheits- und
Wahlregeln fest.

## Warum kein blinder Browser-Relay

WebRTC Encoded Transform erlaubt einem Transform nur Frames seiner eigenen
Quelle in den zugeordneten Ausgabestrom zu schreiben. Die normative
`writeEncodedData`-Pruefung verwirft ein Frame, wenn dessen Owner nicht zur
`RTCRtpScriptTransformer`-Quelle gehoert. Die Spezifikation fasst die Folge
ausdruecklich zusammen: Ein Prozessor kann weder Frames erzeugen noch Frames
zwischen Streams verschieben.

Die vorgeschlagene Erweiterung fuer das Weiterreichen empfangener Encoded
Frames an Sender anderer `RTCPeerConnection`s ist weiterhin als
[w3c/webrtc-encoded-transform#160](https://github.com/w3c/webrtc-encoded-transform/issues/160)
offen. Deshalb darf die Anwendung einen portablen, nicht entschluesselnden
Browser-DAG nicht als implementierbar oder vorhanden behandeln. Normative
Referenz ist [WebRTC Encoded Transform](https://www.w3.org/TR/webrtc-encoded-transform/).

## Vier unterschiedliche Pfade

| Pfad | Medienverarbeitung | Fanout-Wirkung | Erreichbarkeit | Vertrauensgrenze |
|---|---|---|---|---|
| Browser Trusted Relay | Browser dekodiert und re-encodiert | reduziert Video-Fanout | normale Browser-ICE-Pfade | Relay sieht Klartext; nur expliziter Legacy-Modus |
| TURN-/Edge-TURN | paketbasiertes DTLS-SRTP-Relay | keine; jede PeerConnection bleibt bestehen | verbessert NAT-/Firewall-Pfade | sieht Transportmetadaten, keine SFrame-Schluessel |
| nativer Blind-Media-Agent | terminiert pro Browser DTLS-SRTP und leitet RTP mit unveraendertem SFrame-Payload weiter | Publisher sendet pro Route nur an den Agenten | Direct/STUN, optional feste UDP-Erreichbarkeit, sonst TURN | erhaelt keine SFrame-/Gruppenschluessel und besitzt keinen Decrypt-Port |
| zentraler SFU | wie nativer Agent, aber zentral betrieben | reduziert Fanout verlaesslich | oeffentlich erreichbare Infrastruktur | zentraler Betriebs- und Metadatenpunkt; mit SFrame weiterhin inhaltsblind |

Der native Agent ist ein separater Prozess. Der Node-Raumserver bleibt eine
reine Control Plane und terminiert weder RTP noch RTCP oder Medienframes.

## Sicherheitsvertrag des nativen Agenten

- Jeder Browser besitzt eine isolierte `RTCPeerConnection` zum Agenten. Der
  Agent terminiert deshalb ICE, DTLS und SRTP und kann IP-Adressen,
  Paketgroessen, Timing, SSRCs, Codec-Metadaten und Datenraten beobachten.
- Der RTP-Payload enthaelt bereits SFrame-Ciphertext. Der Agent bekommt weder
  den publikationsgebundenen Basisschluessel noch einen API-, IPC- oder
  Diagnosepfad zum Entschluesseln. Er dekodiert und re-encodiert nicht.
- Der Agent kann Pakete verwerfen, verzoegern, duplizieren oder umordnen. Er
  kann ohne Schluessel keine gueltigen neuen SFrame-Frames erzeugen. Browser
  begrenzen Replay und verwerfen Authentifizierungsfehler fail-closed.
- Gruppenschluessel werden vom Publisher fuer eine Publikation und
  Membership-Epoche erzeugt und jedem autorisierten Empfaenger einzeln ueber
  den vorhandenen zielpeergebundenen ECDH-/AES-GCM-Overlay zugestellt. Ein
  Membershipwechsel rotiert den Schluessel.
- `MEDIA_E2EE_MODE=required` darf bei Agent-Ausfall niemals in Klartext oder
  Decode/Re-encode zurueckfallen. Bis eine neue Agentroute vollstaendig bereit
  ist, bleibt das bestehende required-SFrame-Mesh autoritativ.

## Creator-Praeferenz und Rollenwechsel

Consent ist pro Nutzergeraet default-aus. Nach sichtbarer Zustimmung meldet
ein nativer Agent seine operatorseitig konfigurierte Identitaet ausgehend per
WSS an. Die Control Plane bindet ihn an den aktuellen OIDC-Principal und das
zustimmende Raumgeraet. Der Ersteller des Raums erhaelt in der Wahl nur einen
Bonus; Erreichbarkeit, frischer Heartbeat, freie Kapazitaet, Netzklasse,
Batterie und beobachtete Lieferqualitaet koennen diesen Bonus ueberstimmen.

Eine Raumroute besitzt einen Primary und hoechstens zwei warme Standbys. Die
Lease ist kurz, an Membership- und Route-Epoche gebunden und darf nur durch die
Control Plane erneuert werden:

1. Bei geplantem Leave meldet der Primary `draining`. Die Control Plane fragt
   den bestbewerteten Standby sichtbar zur Uebernahme an.
2. Nach dessen Zustimmung wird eine hoehere Route-Epoche veroeffentlicht. Das
   required-SFrame-Mesh bleibt parallel autoritativ, bis Agent und alle Browser
   die neue Route sowie die neue publikationsgebundene Schluessel-Epoche als
   bereit bestaetigt haben.
3. Die alte Lease wird widerrufen; ein wiederkehrender alter Agent kann sie
   nicht reaktivieren.
4. Bei erkanntem Socket-Ausfall wird sofort neu gewaehlt; andernfalls begrenzen
   Heartbeat und kurze Lease die Erkennung. Bis ein Ersatz bereit ist, bleibt
   das vorhandene SFrame-Mesh aktiv.

Unterhalb von `MEDIA_AGENT_SHARD_MIN_PARTICIPANTS` (Default 6) ist nur der
Primary Forwarder; die Standbys besitzen keine Browser- oder Medienroute. Ab
dem Schwellwert verteilt die Control Plane jeden Publisher deterministisch und
eindeutig auf Primary und hoechstens zwei Standbys. Der Creator-Publisher bleibt
beim Creator-Primary, soweit dieser gewaehlt wurde; die uebrigen Publisher
werden balanciert. Dieselbe explizite Zuordnung legt derzeit den Egress eines
Subscribers fest. Browser verbinden sich nur mit ihrem Ingress/Egress; jeder
Agent erhaelt pro Peer getrennte `connect`, `publish` und `subscribe`-Rechte.

Kamera-Publisher handeln ueber `addTransceiver` drei Encodings aus: `q`/low,
`h`/medium und `f`/high. Ein Subscriber sendet einen lokalen, nach oben
begrenzten Layer-Wunsch. Die Control Plane prueft Quelle, Publikation,
Membership, Egress und Route-Epoche; erst danach erhaelt der Egress einen
Subscription-Plan. Audio, Bildschirmvideo und Bildschirmton bleiben getrennte
Single-Layer-Publikationen. Der Ingress demultiplext RID/SSRC, dekodiert nichts
und meldet die tatsaechlich vorhandenen Layer an die Control Plane. Diese
waehlt fuer Agent-Links exakt den bevorzugten vorhandenen Layer, einen
begrenzten niedrigeren Layer oder den portablen `single`-Fallback. Intent,
Agent-Anwendung und Publisher-Readiness tragen eine monotone
Subscription-Revision; ein verspaetetes Ergebnis einer alten Layerwahl kann
den Direct-Fallback daher nicht abschalten. Der eine SFrame-
Encrypt-Kontext des Publishers reserviert seinen Counter synchron vor jedem
asynchronen Encrypt-Aufruf, sodass parallele Simulcast-Frames keinen AES-GCM-
Nonce wiederverwenden.

Bei mindestens zwei aktiven Forwardern erzeugt die Control Plane direkte
Agent-Agent-Links als Stern um den Primary und pro Publisher einen gerichteten,
zyklusfreien DAG mit hoechstens zwei Hops. Ein Publisher auf dem Primary geht
direkt zu benoetigten Egress-Agenten; ein Publisher auf einem Standby geht bei
Bedarf ueber den Primary zum anderen Standby. Aus aktiven Subscription-Plänen
entstehen exakte `(Link, Richtung, Publisher, Publikation, Layer)`-Demands.
Nicht angeforderte Layer werden auf diesem Link nicht als Sender angebunden.
PLI-/FIR-Bursts mehrerer Downstreams werden pro Layer in einem begrenzten
Zeitfenster zusammengefasst; pro Layer gelten eine harte Paketqueue und das
raumweite Eingangsbitratebudget. Pions registrierte Standard-Interceptors
stellen den ausgehandelten RTCP-/NACK-Pfad bereit, ohne daraus eine garantierte
QoS abzuleiten.

SDP und ICE der Agent-Agent-`RTCPeerConnection` werden nur ueber die bereits
HMAC-authentisierte Control Plane vermittelt. Der darin ausgehandelte DTLS-
Fingerprint bindet den Gegenueber; ein direkter, geschlossener DataChannel
bestaetigt zusaetzlich Room, Route-Epoche, Link-ID, Agent-ID und frische Lease.
Nur danach fliesst SFrame-Ciphertext direkt zwischen den Agenten. Hello, ACK
und begrenzte Paketstatistiken koennen weder Membership noch neue Links oder
Layerrechte erzeugen. Unbekannte Felder, Richtungen, Epochen, Links und
Publikationen werden fail-closed verworfen. Die zugehoerigen geschlossenen
JSON-Schemas liegen unter `contracts/media-agent/`; Medien selbst werden nie
als JSON transportiert. Ein serverseitiger Full-Sync ist fuer maximal 32
konfigurierte Agent-Raeume auf 32 MiB begrenzt; pro Raum gelten hoechstens
1.520 Subscription-Plaene und 3.040 gerichtete Link-Demands. Nachrichten vom
Agenten zur Control Plane bleiben separat auf 96 KiB und 2.000 Nachrichten je
zehn Sekunden begrenzt. Layer- und Subscription-Aenderungen werden fuer 50 ms
zu einem autoritativen Snapshot zusammengefasst, statt fuer jeden Intent einen
neuen Full-Sync zu erzeugen.

Der Publisher entfernt einen direkten SFrame-Sender erst, nachdem der Egress
den Layer angewendet und der Zielbrowser den Receiver samt SFrame-Transform
installiert und quittiert hat. Layerwechsel, Linkende, Lease-Ende oder Fehler
aktivieren den vorhandenen Direct-Fallback wieder. Die native Foederation ist
damit ein implementierter selektiver, SFrame-blinder SFU-Pfad, aber weder eine
Bandbreitenreservierung noch eine 20-Teilnehmer-QoS-Garantie.

## Ports und Betrieb

Der Media-Agent baut seine WSS-Control-Verbindung ausgehend auf. Seine
WebRTC-ICE-Verbindungen koennen direkt, ueber STUN oder ueber autorisiertes TURN
entstehen. Eine feste UDP-Portfreigabe beziehungsweise oeffentliche IPv6
verbessert direkte Pfade und senkt TURN-Last, ist aber keine Protokollpflicht.
Ohne direkten NAT-Pfad muss erreichbares TURN vorhanden sein; der bestehende
TURN-Agent allein wird dadurch nicht zum Medien-SFU.

Ohne konfigurierte, authentisierte und vom Nutzer zugestimmte Media-Agenten
zeigt die UI nur das bestehende Mesh und behauptet keine Fanout-Reduktion. Ein
einzelner Agent arbeitet ohne Foederationslink; weitere Agenten werden nur
dann verbunden, wenn ihre jeweiligen Besitzer im selben Raum zugestimmt haben
und die Control Plane sie fuer die aktuelle Route auswaehlt.

## Reproduzierbarer Rechnerbetrieb

Der Agent wird getrennt von Control Plane und Browser-App gebaut. Auf einem
freiwilligen Linux-Rechner:

```bash
cd media-edge-agent
cp .env.example .env
# MEDIA_AGENT_SHARED_SECRET nur in .env setzen; nicht committen.
docker compose up -d --build
```

### Self-Service aus der Angular-App

Das öffentliche Deployment baut zusätzlich fünf native Artefakte für Linux
amd64/arm64, macOS amd64/arm64 und Windows amd64. Die App zeigt nur Artefakte,
die der Server beim Start wirklich gefunden und mit SHA-256 erfasst hat. Ein
Download entsteht ausschließlich nach einem sichtbaren Klick unter
`Einstellungen → Dein Media-Agent`; die Datei installiert nichts von selbst.

Der Ablauf trennt kurzlebige Einschreibung und dauerhafte Geräteidentität:

1. Die OIDC-authentisierte HTTP-Anfrage erzeugt eine zufällige Agent-ID und ein
   höchstens zehn Minuten gültiges Einmalticket, das im SQLite-Store nur als
   SHA-256-Hash liegt.
2. Der bewusst ausgeführte Installer lädt das feste Zielartefakt über HTTPS,
   vergleicht dessen eingebetteten SHA-256-Wert und startet genau einmal
   `media-edge-agent enroll`.
3. Der Agent erzeugt lokal einen P-256-Privatschlüssel mit restriktiven
   Dateirechten und beweist dessen Besitz über die serverseitige WSS-Challenge.
   Persistiert werden nur öffentlicher JWK und Fingerprint.
4. Spätere Starts signieren jede neue Challenge mit diesem Schlüssel. Ein
   Widerruf durch denselben exakten `issuer|subject`-Principal schließt eine
   aktive Verbindung und entfernt ihre Routing-Autorität.

Linux richtet nach Möglichkeit einen systemd-Benutzerdienst ein, macOS einen
LaunchAgent und Windows einen Autostart im Benutzerprofil. Keiner dieser Pfade
öffnet eine Firewall oder einen Routerport. Die Pakete sind derzeit nicht
kommerziell code-signiert beziehungsweise notarisiert; macOS und Windows sind
cross-kompiliert und checksum-geprüft, aber bis zu einem realen Gerätetest
weiterhin `unverified`.

`MEDIA_AGENT_SIGNAL_URL` ist eine ausgehende exakte
`wss://…/media-agent`-Adresse. Die serverseitige Variable
`MEDIA_EDGE_AGENTS_JSON` bindet dieselbe Agent-ID und dasselbe Secret an den
exakten `issuer|subject`-Principal des Besitzers. Erst dessen sichtbarer
UI-Consent stellt eine Raumkandidatur her. `Automatische Uebernahme` ist ein
separates Opt-in; ohne dieses erscheint bei einem Failover eine lokale Anfrage.

Mit `MEDIA_AGENT_UDP_PORT=0` nutzt Pion normale dynamische ICE-Sockets und kann
bei Bedarf das von der Control Plane autorisierte TURN verwenden. Fuer einen
fest weitergeleiteten Port wird beispielsweise `MEDIA_AGENT_UDP_PORT=44000`
gesetzt; hinter NAT muss `MEDIA_AGENT_PUBLIC_IP` zur tatsaechlich erreichbaren
oeffentlichen IPv4-Adresse passen und exakt dieser UDP-Port in Router und
Host-Firewall freigegeben sein. Die Portfreigabe verbessert Direct-ICE, ersetzt
aber weder Consent noch Agent-Authentisierung oder TURN fuer problematische
Netze.

Vor einem Rollout sind mindestens `go test -race ./...`, ein Image-Build sowie
der reale Mehr-Browser-/Mehr-Agent-/NAT-Gate aus BME-006/BME-011 erforderlich.
Der lokale Pion-Gate belegt individuelle Simulcast-Auswahl und einen direkten
Zwei-Agenten-Pfad mit byte-identischem opaque Payload. Solange die echte
Produktionsmatrix fehlt, ist die Implementierung nicht als garantierter
20-Teilnehmer-QoS-Pfad zu beschreiben.
