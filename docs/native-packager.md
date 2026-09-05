# Freiwilliger Native-Packager

## Implementierte Policy-, Enrollment- und Pipeline-Basis

Der Native-Packager ist eine getrennte, explizit aktivierte Trusted-Rolle und
nicht der vorhandene blinde Media-Agent. Sein Capability-Report ist geschlossen,
kurzlebig und enthält nur pseudonyme Geräte-/Owner-/Tenant-Bindungen, Version,
verfügbare H.264-/AAC-Encoder sowie grobe CPU-, GPU-, Upload-, Energie- und
Health-Klassen. Diese Angaben verleihen keine Autorität: Admission benötigt
zusätzlich den exakten Tenant/Owner und einen vom Benutzer consentierten Raum.
Battery-, Draining-, fremde Raum- und abgelaufene Reports werden abgelehnt.

Die aktuelle Pipeline plant höchstens drei H.264/AAC-Renditions:

| Layer | Bild | FPS | Video | Audio |
|---|---:|---:|---:|---:|
| low | 640 × 360 | 15 | 500 kbit/s | 64 kbit/s |
| medium | 960 × 540 | 24 | 1,1 Mbit/s | 96 kbit/s |
| high | 1280 × 720 | 30 | 2,4 Mbit/s | 128 kbit/s |

CPU-/Upload-/Pixelbudget reduziert diese Leiter vor dem Start. Ein
Hardwareencoder wird nur nach expliziter Anforderung und einem beim Agentstart
wirklich bestandenen, auf drei Sekunden begrenzten Test-Encode gewählt; eine
reine FFmpeg-Encoderliste reicht nicht. Der geschlossene
`assignment-prepare.v2` bindet die Auswahl und genau `libx264` als
Software-Fallback. Agenten vor 0.6.0 erhalten kompatibel v1 und ausschließlich
`libx264`. Keyframes liegen alle zwei Sekunden,
Szenenwechsel-Keyframes sind deaktiviert und jede Rendition erhält dieselbe
Grenze. FFmpeg wird als Argumentvektor ohne Shell gestartet, liest nur von
`pipe:0` und schreibt ausschließlich unter eine validierte opaque
`res_`-Resource im vorgegebenen Root. Playlistfenster und alte Segmente sind
begrenzt; die Queue-Vorgabe beträgt 60 Frames.

`NativePackagerSupervisor` setzt diese Policy als getrennte Prozessgrenze um.
Er startet FFmpeg ausschließlich ohne Shell, nimmt höchstens 1 MiB pro
Input-Chunk an und puffert bei FFmpeg-Backpressure keine zweite unbeschränkte
Queue. Ein Programm wird an `programId` plus `programEpoch` gefencet. Scheitert
ein ausdrücklich gewählter Hardwareencoder, wird genau einmal auf den
deklarierten `libx264`-Pfad gewechselt; danach endet der Lauf sichtbar als
fehlgeschlagen. Stop wartet begrenzt, erzwingt nötigenfalls `SIGKILL` und löscht
den ausschließlich unterhalb der validierten `res_`-Resource erzeugten Output.
Beobachter erhalten nur Zustand, Encoder, Byte-/Drop-Zähler und niemals
Medieninhalt oder FFmpeg-Argumente.

Auf Linux liest der Agent zusätzlich die vorhandenen Kernel-Sensoren unter
`/sys/class/thermal` und `/sys/class/hwmon`, ohne dafür Schreibrechte oder
Host-Tools zu benötigen. Ab 80 °C meldet er `degraded` und markiert einen
laufenden Auftrag mit `THERMAL_PRESSURE`; unterhalb der Grenze darf genau dieser
Zustand mit `THERMAL_RECOVERED` zurückkehren. Ab 90 °C meldet er `draining`,
fencet den Auftrag lokal, stoppt Medien/FFmpeg und sendet `THERMAL_LIMIT`.
Fehlende Sensoren auf Linux, macOS oder Windows erfinden keinen Messwert und
belassen die übrige Health-Prüfung; ungültige Sensorwerte werden ignoriert.

Der eigenständige Go-Daemon unter `native-broadcast-packager/` ist eine andere
Binärdatei, Identität und WebSocket-Route als der blinde Relay-Agent. Er öffnet
keinen Listener und benötigt keine Portfreigabe. Beim ersten Start registriert
er einen lokal mit Modus `0600` abgelegten, nicht über das Protokoll
exportierten P-256-Private-Key über ein zehn Minuten gültiges Einmalticket.
Danach authentisiert er jede WSS-Verbindung mit einer frischen Challenge,
prüft lokal FFmpeg ab Version 6 sowie `libx264` und AAC und meldet nur die
begrenzten Capability-Klassen aus dem Contract. NVENC beziehungsweise
VideoToolbox erscheinen nur nach erfolgreichem Test-Encode mit der tatsächlich
laufenden FFmpeg-/Treiber-/Gerätekombination. VAAPI wird derzeit nicht gemeldet,
weil der notwendige gerätegebundene Upload-/Filterpfad noch nicht Teil der
portablen Pipeline ist; das Vorhandensein von `/dev/dri` allein genügt nicht.

Für dauerhaft betriebene, operatorverwaltete Rechner gibt es zusätzlich eine
offline provisionierbare Registrierung ohne Benutzerpasswort und ohne
langfristiges OIDC-Token. Der Agent erzeugt seinen P-256-Private-Key innerhalb
seines persistenten lokalen Volumes und gibt über `operator-manifest` nur einen
geschlossenen, mit diesem Schlüssel signierten Registrierungsnachweis aus. Das
lokale Administrationstool
`node src/native-packager-operator-provision.js DATABASE_FILE` prüft Proof of
Possession, Konto-/Plattformbindung, Schema, Quota und Duplikate, bevor es die
normale Registrierungsdomäne verwendet. Danach authentisiert sich der Agent wie
jeder selbst installierte Packager ausschließlich über frische WSS-Challenges.
Ein Widerruf durch den Kontoinhaber bleibt endgültig; derselbe Nachweis kann die
widerrufene ID nicht reaktivieren.

Das Compose-Profil `native-packager` stellt dafür einen eingehend portlosen,
read-only laufenden Container mit FFmpeg 6+, eigener unprivilegierter UID,
gelöschten Linux-Capabilities, PID-/CPU-/RAM-Limits und einem einzigen
persistenten Identitätsvolume bereit. `restart: unless-stopped` macht den
Agenten nach Host- oder Docker-Neustarts wieder erreichbar. Die einmalige
operatorseitige Zuordnung ersetzt nur den interaktiven Installationsschritt:
Die Freigabe eines konkreten Raums bleibt absichtlich flüchtig und erfordert
weiterhin einen sichtbaren Klick des angemeldeten Kontoinhabers in der Web-App.

Die Control Plane kann genau eine kurzlebige Assignment-Vorbereitung
pro Packager und Programm ausgeben. Sie entsteht nur aus einem sichtbaren
`user-action`, aktueller Owner-Membership, wirksamem Raumconsent und einer
frischen Capability. Assignment, Programm und Writer-Lease sind an
`programEpoch`, `leaseId` und eine monotone `fencingRevision` gebunden. Der
Daemon akzeptiert nur den geschlossenen H.264/AAC-Profilvertrag, lehnt zweite
oder alte Assignments ab und quittiert `ready`, `starting`, `running`,
`degraded`, `draining`, `stopped` oder `failed` über eine separate
Statusnachricht. `running` mit `OUTPUT_READY` wird erst gesendet, nachdem das
Master-Manifest und alle vereinbarten Rendition-Manifeste tatsächlich sichtbar
sind. Die Control Plane gibt diesen gefenceten, inhaltsfreien Zustand nur an
den zugewiesenen Publisher-Browser weiter; dessen Start-Promise und sichtbarer
Running-State warten maximal 30 Sekunden genau auf dieses Signal. Während einer
aktiven Verbindung verlängert nur ein frisch
authentisierter Agent-Heartbeat die 60-Sekunden-Assignment-Lease. Das
geschlossene `assignment-renew` übernimmt weder neue Quellen noch eine neue
Fence. Disconnect und Lease-Ablauf schließen die Pion-
`RTCPeerConnection` lokal; die Control Plane sendet zusätzlich einen
epoch-/fencinggebundenen Stop und verwirft danach die Zuordnung.

Nach der Vorbereitung baut der Browser eine eigene, assignmentgebundene
WebRTC-Verbindung zum ausgewählten Packager auf. Nur die vor dem SFrame-Pfad
bewusst gewählte Broadcast-Komposition wird als DTLS-SRTP übertragen. Offer,
Answer und Trickle-ICE laufen als getrennte, größenbegrenzte
`native-packager-signal`-/`assignment-peer-signal`-Frames über das bestehende
WSS; sie tragen keine OIDC-Tokens, Grants oder neue Autorität und werden nicht
geloggt. Beide Seiten prüfen Assignment, Publisher-Peer, Program-Epoche und
Fencing-Revision. Der Agent akzeptiert ausschließlich ein Offer, begrenzt die
ICE-Warteschlange auf 128 Einträge und meldet den Medieneingang getrennt vom
fertigen Output. Ein echter Pion-Integrationstest überträgt dafür
VP8-RTP vom simulierten Browser bis zum nativen Receiver. Der Agent öffnet
weiterhin keinen Listener: Host-ICE, optionale öffentliche STUN-URLs und die
vom Browser erhaltenen kurzlebigen TURN-Credentials bestimmen den Pfad.

Optional transportiert dieselbe PeerConnection einen einzigen geordneten
`broadcast-captions-v1`-DataChannel. Er wird nur bei expliziter
Broadcast-TextTrack-Freigabe angelegt. Nachrichten sind an Assignment,
Program-Epoche und Fencing-Revision gebunden, auf 70 KiB begrenzt und werden
mit einem geschlossenen Update-/Revoke-Schema geprüft. Der SCTP-Empfangspuffer
ist auf 256 KiB begrenzt. Der Agent schreibt nur das aktuelle, maximal 64 KiB
große WebVTT-Livefenster atomar unter die zugewiesene `res_`-Resource; weder
Control Plane noch Blind-Agent sehen den Text. Burn-in verbleibt im
Publisher-Compositor und wird als Bildinhalt mit dem Program-Video übertragen.

Die Angular-Analyse bietet getrennte Installation, Status, Widerruf und eine
ausdrückliche Raumfreigabe. Die Control Plane übernimmt eine vom Agenten
gemeldete Raum-ID ausschließlich dann in die effektive Capability, wenn der
exakte OIDC-Kontoinhaber in einer aktiven Membership denselben Raum freigegeben
hat. Raumfreigaben sind absichtlich flüchtig und nach Serverneustart aus. Eine
Freigabe startet keine Capture-API und wählt keinen Writer automatisch.

Das Image baut reproduzierbar mit Go 1.24 statische Artefakte für Linux
amd64/arm64, macOS amd64/arm64 und Windows amd64. Nur vorhandene Artefakte
werden angeboten. Der heruntergeladene Installer bindet den exakten SHA-256-
Hash ein, entfernt das Einmalticket nach Enrollment und installiert einen
Benutzerdienst. Der Linux-Dienst setzt unter anderem `NoNewPrivileges`,
`ProtectSystem=strict`, eine begrenzte beschreibbare Root und Ressourcenlimits.
Der Agent benötigt nur ausgehendes HTTPS/WSS; Installer verändern keine
Firewall. Ein Uninstaller wird im privaten Agent-Verzeichnis abgelegt.

Jeder Build enthält außerdem eine geschlossene, rein technische
`native-packager-build`-Auskunft. Sie ist ohne Konfiguration und ohne Zugriff
auf die Geräteidentität abrufbar:

```bash
native-broadcast-packager version
```

Git-Revision, Commit-Zeit, Agent-/Go-Version, Betriebssystem und Architektur
lassen sich damit dem geladenen Artefakt zuordnen. CI baut alle fünf Ziele mit
dem in `go.mod` gepinnten Toolchain-Stand, veröffentlicht ihre SHA-256-Liste als
kurzlebiges Workflow-Artefakt und erstellt bei vertrauenswürdigen Pushes eine
keyless GitHub-Artifact-Attestation für jede Binärdatei. Nach einem bewussten
Download kann ein Operator diese unabhängig vom WebRTC-Server prüfen:

```bash
gh attestation verify native-broadcast-packager-linux-amd64 \
  --repo ananta888/webrtc-minimize-server
```

Pull Requests aus fremden Forks erhalten kein OIDC-Signing: Sie bauen und
testen dieselben Artefakte, überspringen aber die Attestation ausdrücklich.
Die attestierten CI-Binaries und die zur Laufzeit im Web-Image angebotenen
Binaries sind erst dann gleichzusetzen, wenn Revision, eingebettete Buildzeit
und SHA-256 exakt übereinstimmen.

SHA-256 plus die getrennte GitHub-Attestation machen den Build gegen Repository
und Workflow prüfbar, ersetzen aber keine plattformspezifische
Publisher-Signatur. Windows Authenticode und Apple Developer ID sind noch nicht
vorhanden und die UI weist ausdrücklich darauf hin. Private Keys
werden derzeit als nur für den jeweiligen unprivilegierten Benutzer lesbare
Datei mit Modus `0600` gespeichert; eine Keychain-/TPM-Anbindung bleibt ein
Hardening-Schritt.

Capability und Live-Gate akzeptieren jetzt tatsächlich nur FFmpeg ab Major 6;
eine bloß vorhandene ältere Binärdatei reicht nicht mehr. Neben dem lokalen
FFmpeg-6.1.1-Lauf bestand derselbe synthetische Drei-Rendition-Gate auf
`minipc.ananta.de` in einem kurzlebigen, CPU-/RAM-/PID-begrenzten Container mit
FFmpeg 8.1.2. Auf dem Mini-PC wurde dafür bewusst kein Hostpaket installiert und
BBB, Caddy sowie der blinde Media-Agent blieben unverändert. Die versionierte
Messnotiz steht in `infra/testing/broadcast-validation-results.v1.json`.

Der opt-in Live-Gate erzeugt sechs Sekunden synthetisches Audio/Video, leitet es
per Pipe durch die echte FFmpeg-6-Pipeline und prüft drei Master-/Media-
Playlists, H.264/AAC, unabhängige Segmente und sauberes Ende:

```bash
RUN_LIVE_NATIVE_PACKAGER=1 npm run test:native-packager
```

Der produktive Agent nimmt ausschließlich VP8/Opus-RTP über lokale, vererbte
Pipes an. Pro Assignment startet er FFmpeg ohne Shell und ohne Netzwerkziel,
erzeugt eine admission-kontrollierte H.264-Main/AAC-Leiter mit gemeinsamen
Zwei-Sekunden-GOPs, maximal sieben fMP4-Segmenten und bounded RTP-Queues und
löscht die `res_`-Ausgabe bei Stop. Ein separater statischer
`broadcast-hls-origin` liest dasselbe Volume ausschließlich read-only, verlangt
die bereits von der Node-Control-Plane geprüfte Bearer-Grenze und akzeptiert
nur geschlossene Manifest-, Init-, Segment- und WebVTT-Dateinamen. Beide
Container besitzen keine Host-Ports; nur der Node-Proxy ist mit dem internen
Origin-Netz verbunden. Nach einem Prozessneustart entfernt der Agent verwaiste
`res_`-Verzeichnisse, ohne Identität oder andere Dateien anzufassen.

Der zusätzliche reale Gate benötigt FFmpeg 6+:

```bash
RUN_LIVE_NATIVE_TRANSCODE=1 go test ./native-broadcast-packager -run TestLiveVP8ToH264AACPipeline -v
```

Er speist einen viersekündigen VP8-RTP-Strom in die echte Pipeline, prüft zwei
H.264/AAC-Renditions und das ABR-Master-Manifest, verlangt den
`OUTPUT_READY`-Callback und bestätigt das Löschen des flüchtigen Outputs.

Ab Agent 0.7.0 verwendet `assignment-prepare.v3` eine geschlossene, kurzlebige
ICE-Konfiguration. Die Control Plane stellt STUN und ausschließlich
agentgebundene Coturn-REST-Credentials für die konkrete Zuweisung bereit.
Dadurch bleibt der Agent ausgehend verbunden und benötigt auch hinter
Docker/NAT keinen pauschal geöffneten eingehenden UDP-Port. Ältere
v1/v2-Agenten erhalten keine Credential-Felder.

## Ehrlich offene Punkte

Der Daemon besitzt nun den gefenceten WebRTC-RTP-Eingang, die echte
FFmpeg-Transcode-/ABR-Pipeline und den intern autorisierten HLS-Origin. Diese
native Ausgabe ist absichtlich normales, kurzes fMP4-HLS und wird nicht als
Apple-LL-HLS ausgegeben; der vorhandene MediaMTX-WHIP-Pfad bleibt der getrennte
LL-HLS-Adapter. Ein echter FFmpeg-Prozessabbruch auf dem Hardwarepfad ist als
einmaliger, sichtbarer Software-Fallback getestet; offen bleiben ein physischer
GPU-/Treiberfehler und ein provozierter Temperatur-Gate,
Windows-Authenticode-/Apple-Developer-ID-Signaturen, Keychain/TPM,
Update-Rollback, mehrere Stunden Soak sowie echte Windows-/macOS- und mobile
Player-Gates. Deshalb bleibt
TBP-016 `in_progress`; die UI zeigt nur online/gesund/raumconsentierte eigene
Packager, verlangt eine explizite Auswahl und fällt nicht stillschweigend von
Browser auf Native zurück.
