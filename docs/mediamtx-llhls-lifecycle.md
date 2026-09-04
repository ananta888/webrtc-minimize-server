# MediaMTX LL-HLS-Lifecycle-Gate

## Verifizierter Umfang

Der opt-in Gate `npm run test:llhls:mediamtx` startet MediaMTX 1.20.1 in einem
eigenen Compose-Projekt und aktiviert RTSP/TCP ausschließlich über
`infra/mediamtx/compose.live-test.yaml` auf Loopback. Ein lokaler FFmpeg-6+
Publisher liefert synthetisches H.264 High-Compatibility-Video mit AAC-Audio.
Das normale Adapterprofil behält RTSP deaktiviert und wird dadurch nicht um
einen Produktions-Ingest erweitert.

Mit `RUN_LIVE_MEDIAMTX_LLHLS=1` prüft der Gate real:

- einen um zwei Sekunden verspäteten Viewer-Einstieg,
- LL-HLS-Protokollversion 9 oder neuer, Blocking Reload und 200-ms-Parts,
- H.264/AAC-fMP4-Initialisierung und abrufbare unabhängige Parts,
- ein auf sieben Segmente begrenztes Playlistfenster,
- auf zwei Sekunden ausgerichtete Segmente und Encoder-Keyframes,
- fehlende Bearer-/Access-Token in Playlist-URLs,
- vollständiges Verschwinden des HLS-Muxers nach Publisher-Stop innerhalb des
  30-Sekunden-Limits,
- einen neuen, vom alten fMP4-Init getrennten Stream nach Publisher-Neustart
  und dessen erneutes Aufräumen.

Die sieben Zwei-Sekunden-Segmente begrenzen das aktive Medienfenster auf etwa
14 Sekunden zuzüglich des gerade aufgebauten Parts. `hlsSegmentMaxSize: 20M`
begrenzt einzelne Segmente; `hlsDirectory: ""` und `record: false` halten den
Defaultpfad flüchtig und erzeugen weder DVR noch Aufnahmeverzeichnis. Ein
inaktiver Muxer wird nach höchstens 30 Sekunden geschlossen.

Ausführen:

```bash
RUN_LIVE_MEDIAMTX_LLHLS=1 npm run test:llhls:mediamtx
```

## Noch nicht verifiziert

Der Gate beweist Gateway-Authoring und Lifecycle, aber noch keinen
End-to-glass-Browserpfad. Ein realer 60-Minuten-Lauf mit Safari/iOS, Chromium,
Firefox und Android, gemessener Uhr, A/V-Sync, Rebuffering, Prozessressourcen,
Netzwerkwechsel sowie ein Source-Wechsel mit expliziter Discontinuity bleibt
offen. Insbesondere transcodiert MediaMTX VP8/Opus aus einem typischen
Browser-WHIP-Pfad nicht automatisch nach H.264/AAC. Der Test-RTSP-Eingang ist
kein öffentlicher oder produktiver Ersatz für den autorisierten WHIP-/Native-
Packager-Pfad.
