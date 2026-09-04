# Freiwilliger Native-Packager

## Implementierte Policy- und Pipeline-Basis

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

CPU-/Upload-/Pixelbudget reduziert diese Leiter vor dem Start. Hardwareencoder
werden nur nach expliziter Anforderung und Capability gewählt; `libx264` bleibt
der notwendige Software-Fallback. Keyframes liegen alle zwei Sekunden,
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

## Ehrlich offene Punkte

Noch nicht vorhanden sind der installierbare eigenständige Daemon um den nun
getesteten Supervisor, signierte
Release-Artefakte, Keychain/Keystore-Anbindung, Control-Plane-Enrollment,
WHIP-Empfang, MediaMTX-Publish, Temperaturmessung, Hardware-Fallback nach einem
realen Encoderfehler sowie OS-spezifische Sandbox-/Firewall-/Update-
Deinstallationspfade. Der Browser-Packager bleibt unabhängig verfügbar und die
UI wählt Native nicht automatisch. TBP-016 bleibt deshalb `partial`.
