# Broadcast-Capability-Matrix

Stand: **2026-09-03**. Die maschinenlesbare Source of Truth ist
[`broadcast-capability-matrix.v1.json`](broadcast-capability-matrix.v1.json).
Sie ist bewusst eine versionierte Evidenzinventur und noch kein
Broadcast-Domain-Contract. Die eigentlichen, geschlossenen Domain-Schemas
folgen in TBP-005.

## Leseregel

Die Matrix trennt immer zwei Aussagen:

- `upstreamStatus` beschreibt, was die gepinnte Spezifikation, Browserdatenbank
  oder Herstellerdokumentation belegt;
- `productStatus` beschreibt, was dieses Repository auf der benannten Version
  reproduzierbar geprüft hat.

Die vier erlaubten Zustände sind:

| Zustand | Bedeutung |
| --- | --- |
| `supported` | Upstream belegt; als Produktstatus zusätzlich durch ein reales Projektgate belegt. |
| `degraded` | Nur mit dokumentierter Plattform-, Bedien-, Codec- oder Transporteinschränkung. |
| `experimental` | Draft, Beta, instabile API oder noch nicht bestandene Interoperabilität. |
| `unavailable` | Nicht vorhanden, inkompatibel oder im Projekt noch absichtlich abgeschaltet. |

Ein grüner Upstream-Status ist **keine Freischaltung**. Das Projekt aktiviert
WHIP, HLS/LL-HLS, WHEP, MoQ und Provideradapter erst nach den jeweiligen
Runtime-, Browser-, Security- und Betriebsprüfungen. Das verhindert unter
anderem, dass bloßer `WebTransport`-Support als MoQ-Interoperabilität oder ein
Protokollwechsel als Transcoding ausgegeben wird.

## Gepinnte Standards und Implementierungen

| Gegenstand | Gepinnter Stand | Einordnung im Produkt |
| --- | --- | --- |
| WHIP | RFC 9725, veröffentlicht März 2025 | stabiler Ingestvertrag; Implementierung folgt in TBP-011 |
| WHEP | `draft-ietf-wish-whep-04`, 2026-06-22, Ablauf 2026-12-24 | experimenteller optionaler Ausgabepfad |
| HLS | RFC 8216 plus aktuelles Apple-Authoring-Profil | interoperabler Fallback, noch nicht integriert |
| LL-HLS | Apple-Dokumentation, Abruf 2026-09-03 | geplanter Basispfad, noch ohne Origin-/Playergate |
| MOQT | `draft-ietf-moq-transport-20`, 2026-08-31, Ablauf 2027-03-04 | experimentell und versioniert |
| LOC | `draft-ietf-moq-loc-04`, 2026-07-20, Ablauf 2027-01-21 | experimentell |
| MoQ Secure Objects | `draft-ietf-moq-secure-objects-01`, 2026-07-06, Ablauf 2027-01-07 | nirgends als vorhandene Produkteigenschaft behauptet |
| SFrame | RFC 9605 | im interaktiven Raum vorhanden, nicht automatisch im Broadcast-Zweig |
| MediaMTX | `1.20.1`, Control API v3 | Kandidat für Self-hosted Gateway; noch nicht installiert oder runtime-geprüft |
| hls.js | `1.7.2` | vorgesehener Nicht-Safari-Player; noch keine Projektabhängigkeit |
| MediaMTX-Demoplayer | MediaMTX `1.20.1`, eingebettetes hls.js `1.7.0` | nur Diagnose-/Referenzplayer |
| Cloudflare Stream/MoQ | Cloudflare API v4, Service-Snapshot 2026-09-03 | getrennte, default-aus geschaltete Adapter |

Der zuvor diskutierte individuelle
`draft-jennings-moq-secure-objects-04` ist nicht mehr die Arbeitsbasis. Die
Matrix pinnt den aktuellen IETF-Working-Group-Entwurf
`draft-ietf-moq-secure-objects-01`.

## Browser und Geräte

In der folgenden Kurzform steht `U/P` für Upstream-/Produktstatus. `S`, `D`,
`E` und `N` bedeuten supported, degraded, experimental und unavailable.

| Browser/Plattform | Capture | Bildschirm | Systemton | Encoded Transform | WHIP | HLS / LL-HLS | WebTransport / MoQ | Ton-Autoplay |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Chromium 151 Linux | S/S | S/S | D/D | S/S | E/N | D/N · D/N | S/N · E/N | D/N |
| Edge Desktop | S/N | S/N | D/N | S/N | E/N | D/N · D/N | S/N · E/N | D/N |
| Firefox 153 Linux | S/S | S/S | N/N | S/S | E/N | D/N · D/N | S/N · Publisher N/N, Player E/N | D/N |
| Safari macOS | S/N | S/N | N/N | S/N | E/N | S/N · S/N | S/N ab 26.4 · Publisher N/N | D/N |
| Chrome Android | S/N | N/N | N/N | S/N | E/N | D/N · D/N | S/N · E/N | D/N |
| Firefox Android | S/N | N/N | N/N | S/N | E/N | D/N · D/N | S/N · Publisher N/N | D/N |
| Safari iOS/iPadOS | S/N | N/N | N/N | S/N | E/N | S/N · S/N | S/N ab 26.4 · Publisher N/N | D/N |

Wichtige Grenzen:

- Capture bleibt auf allen Plattformen eine sichtbare lokale Nutzeraktion.
  Ein Panel, Join, Remotesignal oder wiederhergestellter State darf es nicht
  auslösen.
- Desktop-Chromium kann abhängig von Betriebssystem und gewählter Oberfläche
  Tab-/Fenster-/Systemaudio anbieten. Das ist keine portable Vollsystemton-
  Garantie. Firefox und Safari besitzen in der geprüften Webmatrix keinen
  entsprechenden Screen-Audio-Pfad.
- Mobile Browser besitzen hier keinen portablen `getDisplayMedia`-Pfad. Sie
  können deshalb als Zuschauer und gegebenenfalls Kamera-/Mikrofonpublisher,
  aber nicht als allgemeiner Screen-Packager eingeplant werden.
- `RTCRtpScriptTransform` ist breiter verfügbar als die frühere Chrome-only-
  Annahme. Das vorhandene Projektgate belegt aber bislang nur Chromium 151 und
  Firefox 153 auf diesem Linux-System.
- WHIP ist ein Protokoll über `fetch` und `RTCPeerConnection`, keine magische
  native Browsermethode. Bis der eigene Client samt CORS, ICE, Bearer, PATCH,
  DELETE und Cleanup getestet ist, bleibt der Produktstatus `unavailable`.
- HLS ist in Safari nativ. Chromium, Edge und Firefox brauchen üblicherweise
  MSE plus hls.js. LL-HLS braucht zusätzlich korrektes Authoring und reale
  Latenz-/Rebuffering-Gates.
- WebTransport allein beweist weder den passenden MOQT-Draft noch LOC-, Codec-
  oder Gatewayinteroperabilität. MediaMTX dokumentiert für Browserpublishing
  `MediaStreamTrackProcessor` und damit Chrome als Basis; Playback wird separat
  bewertet.
- Audible Autoplay wird auf keiner Plattform vorausgesetzt. Der Zuschauerfluss
  braucht einen gut sichtbaren Play-/Ton-Button; muted autoplay ist nur ein
  optionaler Startzustand.

## Codecpfad

`Passthrough` heißt hier: MediaMTX kann kompatible bereits codierte Frames vom
WHIP-Eingang in eine HLS-Ausgabe routen beziehungsweise remuxen, ohne sie zu
decodieren und neu zu encodieren. `Transcoding` heißt ausdrücklich
Decode/Encode. MediaMTX bietet Letzteres nicht selbst.

| Codec | Browser-/MediaMTX-WHIP | WHIP→HLS ohne Transcode | Apple-/Safari-HLS | Erforderliche Baseline-Aktion |
| --- | --- | --- | --- | --- |
| Opus | supported / supported | supported | degraded | für breite Apple-Ausgabe nach AAC transcodieren |
| AAC | unavailable / unavailable | unavailable | supported | Zielcodec eines getrennten Audioencoders |
| VP8 | supported / supported | unavailable | unavailable | nach H.264 transcodieren |
| VP9 | degraded / supported | supported | unavailable im Apple-Zielprofil | für breite Geräteabdeckung nach H.264 |
| H.264 | supported / supported | degraded | supported | nur bei kompatiblem Profil, Level, GOP und Parameter-Sets durchreichen |
| AV1 | degraded / supported | supported | degraded | nur nach Runtime-Gate; H.264-Fallback behalten |

Für den ersten breit kompatiblen LL-HLS-Pfad ist damit **H.264 plus AAC** die
Zielkombination. Selbst H.264 kann nicht blind durchgereicht werden: Apple
fordert passende Profile/Level, Container und regelmäßige Keyframes. Opus,
VP8, VP9 oder AV1 am Browser-WHIP-Eingang können einen separaten nativen
Transcoder erzwingen. MediaMTX bleibt dabei Gateway/Remuxer; FFmpeg, GStreamer
oder ein späterer Native-Packager wäre eine eigene, isolierte Rolle.

Hardwarebeschleunigung wird für keinen Codec global versprochen. Browser müssen
`MediaCapabilities.encodingInfo()`/`decodingInfo()` und native Packager ihre
tatsächliche Encodertelemetrie prüfen. Gerät, OS, Treiber, Profil, Auflösung,
Framerate und gleichzeitige Sessions verändern das Ergebnis. Ebenso sind die
Lizenzhinweise in der JSON-Matrix Risikohinweise und keine Rechtsberatung; der
konkrete Encoderbuild und die Auslieferungsregion werden vor Produktion
separat geprüft.

## Adapterwahrheit

### MediaMTX 1.20.1

Belegt sind WHIP/WHEP, HLS/LL-HLS, SRT/RTMP sowie eine experimentelle
MoQ-Implementierung. Auth kann intern, über externes HTTP oder JWT erfolgen und
Aktionen/Pfade begrenzen. Recording ist verfügbar, aber standardmäßig aus.
Die Control API v3 bindet standardmäßig localhost und bleibt auch im Projekt
intern.

Nicht belegt und deshalb `false` sind ein eingebauter Transcoder, Live-WebVTT-
oder IMSC1-Ingest, SFrame-Passthrough als getestete Produkteigenschaft sowie
MoQ Secure Objects. Besonders wichtig: MediaMTX bevorzugt derzeit MOQT
draft-19; das ist nicht der gepinnte draft-20.

### Cloudflare Stream WebRTC

Der Betapfad nimmt WHIP an und gibt WHEP aus. Die offizielle Limitliste schließt
für diesen Eingang HLS/DASH, Recording, Simulcast und Viewermetriken aus. Er ist
daher **kein WHIP→LL-HLS-Adapter** und bleibt zusätzlich wegen älterer
dokumentierter WHIP-/WHEP-Draftstände default-aus.

### Cloudflare Stream Live

Der klassische Livepfad nimmt RTMPS/SRT an und liefert HLS, DASH und eine
LL-HLS-Beta mit Provider-Transcoding. Er ist vom WebRTC-Betapfad getrennt.
Das dokumentierte LL-HLS-Setup verlangt derzeit automatisches Recording und
kollidiert damit mit der Projektvorgabe `recording default off`. Dieser Adapter
kann also nicht ohne eigene bewusste Policyentscheidung als datensparsamer
Baselinepfad dienen.

### Cloudflare MoQ

Das Angebot ist Beta und dokumentiert MOQT draft-14/draft-16; draft-18 nur als
Testoption, nicht draft-20. Der Token ist Teil des URL-Pfads und kann in
Access-Logs erscheinen. Deshalb wären kurze, programm-/actiongebundene Tokens,
vollständige Log-Redaktion und ein Draft-Gate Pflicht. Secure Objects ist in
der geprüften Anbieterreferenz nicht belegt.

### Reservierter Native-Packager

`native-ffmpeg-packager` ist nur eine geplante Adapter-ID. Solange kein Binary,
reproduzierbarer Build, Codec-/Lizenzsatz, Ressourcenlimit und Runtime-Gate
existiert, bleiben **alle** maschinenlesbaren Capabilities `false`. Das
verhindert, dass eine Architekturzeichnung schon als vorhandene Funktion gilt.

## Aktivierungsfolgen

Aus der Matrix ergeben sich für die nächsten Tasks diese fail-closed Regeln:

1. TBP-005 definiert herstellerneutrale Domain-Contracts; Adapter-IDs verleihen
   keine Autorität.
2. TBP-011 implementiert RFC-9725-WHIP hinter einem expliziten Nutzerstart und
   einem kurzlebigen Grant. Ohne `201`, gültige `Location`, erlaubtes CORS,
   ICE-Erfolg und erfolgreichen DELETE-Cleanup bleibt der Publisher aus.
3. TBP-017 pinnt MediaMTX exakt auf `1.20.1`, hält Control API/Metriken intern
   und Recording aus. Transcoding wird nie als MediaMTX-Capability gemeldet.
4. TBP-020 führt einen separaten, ressourcenbegrenzten H.264/AAC-Transcoder ein,
   sofern reale Eingangscodecs Passthrough nicht erlauben.
5. TBP-021 integriert hls.js `1.7.2` und natives Safari-HLS als getrennte
   Playeradapter mit sichtbarer Nutzeraktivierung für Ton.
6. TBP-025 bis TBP-028 dürfen MoQ erst nach exakter Draft-, Browser-, Gateway-
   und Fallback-Aushandlung aktivieren. Jedes Mismatch fällt auf LL-HLS/HLS
   zurück, nicht auf einen unversionierten MoQ-Pfad.
7. TBP-038 ersetzt alle noch leeren Browser-/Provider-Versionen durch reale
   Geräte- und Service-Evidence. Erst dann darf ein `productStatus` von
   `unavailable` auf `experimental`, `degraded` oder `supported` wechseln.

## Primärquellen

- [RFC 9725 (WHIP)](https://www.rfc-editor.org/rfc/rfc9725.html)
- [WHEP draft-04](https://datatracker.ietf.org/doc/draft-ietf-wish-whep/)
- [MOQT draft-20](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/),
  [LOC draft-04](https://datatracker.ietf.org/doc/draft-ietf-moq-loc/) und
  [Secure Objects draft-01](https://datatracker.ietf.org/doc/draft-ietf-moq-secure-objects/)
- [Apple HLS Authoring Specification](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices/)
- [W3C Media Capabilities](https://www.w3.org/TR/media-capabilities/)
- [MediaMTX 1.20.1](https://github.com/bluenviron/mediamtx/releases/tag/v1.20.1),
  [WHIP](https://mediamtx.org/docs/publish/webrtc-clients),
  [HLS](https://mediamtx.org/docs/read/hls),
  [MoQ](https://mediamtx.org/docs/read/moq),
  [Auth](https://mediamtx.org/docs/features/authentication) und
  [Re-encoding-Grenze](https://mediamtx.org/docs/features/remuxing-reencoding-compression)
- [hls.js 1.7.2](https://github.com/video-dev/hls.js/releases/tag/v1.7.2)
- [Cloudflare Stream WebRTC](https://developers.cloudflare.com/stream/webrtc-beta/),
  [Stream Live](https://developers.cloudflare.com/stream/stream-live/start-stream-live/),
  [MoQ](https://developers.cloudflare.com/moq/) und
  [API v4](https://developers.cloudflare.com/api/resources/stream/)

Alle URLs und Abrufdaten stehen zusätzlich normalisiert in der JSON-Datei.
