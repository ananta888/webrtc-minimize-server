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

Der opt-in Live-Gate erzeugt sechs Sekunden synthetisches Audio/Video, leitet es
per Pipe durch die echte FFmpeg-6-Pipeline und prüft drei Master-/Media-
Playlists, H.264/AAC, unabhängige Segmente und sauberes Ende:

```bash
RUN_LIVE_NATIVE_PACKAGER=1 npm run test:native-packager
```

## Ehrlich offene Punkte

Noch nicht vorhanden sind der installierbare eigenständige Daemon, signierte
Release-Artefakte, Keychain/Keystore-Anbindung, Control-Plane-Enrollment,
WHIP-Empfang, MediaMTX-Publish, Temperaturmessung, Hardware-Fallback nach einem
realen Encoderfehler und OS-spezifische Sandbox-/Firewall-/Update-
Deinstallationspfade. Der Browser-Packager bleibt unabhängig verfügbar und die
UI wählt Native nicht automatisch. TBP-016 bleibt deshalb `partial`.
