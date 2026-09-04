# Capability-gesteuerter Broadcast-Player

`BroadcastHlsPlayer` wählt pro konkretem `HTMLVideoElement` genau eine Engine:
natives HLS, wenn der Browser `application/vnd.apple.mpegurl` meldet, sonst die
exakt gepinnte stabile `hls.js`-Version 1.7.2 über Media Source Extensions.
Fehlt beides, wird sichtbar `broadcast_hls_unsupported` gemeldet. MoQ und WHEP
werden dadurch nicht implizit aktiviert.

Die Oberfläche nennt den [aktuellen MoQ-Vertragsstand](moq-contracts-and-negotiation.md)
explizit als experimentell und deaktiviert. Sie zeigt MOQT draft-20, LOC
draft-04, die inkompatiblen MediaMTX-/Cloudflare-Draftstände und LL-HLS/HLS als
Fallback, statt vorhandenes WebTransport mit einem funktionierenden MoQ-Pfad
gleichzusetzen.

Der getrennte [experimentelle MoQ-Player-Orchestrator](moq-player-fallback.md)
prüft bereits Scope, Pins, Autorisierung, Secure Context, WebTransport, Codec
und bestätigte QUIC-Öffnung. Seine sequenzielle Einmal-Fallback- und
Telemetrielogik ist getestet, bleibt aber bis zu einem kompatiblen Adapter und
realen Browser-/Netzwerkgates von dieser öffentlichen HLS-Komponente getrennt.

Ein Start erfolgt ausschließlich durch `BroadcastPlayerComponent.start()` nach
dem sichtbaren Klick. Der Player fordert keine Capture-Berechtigung an. Ein
Autoplay-Verbot wird als `awaiting-user` dargestellt. Mute, Lautstärke,
Vollbild, Picture-in-Picture und bei hls.js Auto-/Rendition-Auswahl sind
getrennte lokale Bedienelemente; natives HLS behält seine eigene automatische
Qualitätswahl.

Das hls.js-Profil aktiviert Low-Latency-Modus und begrenzt Rück-/Vorbuffer auf
30 beziehungsweise 20 Sekunden. Ein Watchdog erkennt drei ausbleibende
Fortschrittssamples, springt kontrolliert zur Live-Position und erlaubt
höchstens zwei Recoveries in 30 Sekunden. Danach endet der Versuch sichtbar,
statt bei weiterlaufendem Download unbeschränkt neu zu laden.

Manifest-URLs sind auf den exakten Same-Origin-Pfad
`/broadcast/play/res_…/index.m3u8` beziehungsweise `master.m3u8` begrenzt.
Credentials, Fragment und jede Query werden verworfen. hls.js sendet nur
Same-Site-Credentials. Das konkrete HttpOnly-Cookie-/Proxy-Modell wird vom
Playback-Gateway bereits durchgängig angewendet. Fehlerzustände enthalten nur lokale
Codes und weder Program-ID, Resource-Pfad noch Gatewayantwort.

Wenn das autorisierte Directory Untertitel ankündigt, lädt ein getrennter,
begrenzter Poller ausschließlich `captions_live.vtt` aus demselben geschützten
Resource-/Cookie-Scope. Er akzeptiert nur `text/vtt`, maximal 64 KiB und einen
gültigen `WEBVTT`-Header, ersetzt den lokalen Blob-TextTrack nur bei Änderung
und behandelt 404/Widerruf ohne Ausfall von Bild und Ton.

Abort, Schließen, Tab-Hintergrund, Navigation und Component-Destroy stoppen
Loads, zerstören hls.js, entfernen Listener und eigene Texttracks, pausieren das
Video und löschen `src`. Nach Sichtbarkeitswechsel ist ein neuer lokaler Klick
erforderlich.

Noch nicht vollständig freigegeben sind Poster sowie reale Safari/iOS-,
Android-, Chromium- und Firefox-Langzeitgates. Der native HLS-/WebVTT-Pfad ist
verdrahtet; Provider- und MediaMTX-Captionadapter bleiben getrennte offene Gates.
