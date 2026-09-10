# Capability-gesteuerter Broadcast-Player

`BroadcastHlsPlayer` wählt pro konkretem `HTMLVideoElement` genau eine Engine:
bevorzugt die exakt gepinnte `hls.js`-Version 1.7.2 über Media Source Extensions,
sofern diese tatsächlich unterstützt wird. Erst ohne diese Capability wird
natives HLS anhand von `application/vnd.apple.mpegurl` gewählt. Eine unvollständige
native HLS-Ankündigung verdrängt somit nicht die funktionsfähige hls.js-Engine.
Die primäre Engine ist statisch in den atomaren Angular-Build eingebunden. Das
vergrößert den komprimierten Initialtransfer gemessen von rund 213 auf 361 KiB,
verhindert aber, dass ein erst beim Zuschauer-Klick nachgeladener ES-Modulchunk
bei einem Browser-Netzwechsel dauerhaft als fehlgeschlagen gecacht wird. Das
Produktionsbudget bleibt mit 1,5 MB Warn- und 1,6 MB Fehlergrenze eng.
Fehlt beides, wird sichtbar `broadcast_hls_unsupported` gemeldet. MoQ und WHEP
werden dadurch nicht implizit aktiviert.

Der austauschbare Engine-Loader besitzt ein gemeinsames Fünfsekundenbudget
für beide maximalen Versuche einschließlich der bestehenden 250-ms-Pause.
Eine fehlgeschlagene oder hängende Engine-Auflösung endet mit dem festen Code
`broadcast_player_engine_unavailable`; sie startet keine Medienrequests,
erneuert keine Grants und wechselt nicht still auf natives HLS. `destroy()`
oder externer Abort beendet das Warten sofort. Ein an den Loader gereichtes
AbortSignal erlaubt kooperativen Adaptern den Abbruch; eine nicht kooperative
Promise lässt sich dadurch nicht selbst beenden, ihr verspätetes Ergebnis
wird jedoch nicht mehr benutzt. Alte Versuche dürfen weder erneut starten
noch eine neuere Playergeneration anhängen oder schließen. Der separate
20-Sekunden-Manifest-Timeout bleibt unverändert. Dies ist keine Umstellung
der gepinnten primären Engine auf nachgeladene ES-Module.

Verifikation am 10. September 2026: Der zuvor unbegrenzt wartende Loader ist
mit einer Fake-Timer-Reproduktion nachgewiesen; nach Korrektur bestehen alle
17 gezielten Player-/Komponententests in 1,340 Sekunden. Abgedeckt sind
Timeout, externer Abort, Destroy, späte Antworten, überholte Generationen,
Retry innerhalb desselben Budgets und native-HLS-/Manifest-/Caption-
Regressionen. Video-, MSE- und Netzwerkports sind dabei synthetisch; es läuft
keine lokale Wiedergabe. TypeScript, Todo-Gate und ein isolierter realer
Produktionsbuild (9,245 s) bestehen. Reale Browser-/Netzwerkgates und Rollout
bleiben gesondert erforderlich; die 1,5-MB-Warnschwelle bleibt überschritten.

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

Ein End- oder Fehlerzustand bleibt für diese Playergeneration terminal. Dies
gilt insbesondere für HTTP 401/403/404/410, das Ratelimit 429, ausgeschöpfte
Recovery und native Medienfehler. Der Player stoppt Watchdog, HLS-Loads und
Caption-Polling, bricht eine laufende Caption-Anfrage ab, entfernt eigene
Untertitel und pausiert die Wiedergabe. Späte `playing`-Events, Play-Promises,
Qualitätsänderungen oder weitere Decoderfehler dürfen weder die alte Ausgabe
neu starten noch deren Endzustand überschreiben. Auch Decoder-Reinitialisierung
verbraucht das bestehende Zwei-Versuche-Budget und findet nicht davor statt.
Erst Destroy und eine neue Ausgabe-/Sitzungsgeneration können wieder öffnen;
der übergeordnete autorisierte Handoff-/Viewer-Recovery-Pfad bleibt zuständig.
Bereits empfangene Medien lassen sich beim Empfänger dadurch nicht rückwirkend
widerrufen; serverseitige Request-Autorisierung bleibt unabhängig erforderlich.

Zusätzlich prüft der Caption-Poller seine Generation bereits unmittelbar nach
der HTTP-Antwort. Eine alte, trotz Abort verspätete 404 darf deshalb nicht den
Untertiteltrack einer inzwischen geöffneten neuen Ausgabe entfernen.

Die ursprüngliche Lücke wurde für alle fünf genannten HTTP-Codes mit jeweils
drei erneuten `startLoad`-Aufrufen innerhalb von 40 Sekunden Fake-Zeit
reproduziert. Die Regressionstests prüfen das Unterbleiben neuer Loads und
Decoderstarts, unveränderten Endzustand, späte Play-Ergebnisse, Caption-Abbruch,
native End-/Fehlerereignisse sowie eine anschließend funktionsfähige neue
Generation. Es sind synthetische Engine-/DOM-Tests, kein Produktionsnachweis.

Die Handoff-Beobachtung nutzt wie Audio-/Szenensteuerung einen getrennten,
bedarfsgeladenen HTTP-Adapter. Dadurch bleiben Auth, geschlossener Parser,
4096-Byte-Grenze und Abort-Prüfung erhalten, ohne das initiale Bundle um den
optionalen Regieparser zu vergrößern. Die bewusst statische HLS-Engine bleibt
unverändert; die Buildbudgetgrenzen wurden nicht angehoben.

Für diese Endzustands-/Handoff-Runde bestehen 70 gezielte Frontend-,
HTTP-Adapter- und Handoff-Controller-Tests (1,400 s), TypeScript/Angular-no-emit
und das Todo-Gate. Der isolierte Produktionsbuild besteht in 9,582 s mit
1.598.533 initialen Bytes bei unveränderter 1.600.000-Byte-Hardcap;
die Warnschwelle bleibt überschritten. Das lokal ausgelieferte `dist` wurde
nicht verändert. Gesamtcheck und reale Browserabnahme erfolgen separat in CI.

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
zur Bestätigung erforderlich; das Cockpit fencet die alte Ausgabe und startet
danach eine neue Publikation, während ein geöffneter alter Player sicher endet.

Noch nicht vollständig freigegeben sind Poster sowie reale Safari/iOS-,
Android-, Chromium- und Firefox-Langzeitgates. Der native HLS-/WebVTT-Pfad ist
verdrahtet; Provider- und MediaMTX-Captionadapter bleiben getrennte offene Gates.
