# Trusted-Audio-Programmbus

## Grenze

Der Programmbus ist ein eigener Web-Audio-Pfad für den bewusst gestarteten
Broadcast-Zweig. Er fordert keine Capture-Berechtigung an. Eingänge stammen nur
aus bereits vorhandenen, geklonten und durch den aktuellen
`BroadcastConsentDecision` freigegebenen Quellen. Der interaktive Raum behält
seine Originaltracks und seine eigene Wiedergabe.

| Signal | Interaktiver Raum | Programmausgang | Program-Monitor |
|---|---:|---:|---:|
| eigener Mikrofon-Originaltrack | ja | nie direkt | nein |
| freigegebener Mikrofon-Klon | nein | ja | nur im Gesamtmix |
| freigegebener Bildschirmton-Klon | nein | ja | nur im Gesamtmix |
| Raumwiedergabe | ja | nein | nein |
| Talkback | bestehender Raumpfad | nein | nein |
| gemischter Programmausgang | nein | WHIP | standardmäßig aus |

Damit existiert kein Graph-Pfad von Lautsprecher-, Room- oder Talkback-Ausgabe
zurück in den Broadcast-Mix. Program-Monitoring ist `off`. Die Alternative
`headphones` wird nur durch eine konkrete lokale Auswahl übernommen und ist in
der UI ausdrücklich als Kopfhörerfunktion markiert; eine zuverlässige
Browsererkennung physischer Kopfhörer existiert nicht.

## Signalverarbeitung

Jeder Eingang besitzt einen eigenen Gain-, Meter- und Ducking-Zweig. Danach
folgen Summierung, ein Dynamics-Compressor als Peak-Limiter, ein Ausgangsmeter
und genau ein `MediaStreamAudioDestinationNode`. Das Sprachprofil reduziert
Bildschirmton bei erkanntem Mikrofonpegel. Mute und Gain verwenden kurze
`setTargetAtTime`-Rampen, um harte Pegelsprünge zu vermeiden.

Die Profile sind geschlossen und flüchtig:

| Profil | Priorität | Opus | AAC-Ziel | Kanäle | DTX | FEC |
|---|---|---:|---:|---:|---:|---:|
| Sprache | Sprache | 64 kbit/s | 96 kbit/s | 1 | anfordern | anfordern |
| Ausgewogen | gleichrangig | 96 kbit/s | 128 kbit/s | 2 | aus | anfordern |
| Musik | Bildschirmton | 160 kbit/s | 192 kbit/s | 2 | aus | aus |

`RTCRtpSender.setParameters()` begrenzt die Opus-Senderbitrate und setzt die
Priorität. Das WHIP-Offer bindet `maxaveragebitrate`, Stereo, DTX und Inband-FEC
an den Opus-Payload. Das sind angeforderte, vom Gegenüber auszuhandelnde
Parameter. AAC ist ausdrücklich ein Ziel für den späteren Gateway-/Native-
Transcode und keine behauptete Browser-WHIP-Ausgabe.

## Lifecycle und Backpressure

- Abbruch, Stop, Navigation, Sessionwechsel und Destroy schließen Timer,
  AudioNodes, Ausgangstrack und `AudioContext` idempotent.
- Das Ende des letzten Eingangs beendet den Ausgang; ein Gerätewechsel kann
  dadurch keinen alten Graph parallel behalten.
- Maximal vier eindeutige, aktive Eingänge sind zulässig.
- Der Compositor akzeptiert Consent und Forks nur bei exakt gleicher
  Source-Menge, aktuellem Program-Epoch und noch nicht abgelaufenem Consent.
- Mehr als ein Videotrack bleibt bis TBP-015 fail-closed.

## Verifikation

Unit-/Contract-Tests prüfen Graphtrennung, Standard-Monitoring, Ducking, Gain,
Mute, Limiterkonfiguration, Quellenende, Abort, Cleanup, Consent-Bindung,
Opus-SDP und Sendergrenzen. Ein echter Chromium-Lauf mit zwei Teilnehmern baut
den Produktions-Bundle, startet Mikrofon und Kamera ausschließlich per Klick,
erzeugt den realen AudioContext samt Program-Meter und räumt ihn wieder auf,
ohne einen weiteren Capture-Aufruf auszulösen.

Der physische Akustik-/Lippensynchronitätstest mit Kopfhörer und Lautsprecher,
gleichzeitigem Bildschirmton, Mikrofon und einem zweiten realen Gerät ist noch
nicht reproduzierbar durchgeführt. TBP-014 bleibt deshalb `partial`; technische
Track-Aktivität allein wird nicht als Echo- oder Qualitätsnachweis ausgegeben.
