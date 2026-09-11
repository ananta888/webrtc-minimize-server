# Experimenteller MoQ-Player und HLS-Fallback

Stand: 2026-09-11. `BroadcastMoqPlayer` ist ein browserseitiger Orchestrator
hinter kleinen Playback-Ports. Er ist noch nicht mit der öffentlichen
Zuschauerroute verdrahtet und aktiviert keinen realen MoQ-Adapter.

## Auswahl

`probeWebTransportAvailability()` prüft nur Secure Context und die Anwesenheit
des `WebTransport`-Konstruktors. Es wird keine Session geöffnet und kein QUIC-
Handshake gestartet. Bloße Constructor-Präsenz ist kein MoQ-Interoperabilitäts-
nachweis.

`auto` ist der sichere Standard. MoQ wird nur versucht, wenn der serverseitig
ausgehandelte Scope dieselben Tenant-, Program-, Epoch- und Audience-Werte
enthält, MOQT draft-20, LOC draft-04, WebTransport RFC 9297 und der Codec exakt
passen, Playback autorisiert ist, ein Secure Context vorliegt, WebTransport
vorhanden ist und der Browser den Codec positiv prüft. Erst eine erfolgreich
geöffnete Adapter-Session mit bestätigter QUIC-Verbindung setzt den Pfad auf
`playing-moq`.

`hls-only` ist eine sichtbare Diagnosewahl. `diagnose-moq` erlaubt später einen
bewussten Experimentalversuch, ändert aber keine Capability- oder
Autorisierungsregel. Ein Plan benötigt immer `trigger: user-action`; Öffnen
eines Panels startet keinen Download und keine Capture-API.

## Begrenzter Wechsel

Handshake-, Auth-, Codec-, Relay-, Netzwerk- und Stallfehler dürfen innerhalb
der ersten zehn Sekunden genau einmal zu LL-HLS/HLS wechseln. Vor Öffnen des
HLS-Ports wird der MoQ-Abort ausgelöst, ein noch offener Verbindungsversuch
abgewartet und die zurückgegebene Session geschlossen. Ein Timeout ist keine
Cleanup-Bestätigung: Wenn Open nicht endet oder Close fehlschlägt/hängt, bleibt
HLS geschlossen (`moq_cleanup_unconfirmed`). Der Orchestrator startet damit
keinen zweiten Download bei unbekanntem Zustand des ersten. Die konkrete
Transportimplementierung muss Abort/Close tatsächlich erfüllen; diese
Port-Tests beweisen keine Netzwerkfreigabe.

Codec-Prüfung und MoQ-Handshake haben jeweils höchstens fünf Sekunden.
Cleanup-Beobachtung hat höchstens eine Sekunde, beim Fallback zusätzlich
begrenzt durch das verbleibende Zehnsekundenbudget. HLS-Open besitzt fünf
Sekunden bei direkter Auswahl, beim MoQ-Fallback nur das verbleibende Budget.
Eine monotone Uhr schützt die Wartefristen auch bei verzögerter Timerzustellung;
die Gesamtfrist wird vor und nach MoQ-Cleanup erneut geprüft. Ein rückwärts
springender Epoch-Zeitwert erweitert sie nicht. Es gibt keine zusätzlichen
Transportversuche. Nach Budgetablauf wird MoQ trotzdem abgebrochen und die
Session geschlossen; HLS wird nicht geöffnet.

Fehlende Playback-Autorisierung fällt nicht auf HLS zurück: Beide Pfade bleiben
geschlossen. Der Fallback verwendet ausschließlich das bereits im Plan
gebundene Manifest und erzeugt keine neue Audience, keinen Grant und keinen
Token.

Abort und Stop setzen den lokalen Zustand sofort endgültig auf `closed` und
teilen denselben Cleanup-Auftrag. Sie warten höchstens eine Sekunde auf die
beiden Cleanup-Ports; `closed` beschreibt den beendeten Orchestrator, nicht
einen nachgewiesenen Socket-Abbau bei einem defekten Adapter. Eine verspätet
zurückkehrende QUIC-Session wird durch denselben Besitzer genau einmal
geschlossen. Ein nach Stop/Timeout verspätet erfülltes HLS-Open wird erneut
geschlossen, ohne Playback zu melden. Synchrone Portfehler und abgelehnte
Promises werden ohne Adapter-Rohfehler behandelt. UI-Beobachter dürfen die
Transportbereinigung nicht durch eigene Exceptions verhindern.

## Getrennte Telemetrie

Der lokale Snapshot enthält nur technische Summen:

- MoQ-Joinzeit und End-to-glass-Abstand,
- Rebuffer-Dauer,
- Objektverlust und verworfene Gruppen,
- Decode-Backpressure,
- empfangene Objektbytes und
- Anzahl der Fallbacks.

Die Werte enthalten keine URL, Program-ID, Caption, IP, Token oder
Medieninhalte. Nach einem Wechsel trägt der Snapshot `path: hls`; MoQ-Zähler
bleiben als Diagnose des vorherigen Versuchs erhalten und werden nicht mit
HLS-Playerwerten vermischt. Bereits bei Fallback-Beginn endet eine laufende
MoQ-Rebuffer-Messung; verspätete Events nach Abort/Fallback/Stop werden
ignoriert. Byte- und Verlustsummen saturieren am sicheren Integermaximum.

Die fünf ursprünglichen Lifecycle-Regressionen wurden zuerst am alten Code
reproduziert: HLS-Wiederbelebung nach Stop, veraltete MoQ-Metriken, fehlendes
Cleanup bei Budgetablauf, HLS trotz fehlgeschlagenem Close und konkurrierender
Stop. Ergänzende kontrollierte Promise-/Timer-Tests prüfen Pending-Handshake,
synchrones Fatal während Open, Timeout/Späterfolg, Codec-Prüfung, totalen
Fallback-Deadline, Close-Fehler, ungültige Sessions und verspätete HLS-Erfolge.
Final bestehen 36 gezielte Frontendtests und 16 Node-Contract-/Adaptertests.
Der gesamte Frontendlauf bestand mit 1.524 Tests, vor den letzten drei
zusätzlichen Regressionen (ebenfalls bestanden). Typprüfung und privater
Angular-Produktionsbuild bestehen; die bestehende Bundle-Warnung bleibt.
Die gemeinsame CI-/Runtime-Abnahme ist damit noch nicht abgeschlossen.

Unit-Tests verwenden kompatible, inkompatible und als netzblockiert simulierte
Ports. Reale Nachweise in mindestens zwei Clientkontexten sowie mit blockiertem
UDP/QUIC fehlen, weil derzeit kein inventarisierter Gateway-/Provideradapter
den Projekt-Pin draft-20 erfüllt. Diese Gates bleiben Voraussetzung für eine
Runtime-Aktivierung.
