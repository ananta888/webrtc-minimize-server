# Broadcast-Codec- und Capacity-Policy

## Pilotprofil

`h264-aac-720p-v1` ist das erste geschlossene, breit kompatible Zielprofil des
Native-Packagers. Alle Varianten verwenden H.264 Main, Level 3.1, `yuv420p`,
AAC-LC, 48 kHz und Stereo. Encoder-Keyframes und HLS-Segmente liegen gemeinsam
auf einem Zwei-Sekunden-Raster; LL-HLS-Parts bleiben 200 ms lang.

| Variante | Bild | FPS | Video | Audio |
|---|---:|---:|---:|---:|
| `low` | 640×360 | 15 | 500 kbit/s | 64 kbit/s |
| `medium` | 960×540 | 24 | 1,1 Mbit/s | 96 kbit/s |
| `high` | 1280×720 | 30 | 2,4 Mbit/s | 128 kbit/s |

Die Leiter endet bewusst bei 720p. Höhere Profile werden erst ergänzt, wenn
Encoder-, Upload-, HLS-Player- und Textlesbarkeitsgates deren Mehrkosten
belegen. Die Werte sind Zielobergrenzen, keine garantierte visuelle Qualität.

## Getrennte Delivery-Modi

`evaluateBroadcastDelivery` hält vier Fälle auseinander:

- `browser-single-whip` ist genau ein Encoding und keine ABR-Leiter.
- `browser-simulcast-whip` darf nur nach echter Simulcast-Aushandlung benutzt
  werden. Mehrere Browser-RIDs werden nicht als einzeln wählbare HLS-Varianten
  ausgegeben.
- `gateway-passthrough` remuxt höchstens eine kompatible H.264/AAC-Variante.
  MediaMTX wird nicht als Transcoder behandelt.
- Nur `native-abr` mit mindestens zwei H.264/AAC-Ausgaben meldet eine echte,
  individuell auswählbare Rendition-Leiter.

VP8/Opus aus einem üblichen Browser-WHIP-Pfad benötigt für breit kompatibles
HLS weiterhin einen bewusst vertrauenswürdigen Transcoder. Aus einem
Single-Layer-Ingest entsteht nicht durch Konfiguration eine ABR-Leiter.

## Admission und Reservierung

Die kurzlebige Agent-Capability begrenzt zunächst die Leiter nach Raumconsent,
Gesundheit, Stromversorgung, CPU-, Upload-, Pixel- und Encoderklasse. Eine
zweite, operatorseitig konfigurierte `PackagerCapacityLedger`-Grenze reserviert
vor Prozessstart atomar:

- CPU-Einheiten,
- Arbeitsspeicher,
- Encoder- und gegebenenfalls GPU-Slots,
- erwarteten Ausgangs-Egress inklusive 15 Prozent Reserve.

Reicht das Budget nicht für die ganze Leiter, wird deterministisch `high`,
dann `medium` entfernt. Reicht selbst `low` nicht, wird mit
`packager_capacity_exhausted` abgelehnt; der interaktive Raum wird nicht als
Ausweichressource verwendet. Reservierungen sind höchstens fünf Minuten alt,
idempotent an ihre komplette Admission gebunden und nur mit passender
Program-ID/-Epoche freigebbar. Abgelaufene Reservierungen werden verworfen.

Hardwarebeschleunigung bleibt explizit opt-in. Der Go-Agent meldet NVENC oder
VideoToolbox nur nach einem begrenzten realen Test-Encode; eine kompilierte
FFmpeg-Encoderliste gilt nicht als Verfügbarkeit. `assignment-prepare.v2`
transportiert die konkrete Wahl und genau `libx264` als Software-Fallback.
Ältere Agenten erhalten v1 und werden unabhängig von ihrer Selbstmeldung auf
Software begrenzt. Ein Prozessfehler erzeugt höchstens einen Fallbackversuch und
die sichtbaren Zustände `HARDWARE_ENCODER_FALLBACK` sowie nach fertigen
Manifesten `SOFTWARE_FALLBACK_READY`. VAAPI bleibt bis zu einem getesteten
Geräte-/hwupload-Filterpfad ausgeschlossen. Der Fallback darf nicht
stillschweigend die bereits reservierten CPU-/Temperaturbudgets überschreiten.

## Verifikationsgrenze

Der echte FFmpeg-Gate erzeugt alle drei H.264/AAC-fMP4-Varianten, prüft
unabhängige Segmente, End-of-stream und begrenzte Playlists. Unit-Tests decken
Codecwerte, Modustrennung, Downshift, Überbuchung, Idempotenz, Ablauf und
Epoch-Fencing ab. Noch offen bleiben VMAF/SSIM- und Screen-Text-Golden-Gates,
Lautheit/A/V-Sync, ein physischer GPU-/Treiberfehler sowie die Wiedergabe auf Safari/iOS,
Chromium, Firefox und Android. Bis dahin ist das Profil ein verifizierter
Packager-Pilot, keine plattformübergreifende Produktionsfreigabe.
