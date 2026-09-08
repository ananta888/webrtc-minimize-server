# Gemeinsamer Programmtakt und weitergereichte Quellenprüfung

Stand 2026-09-08, interner TBP-030-Baustein. Der native Programmtakt verbindet
die vorhandenen PCM-/RGBA-Mischstufen mit einem kleinen, nichtblockierenden
Ausgabeport. Der raw-Encoder-/Writer-Anschluss, produktiver Programm-Owner
und öffentliche Quellenannahme sind damit noch nicht fertig oder aktiviert.

## Gemeinsame Zeit

`sourceProgramClock` übernimmt zwei frische Mixer-Cursor und deren Close-
Lifecycle. Ein zweiter Programm-Owner kann dieselben Mischstufen nicht erneut
übernehmen. Bereits gerenderte oder anders gestartete Cursor werden nicht
umgedeutet. Nach erfolgreicher Übergabe darf der Aufrufer die Mixer nicht
weiter unabhängig takten.

Audio liefert fortlaufende Blöcke mit 960 Stereosamples bei 48 kHz, also
20 ms. Video unterstützt ganzzahlige 1–60 fps und erhält dieselbe 48-kHz-
Programmzeit. Die Videotermine werden aus dem absoluten Frameindex mit
Quotient/Rest berechnet, nicht durch wiederholtes Addieren eines gerundeten
Abstands. Dadurch entsteht keine aufsummierte Rundungsdrift; einzelne
Videotermine sind höchstens auf ein Sample quantisiert. Bei gleichen Terminen
wird Audio vor Video übergeben, ohne doppelte Termine pro Medium.

`Step` benutzt eine explizite monotone Clock und lässt sich deterministisch
prüfen. `Start` ergänzt eine einmalige lokale 2-ms-Ticker-Schleife, ohne
Capture oder Netzwerkzugriff. CPU-Scheduling und Renderdauer bleiben dabei
reale Grenzen: Die Abtastung verspricht keine garantierte Ausgabe-FPS.

Eine konfigurierte Verspätungsgrenze von 20–100 ms sowie höchstens 16 Handoffs
pro Step begrenzen das Nachholen. Zu große Verzögerung, Rücksprung der Zeit,
Zeitüberlauf, verlorene Writer-Policy oder Output-Backpressure beendet dieses
Programm. Es gibt kein stilles Umbasieren der Zeit und keinen unbegrenzten
Schub alter Medien. Mit leeren Quellen laufen Stille und Ersatzbild dagegen
auf ihren normalen Terminen weiter.

## Quellenprüfung über den Mixer hinaus

`RenderGuarded` ist ein additiver Port an beiden Mischstufen. Die bisherigen
`Render`-Callbacks bleiben verfügbar; deren alte Aufrufer erhalten dadurch
nicht automatisch eine nachgelagerte Queue-Absicherung.

Jeder Input besitzt eine eigene terminale `sourceRenderFence`. Ein Render-
Guard enthält höchstens 80 feste Referenzen auf möglicherweise beitragende
Quellen. Audio berücksichtigt konservativ alle aktiven Inputs, Video nur
tatsächlich eingefügte Bilder. Der Guard enthält keine Room-/Peer-ID, keinen
Token und keine Medienbytes. Er ist ein lokaler Handle, kein JSON-Contract
und keine vom Peer behauptete Berechtigung.

Die Fence prüft die unveränderliche aktuelle Source-Policy und ihr terminales
Close-Flag. Diese Prüfung braucht keinen Mixer-Lock; sie funktioniert auch
nach dem Handoff. Ein neuer Input kann einen alten Guard nicht wiederbeleben.
Ein leerer Guard steht für keine Source-Beiträge, niemals für Writer-Rechte.

Der Programmausgang prüft Writer-Policy vor jedem Handoff und Quellen erneut
vor Übergabe. Ungültige Beiträge werden durch Stille beziehungsweise ein
vollständiges Ersatzbild ersetzt. Die geliehenen Bytes werden nach dem
Callback wie bisher gelöscht. Der Ausgabeport darf sie nur in eigener,
begrenzter Speicherung behalten und muss den Guard bis zur letzten Prüfung
vor dem tatsächlichen Write mitführen. Keine Pipe-I/O darf unter Mixerlocks
stattfinden. Ein Guard allein löscht keine fremde Queue; deren Widerrufs-
Lifecycle ist Teil des noch zu verbindenden Encoder-/Writer-Adapters.

Programm-Close beendet die Mischstufen, wischt ihre Medien und schließt den
Ausgabeport idempotent. Das Clock-`done` meldet das Ende des Render-Lifecycles;
es ist kein Beweis für Reaping eines später angeschlossenen Encoderprozesses.

## Nachweise und Grenzen

Tests prüfen alle 60 FPS-Profile, rational berechnete Mehrjahrestermine,
Zeitüberlauf, gleiche Step-Zeit, Quoten, fehlende Konfiguration, einmaligen
Scheduling-Besitz, Writerverlust zwischen Handoffs, synchronen Source-Stop
und den echten Ticker bei untätigem Widerruf. Der stabile Step-Pfad wird auf
null zusätzliche Heapallokationen geprüft. Bestehende Mixer-/Full-HD-
Kompositortests behalten ihre bisherigen Assertions.

Eine neue opt-in Fixture verbindet zwei echte Opus- und zwei echte VP8-
Decoder mit beiden Mischstufen und dem Programmtakt. Bekannte synthetische
RTP-Offsets und eine kontrollierte Programmzeit ermöglichen exakte Ton-,
Bildwechsel-, Szenen- und Widerrufsprüfung. Das ist echte Decodierung, aber
kein neuer Netzwerk-/RTCP-/Encoder-Ende-zu-Ende- oder physischer Latenznachweis.

Der erste Lauf dieser Fixture schlug an der PCM-Erwartung fehl: Der Test las
den nach Eingabe verbrauchten Opus-`preSkip`. Die Erwartung wird nun aus dem
ursprünglichen Containerwert vor dem ersten Paket berechnet, wie im bereits
vorhandenen Audio-Mixertest. Weder Decoder noch Fristen wurden dafür geändert.
Konkrete Verifikationsstände stehen im Todo; Skips sind keine bestandenen
Produktionsgates.

Die korrigierte Vier-Decoder-Fixture bestand auch unter Race-Erkennung
(1,38 Sekunden), gemeinsam mit Timing-, Guard-, Mixer- und Kompositortests.
Der Gesamtcheck des mit dem Nutzer-Push zusammengeführten Stands steht noch
aus. Der Programm-Owner und der raw-Encoder-/Writer bleiben weitere Arbeit.
