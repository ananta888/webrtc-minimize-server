# Broadcast-Interoperabilitätsbericht

Stand: 2026-09-04. Maschinenlesbare Ergebnisse stehen in `infra/testing/broadcast-interop-results.v1.json`.

Auf Linux/WSL2 wurden MediaMTX 1.20.1, FFmpeg 6.1.1 und Playwright 1.62.1 real ausgeführt. Chromium 151, Firefox 153 und ein echter Windows Edge 152.0.4191.53 publizierten VP8 per WHIP mit POST, Trickle-PATCH, ICE-Verbindung und DELETE. Vier `replaceTrack`-Quellenwechsel lieferten nach jedem Wechsel weitere codierte Frames; ICE-Restart bleibt im MediaMTX-1.20-Profil sichtbar unsupported. Edge wurde über einen kurzlebigen lokalen CDP- und TCP-Bridge-Prozess aus WSL angesprochen; beide Prozesse wurden nach dem Gate beendet. Das lokale Testprofil besitzt ausschließlich für diesen Gate Wildcard-CORS, ein synthetisches internes Credential, Loopbackports und deaktivierte Firefox-mDNS-Verschleierung. Diese Lockerungen gehören nicht zum sicheren Gatewayprofil.

Der Native-Packager erzeugte drei ausgerichtete H.264/AAC-Renditions. Der LL-HLS-Gate bestätigte späten Viewerbeitritt, Protokollversion >= 9, Blocking Reload, 200-ms-Parts, begrenztes Fenster, abrufbare Init-/Mediaobjekte, Publisher-Neustart und Cleanup des alten Muxers. Der normale Raum bestand Chromium/Firefox-SFrame, DataChannel, Vosk und den VP8-Langzeittest über Counter 350; Bildschirmton bleibt default-aus und separat widerrufbar.

Nicht verifiziert sind macOS Safari, physische Android-/iOS-Geräte, natives Safari-HLS, Mobilfunk/NAT/Netzwechsel, geformter WAN-Paketverlust, blockiertes UDP/QUIC, akustische Echo- und visuelle A/V-/Caption-Sync-Messung sowie Cloudflare/andere Provider. Diese Zeilen bleiben ausdrücklich `unverified`, `unavailable` oder `experimental`; sie sind Voraussetzungen für eine öffentliche Broadcast-Freigabe.

Der komplette verfügbare lokale Gate läuft mit:

```sh
RUN_LIVE_BROADCAST_LOCAL_INTEROP=1 npm run test:interop:local
```

Er benötigt Docker, FFmpeg 6+, installierte Playwright-Browser und einen freien lokalen ICE-Port 8189. Er verändert keine Produktionsdienste und entfernt seine kurzlebigen Testcontainer anschließend.

Optional nimmt der Runner mit `EDGE_CDP_ENDPOINT=http://<lokale-bridge>:<port>` einen bereits separat gestarteten Edge-CDP-Kontext hinzu. Die Bridge darf nur kurzlebig im lokalen Testnetz existieren und ist kein Deploymentdienst.
