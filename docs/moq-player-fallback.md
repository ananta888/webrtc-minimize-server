# Experimenteller MoQ-Player und HLS-Fallback

Stand: 2026-09-04. `BroadcastMoqPlayer` ist ein browserseitiger Orchestrator
hinter kleinen Playback-Ports. Er ist noch nicht mit der öffentlichen
Zuschauerroute verdrahtet und aktiviert keinen realen MoQ-Adapter.

## Auswahl

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
HLS-Ports wird der MoQ-Abort ausgelöst und die vorhandene Session vollständig
geschlossen. So existieren nicht gleichzeitig ein MoQ- und ein HLS-Download.
Nach Ablauf oder Verbrauch des Budgets wird ein sichtbarer Fehler gemeldet.

Fehlende Playback-Autorisierung fällt nicht auf HLS zurück: Beide Pfade bleiben
geschlossen. Der Fallback verwendet ausschließlich das bereits im Plan
gebundene Manifest und erzeugt keine neue Audience, keinen Grant und keinen
Token.

Abort und Stop schließen MoQ und HLS idempotent. Eine verspätet nach Timeout
zurückkehrende QUIC-Session wird sofort geschlossen.

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
HLS-Playerwerten vermischt.

Unit-Tests verwenden kompatible, inkompatible und als netzblockiert simulierte
Ports. Reale Nachweise in mindestens zwei Clientkontexten sowie mit blockiertem
UDP/QUIC fehlen, weil derzeit kein inventarisierter Gateway-/Provideradapter
den Projekt-Pin draft-20 erfüllt. Diese Gates bleiben Voraussetzung für eine
Runtime-Aktivierung.
