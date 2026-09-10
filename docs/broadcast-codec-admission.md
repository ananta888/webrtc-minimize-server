# Broadcast-Codec- und Capacity-Policy

## Pilotprofil

`h264-aac-720p-v1` ist das erste geschlossene, breit kompatible Zielprofil des
Native-Packagers. Alle Varianten verwenden H.264 Main, Level 3.1, `yuv420p`,
AAC-LC, 48 kHz und Stereo. Encoder-Keyframes und HLS-Segmente liegen gemeinsam
auf einem Zwei-Sekunden-Raster. Der native Pfad liefert kurzes fMP4-HLS ohne
LL-HLS-Parts; 200-ms-Parts gehören zum getrennten MediaMTX-LL-HLS-Profil.

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
Gesundheit, Stromversorgung, CPU-, Upload-, Pixel- und Encoderklasse. Zusätzlich
prüft `NativePackagerAssignmentRegistry` vor der Zulassung und erneut vor dem
Prepare-Commit ein gemeinsames Betreiberbudget für alle nativen Assignments
dieser Control-Plane-Instanz. Ein positiver Vorabcheck ist keine Reservation.
Die tatsächlich installierten Assignments sind die einzige Belegungsquelle.

Standby-Auswahl und Handoff verwenden eine getrennte, serverinterne
Ersatz-Vorprüfung: Sie rechnet den Nachfolger anstelle genau des bisherigen
Assignments desselben Owners, Tenants, Raums und Programms. Dabei werden das
gebundene Steuergerät, frische Capability/Quellfreigabe sowie die aktuelle oder
unmittelbar folgende Programmepoche geprüft. Andere Programme bleiben gezählt.
Die Vorprüfung reserviert nichts und stellt weder Lease noch Schlüssel aus.
Der reale Prepare-Commit prüft weiterhin die vollständige Belegung; ein
`draining`-Writer wird dort niemals ausgenommen. Der Handoff wartet zusätzlich
auf den echten Stop-ACK. Belegt inzwischen ein anderes Programm die freien
Ressourcen, wird die Übergabe sichtbar abgewiesen, ohne dieses Programm zu
verdrängen. So benötigt ein serieller Ersatz keine doppelte Budgetkapazität.

| ENV | Standard | Bedeutung |
| --- | ---: | --- |
| `BROADCAST_NATIVE_CPU_UNITS` | 512 | Geplante CPU-Kosten, eine Unit pro aufgerundeter Million Ausgabepixel/s |
| `BROADCAST_NATIVE_MEMORY_MIB` | 16384 | Planungsmodell: 128 MiB plus 96 MiB pro Rendition und Assignment |
| `BROADCAST_NATIVE_ENCODER_SLOTS` | 48 | Summe der ausgewählten Renditions |
| `BROADCAST_NATIVE_GPU_SLOTS` | 16 | Hardware-encodierte Renditions |
| `BROADCAST_NATIVE_EGRESS_BITS_PER_SECOND` | 100000000 | Summe der ausgewählten Video-/Audiobitraten plus 15 Prozent Reserve |

Jede Grenze akzeptiert 0 bis 1 Milliarde; explizit leere, negative oder ungültige
Werte verhindern den Start. Null sperrt den Bedarf an genau dieser Ressource;
GPU-Slots null verhindern beispielsweise keine Software-Ausgabe. CPU wird auch
bei Hardwareauswahl vollständig für den Software-Fallback eingeplant. Die
Nachfrage stammt aus der erneut serverseitig validierten konkreten Admission,
einschließlich der ausgewählten Audio- und Videoausgabeprofile.

Ein überschrittenes Betreiberbudget lehnt mit dem allgemeinen HTTP-Fehler
`broadcast_temporarily_unavailable` (429) ab, ohne einzelne Budgetwerte oder
private Belegung offenzulegen. Es findet dabei kein stiller Qualitätswechsel
statt. `draining` bleibt belegt, bis ein gültiger Stop-ACK oder der bestehende
Lease-Fehlerpfad greift. Ein `failed` ohne Stop-ACK bleibt konservativ bis zur
bisherigen Leasefrist belegt; ein Netzwerkfehler ist kein Nachweis sofortiger
physischer Ressourcenfreigabe. Die bereits vorhandene Agenten-Leasegrenze wird
nicht verlängert oder ersetzt.

Diese Grenzen sind instanzweite Planung, keine Messung des tatsächlich freien
Speichers, keine harte CPU-/Temperaturgrenze pro Host, keine clusterweite
Reservation und kein Budget für Zuschauer-Egress oder Providerrechnungen.
Die getrennte ältere `PackagerCapacityLedger` mit TTL und Best-Effort-Downshift
bleibt ein isoliert getesteter Baustein, nicht die produktive Assignmentgrenze.

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

Die neue Operatorgrenze ist mit echten Registry-Zuständen, zwei Packagern,
konkurrierenden Vorabzulassungen, Stop-ACK, Verbindungsverlust, Leasegrenze und
Software-Fallback-Bedarf geprüft. Ein echter Serverkonstruktor mit
`BROADCAST_NATIVE_ENCODER_SLOTS=0` weist wiederholte Starts vor der Aktivierung
ab; Draft und HTTP-Health bleiben unverändert. Dies sind browserfreie
Control-Plane-Prüfungen und kein physischer Encoder-Lasttest.

Sieben zusätzliche Ersatzprüfungen decken Legacy-, Source-, ausgewählte Audio-
und Video-Handoffs bei exakt einem Writerbudget, manipulierte Ersatzscopes,
keylose Standby-Auswahl und ein während des Wartens konkurrierendes Programm
ab. Zwei echte HTTP-/Socket-Tests prüfen Standby, Übergabe und HTTP-Abbruch
ebenfalls mit nur zwei Encoder-Slots. Der ACK stammt dabei vom expliziten
Test-Agenten, nicht von einem realen Medienprozess.

Der echte FFmpeg-Gate erzeugt alle drei H.264/AAC-fMP4-Varianten, prüft
unabhängige Segmente, End-of-stream und begrenzte Playlists. Unit-Tests decken
Codecwerte, Modustrennung, Downshift, Überbuchung, Idempotenz, Ablauf und
Epoch-Fencing ab. Noch offen bleiben VMAF/SSIM- und Screen-Text-Golden-Gates,
Lautheit/A/V-Sync, ein physischer GPU-/Treiberfehler sowie die Wiedergabe auf Safari/iOS,
Chromium, Firefox und Android. Bis dahin ist das Profil ein verifizierter
Packager-Pilot, keine plattformübergreifende Produktionsfreigabe.
