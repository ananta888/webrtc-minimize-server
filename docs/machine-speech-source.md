# Separater synthetischer Sprachausgang

`window.anantaMachine.speech` ist ein interner Port der isolierten `/machine`-
Seite. Er erzeugt weder Sprache noch Tasks und hat keinen HTTP-/Signaling-
Inhaltstransport. Der verifizierte aktuelle Maschinenkontext benötigt ausdrücklich
`speech.publish`. Menschliche Capture-APIs werden nicht aufgerufen.

`open("speech:" + hubSessionId, totalSamples)` reserviert ausschließlich die
Mikrofonpublikation und liefert `ananta.meet-speech-source.v1` mit Generation,
Format und Grenzen. Ein MP4-Ausgang reserviert Kamera und Mikrofon atomar;
konkurrierende Quellen scheitern, ohne einander abzuschalten. Der Bildschirmport
bleibt unabhängig. `close()` und Leave verwerfen nur die eigene Quelle.

`push(generation, startSample, pcmBase64)` akzeptiert ausschließlich fortlaufende
PCM16LE-Mono-Frames bei 22050 Hz: 441 Samples pro Frame, nur der letzte darf kürzer
sein. Maximal 40 Sekunden Gesamtinhalt und 4410 gepufferte Samples (200 ms) sind
erlaubt. Der Erzeuger muss anhand von `status().playedSamples` nachfüllen;
Überlauf, falsche Reihenfolge und Unterlauf nach Beginn beenden die Quelle.
Es gibt weder stilles Resampling noch Wiederholung oder unbegrenzte Queues.

Der eigene Track muss quittiert SFrame-geschützt sein, bevor `open` zurückkehrt.
Die Worklet startet nach höchstens 100 ms Vorpuffer und verwirft verbrauchte sowie
abgebrochene PCM-Bytes. Ihre relative Sample-Uhr ist von `AudioContext.currentTime`
getrennt: Beide können beim Start eines weiteren Contexts unterschiedliche
Fortschritte zeigen. Das absolute Session-/Quellen-Zeitlimit bleibt im
Source-Lifecycle verbindlich: maximal 10 Sekunden Setup, 50 Sekunden Gesamtzeit,
2 Sekunden ohne Fortschritt; Rechte-/Membership-/Lease-Wechsel stoppen über
einen 100-ms-Watchdog oder unmittelbar beim nächsten Portzugriff.

`playedSamples` zählt am lokalen Worklet-Ausgang verbrauchte Samples, **keine
Zustellbestätigung** des entfernten WebRTC-Decoders. Opus, Pufferung und der
abschließende Track-Stopp können den entfernten Anfang/Schluss beeinflussen.
Synthetische Zweibrowser-Tests prüfen tatsächlich decodiertes Audio sowie erneutes
Öffnen und Lease-Erneuerung. Sie beweisen weder TTS-Qualität, lückenlose entfernte
Sample-Zustellung, öffentliches TURN noch einen produktiven Hub/Piper-Dialog.

Verifikation: `npm run check`; gezielt
`node --test test/machine-speech-worklet.test.js test/machine-speech.browser.e2e.test.js`.
Optional nutzt `MEET_SPEECH_PRIVATE_BROWSER_GATE=1` die bestehende private
TLS-/STUN-Docker-Fixture; die Images müssen lokal vorhanden sein
(`MEET_TEST_PROXY_IMAGE` kann einen unveränderlichen Image-Digest benennen).

Struktur: Source-State, Sessionautorität, WebAudio-Graph, Worklet und lokale
Publikationsreservierung bleiben getrennt (SRP/ISP). Der bestehende große
`PeerMeshService` bleibt eine SRP-Schuld; die neue Methode ist nur eine kleine
Readiness-Projektion seines autoritativen Zustands, keine zweite Key-/Policy-
Verwaltung. Die Maschinenroute wird bedarfsgeladen, ohne Build-Budgets anzuheben.

Offen in MDS-10/Ananta MAP-22: Hub-eigener, leasegebundener PCM-Ergebnistransfer
aus echten Piper-Antworten sowie gemeinsame Sprach-/Bildschirm- und weitere
Abbruch-/Last-Akzeptanz. Der öffentliche Capability-Claim bleibt konservativ.

## Tatsächlicher Piper-Transport im privaten Test

`test/helpers/machine-speech-bridge.mjs` ist ausschließlich mit
`MEET_SPEECH_CROSS_GATE=1` aktiv. Er nutzt die vorhandene private TLS-/STUN-
Fixture, verifiziert signierte synthetische Hub-Zulassung und akzeptiert einen
geschlossenen lokalen stdio-Vertrag für open/status/push/close/probe. Keine
Aufträge, URLs, JavaScript-Ausdrücke, Schlüssel oder Grants werden vom Aufrufer
angenommen. Der Probe-Report enthält nur Decoderzählwerte, kein PCM.

Anantas `tests/test_meet_speech_cross_repository.py` hat am 2026-09-07 tatsächliche
Piper/CUDA-Ausgabe einer festen deutschen Testphrase über seinen Worker-Sink
hierher übertragen. Chromium und Firefox bestanden in zusammen 29.52 s;
79 beziehungsweise 75 nichtstille entfernte Messfenster, null Capture- und
Transformfehler. Das ist mehr als ein synthetischer Oszillatortest, bleibt aber
eine technische Probe mit Testzulassung: der produktive Hub-Dialogcallback,
Sprachqualität und exakte entfernte Sample-Zustellung werden nicht behauptet.
