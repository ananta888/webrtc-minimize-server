# Origin- und CDN-Delivery-Profile

## Gemessener Origin-LL-HLS-Umschlag

Der reproduzierbare opt-in Gate
`RUN_LIVE_MEDIAMTX_ORIGIN_LOAD=1 npm run test:load:mediamtx-origin` startet das
gepinntes MediaMTX-Profil, publiziert H.264/AAC und erzeugt pro Viewer eine
eigene LL-HLS-Session. Er hält zunächst einen Blocking-Reload pro Viewer
gleichzeitig offen und lädt danach Media-Playlists und die jeweils neuesten
Parts im 200-ms-Takt.

Messung vom 4. September 2026 auf der aktuellen Entwicklungs-Hostklasse:

| Merkmal | Wert |
|---|---:|
| Host | x86_64, AMD Ryzen 9 7940HS, 16 logische CPUs, 43 GiB RAM |
| Runtime | Docker 29.4.3, FFmpeg 6.1.1, MediaMTX 1.20.1 digest-pinned |
| Viewer / Dauer | 20 / 15 s |
| Gleichzeitig offene Blocking-Reloads | 20 |
| Requests | 2.762, entsprechend 184,13/s |
| ausgelieferte Daten | 163.020.341 Byte, entsprechend 86,94 Mbit/s |
| Request-Latenz p95 | 6,6 ms |
| MediaMTX-Prozess | 1,61 % CPU, 46,33 MiB RAM, 9 PIDs |
| Fehler / abgeschlossene Viewer | 0 / 20 |

Das daraus abgeleitete Profil `origin-llhls-x86-dev-v1` begrenzt eine einzelne
Origin-Instanz auf die tatsächlich geprüften 20 Viewer sowie harte
Schutzbudgets von 200 Requests/s, 100 Mbit/s Egress und 20 Blocking-Reloads
innerhalb des Containerlimits von einer CPU und 512 MiB.
Diese Grenze schützt vor ungemessener Hochrechnung; sie ist keine Messung des
Mini-PCs und kein End-to-glass-, Browser-, WAN- oder Langzeitnachweis.

## Standard-HLS/CDN-Profil

`cdn-standard-hls-v1` bleibt `runtimeVerified: false`. Es ist ausschließlich
für öffentliche Programme zulässig und wird erst wählbar, wenn CDN-Laufzeit,
Origin-Authentisierung, Host-/Path-Allowlist, Shielding, Purge und Health
gemeinsam bestätigt sind. Segmente erhalten einen program-epochgebundenen,
queryfreien Cache-Key und dürfen immutable sein; Manifeste werden höchstens
eine Sekunde gehalten und revalidiert. Private Delivery bleibt ungecacht im
autorisierten Cookie-Proxy.

Das Origin-Secret wird nur validiert, niemals in das zurückgegebene Policy-
Objekt kopiert. Ein Cache-Key bindet Host, opaque Resource und Program-Epoche;
Purge verwendet dieselbe Epoche. Ein Provider- oder Capability-Ausfall fällt
nur dann auf Origin zurück, wenn dessen gemessene 20-Viewer-Grenze genügt.
Andernfalls verweigert Admission mit sichtbarer geringerer Kapazität. Ein
Profilwechsel ist derzeit als bewusster kurzer Player-Neustart modelliert und
nicht als nahtlose Discontinuity behauptet.

## Offene Nachweise

Vor CDN-Aktivierung fehlen ein konkreter Provider, Credentials/Secret-Rotation,
Caddy-/Origin-Regeln und reale Purge-/Shield-/Fallback-Lasttests. Für Origin
fehlen Mini-PC-, WAN-, Browser- und 60-Minuten-Messungen sowie echte
End-to-glass-Latenz, Rebuffering und A/V-Sync. Diese Werte dürfen nicht aus der
kurzen Entwicklungs-Hostmessung extrapoliert werden.
