# Video-Timing-Quarantäne während des Decoderstarts

Stand: 2026-09-10, TBP-030 bleibt offen.

## Reproduzierter Grenzfall

Der native Quellpfad wartet vor der Decoderreservierung auf gültiges Timing
und ein VP8-Schlüsselbild. Der Prozessstart erfolgt anschließend asynchron.
Währenddessen kann ein mäßiger RTCP-Messausreißer die bereits vorhandene,
vorübergehende Timing-Quarantäne aktivieren. Zwei gültige Folgeberichte können
diesen Zustand ohne neue Zeitbasis wieder aufheben.

Der bisherige Startabschluss behandelte jede fehlende Timing-Bereitschaft
als endgültigen Fehler. Ein kontrollierter Test blockiert den Decoderstart,
löst die Quarantäne aus und lässt den Start dann abschließen. Auf unverändertem
Produktcode scheitert er mit
`temporary clock quarantine during spawn permanently closed the source`.

Das reproduziert einen konkreten Lifecycle-Fehler, **nicht** die Ursache der
intermittierenden CI-Szenenfehler oder des früher gemeldeten Kamera-Freezes.
Die CI zeigte zuletzt bereits im Producer Wartebild statt Quelle; ihre genaue
Clock-/Decoder-Fehlerphase ist weiterhin nicht nachgewiesen.

## Verhalten der Korrektur

Nur beim expliziten Video-Zustand `sourceVideoTimeSuspended` bleibt der bereits
reservierte Decoder nach dem Startabschluss erhalten. Sein Startbild wird
sofort gelöscht. Er erhält bis zur Wiederherstellung des Timings keine
codierten Frames, auch kein zwischenzeitlich eintreffendes Schlüsselbild.
Die Prüfung verwendet einen gemeinsamen Clock-/Timestamp-Snapshot unter dem
Clock-Mutex, nicht zwei getrennte Beobachtungen mit einer Race-Lücke.

Nach zwei gültigen Recovery-Berichten benötigt dieser Decoder ein neues
VP8-Schlüsselbild. Deltaframes werden weiterhin verworfen und lösen die
bestehende begrenzte Schlüsselbildanforderung aus. Während das Timing noch
unsicher ist, werden keine zusätzlichen Schlüsselbilder angefordert.

Es gibt keinen Prozessneustart, keine zusätzliche Decoderreservierung, keinen
zweiten Medienpuffer und kein Re-Anchoring. Der Replay-Fence bleibt erhalten.
Clock-Ablauf, dauerhafte Clock-Schließung, ungültige Zeitstempel, Budgetverlust
und Widerruf schließen weiterhin endgültig und geben nach Reaping die
Reservierung frei. Die bestehenden Fristen und Quarantänegrenzen bleiben
unverändert. Der aktive Mixer prüft unverändert seine Timing-/Epoch-Fences;
Audio und die SFrame-/Consent-Contracts werden nicht geändert.

## Verifikation

Reine Go-Tests verwenden einen kontrollierten Decoder-Sink und eine
thread-sichere synthetische Uhr. Sie prüfen vor allem Wipe des Startbildes,
fehlende Ausgabe während Quarantäne und nach nur einem Recovery-Bericht,
frisches Schlüsselbild vor Ausgabe, unveränderte Decoderzahl sowie die
terminalen Widerrufs-/Budget-/Clock-/Replay-/Timestamp-Grenzen. Die bestehenden
Clock-, Mixer-Quarantäne- und asynchronen Starttests werden mitgeprüft.

Die lokale Prüfung läuft mit Go 1.24.13 in einem eingeschränkten Container,
ohne FFmpeg, Browser oder Audioquelle. Nach dem initialen Dependency-Download
ist dessen Netzwerk abgeschaltet. Die tatsächliche Szenen-/Browserabnahme
und Race-Prüfung bleiben Aufgabe der vollständigen GitHub-CI. Ein bestandener
Unit-Test allein ist keine Produktions- oder Freeze-Freigabe.

Der gezielte Lauf `^TestSource(Lazy|PendingDecoder|VideoClock|Clock)` besteht
in 0,341 s, einschließlich der neuen Recovery- und sechs terminalen Fälle.
`go vet .` besteht ebenfalls. Die Go-Container mounten den Quellstand read-only;
nur der eigene temporäre Build-/Modulcache ist beschreibbar.
