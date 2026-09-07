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

Der Hub-eigene, leasegebundene PCM-Ergebnistransfer aus echten Piper-Antworten
und die kurze kombinierte Sprach-/Bildschirm-Abnahme sind inzwischen integriert
(siehe unten). Weitere Abbruch-/Last-/Langzeit-Akzeptanz und Voice-Assets bleiben
in MDS-10/Ananta MAP-22 offen. Der öffentliche Capability-Claim bleibt konservativ.

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

## Raumgebundene Wiedergabe und echter Hub-Dialog

Die menschliche Raumseite hält genau einen `#room-audio`-Ausgang außerhalb der
wechselnden Live-/Chat-/Analyseansichten. Er nutzt die vorhandene
`MediaStreamDirective` und ausschließlich aktuelle entfernte Publikationen der
verbundenen Sitzung. Ein Ansichtswechsel ist kein Audio-Stop; Leave und das Ende
einer Publikation entfernen weiterhin die Wiedergabe. Es entsteht kein Capture,
neuer Trust oder zweiter Medienbesitzer. Der große bestehende RoomPage-Controller
bleibt eine SRP-Schuld; die Korrektur ergänzt dort keine Geschäftslogik.

Der tatsächliche Ananta-Hub/GPU/Meet-Test fand diesen Fehler: Opus-Pakete kamen
an, Frames wurden entschlüsselt, aber die bisher nur unter Live eingebundenen
Audioelemente fehlten im Chat. Nach der Korrektur bestand derselbe kurze Gate in
97.88 s: zwei echte Qwen/Piper/NVENC-Antworten, 84/89 nichtstille entfernte
Messfenster, getrennte Bildschirmsteuerung, erneuerte Freigabe, reine Textantwort
nach Hub-Sprachpause und Stop. Eine temporäre private Transformdiagnose wurde
vor diesem erfolgreichen Lauf entfernt; Produktion wurde nicht instrumentiert.

Die private Hub-Bridge bietet dafür ausschließlich feste Beobachtungskommandos:
neue Antwort unter exakter Input-/Room-/Epoch-Korrelation und gerenderter
Annahme als SHA-256, sowie begrenzte Audio-/Fehlerzählwerte. Keine Caller-Aufträge,
URLs, Grants oder JavaScript-Ausdrücke. Modell-Kaltstart wird getrennt gemessen.
Der Browsertest beginnt Sprache direkt im Chat und wechselt währenddessen durch
Live/Chat/Analyse, ohne das Audioelement zu ersetzen. Nichtstille Testausgabe ist
weiterhin kein Sprachqualitäts-, exakter Zustell-, TURN- oder Produktionsnachweis.

Abschlusscheck dieses Slices: `npm run check` grün mit 541 Frontendtests und
473 Node-Prüfungen (0 Fehler, 2 explizite Skips, Node 66.18 s), einschließlich
beider wirklicher Browser-Navigationsfälle. Externe Infrastruktur-Gates bleiben
sichtbar übersprungen; keine öffentliche Instanz wurde neu gestartet/deployt.

Die private Fixture behandelt `ERR_NETWORK_CHANGED` beim Bootstrap mit höchstens
zwei Navigationen unter einem gemeinsamen 30-s-Limit. Das umfasst fehlgeschlagene
Modulrequests, aber ausschließlich vor Raumerstellung/Join/Aufträgen. Zwischen
beiden Versuchen liegt einmalig ein 500-ms-Abstand innerhalb desselben Budgets,
damit beide Versuche nicht denselben Docker-Netzwerk-Ereignisschub treffen. Auth- und
Policyfehler, andere Netzfehler, Zeitüberschreitungen und Fachaktionen erhalten
keine Wiederholung. Elf deterministische Tests prüfen diese Grenze samt
Listener-Cleanup; die Fehlerbeobachtung enthält weiterhin nur begrenzte Codes.
Danach `npm run check` erneut grün: 541 Frontendtests, 484 Node-Prüfungen,
0 Fehler, 2 explizite Skips (Node 67.04 s); externe Live-Gates weiter übersprungen.
Nach dem Backoff-Nachtrag bestanden Anantas beide sequenziellen privaten
Text-/Sprach-Browserfälle in 72.03 s; vorherige fehlgeschlagene Startversuche
bleiben als solche in den Todo-Notizen erhalten.
Finaler Check mit Backoff: 541 Frontendtests und 485 Node-Prüfungen bestanden,
0 Fehler, 2 explizite Skips (Node 64.00 s); externe Live-Gates bleiben übersprungen.

## Unterbrechung während laufender Sprache

Der private Hub-Treiber kann seinen Beobachter unabhängig von GPU-Klassifikation
mit `MEET_DIALOG_OBSERVE=1` aktivieren. Das feste `audio_absent`-Kommando prüft
höchstens vier Sekunden auf das Ende der entfernten Testpublikation. Es löst
selbst weder einen Stop noch eine Freigabe oder Taskaktion aus.

Anantas zwei aktuelle private Browserfälle mit echtem Hub-CAS und ausdrücklich
synthetischem Ton bestanden in 91.31 s. Sprachpause: lokaler Stop 1.600 s,
Remote-Publikationsende 1.603 s; Parent-Cancel: 1.650/1.669 s. Bildschirm und
neue Textantwort blieben bei Sprachpause verfügbar. Nach Parent-Cancel verließ
die Maschine den Raum. Das ist keine GPU-/Voice-Qualitätsmessung und keine
Garantie physischer Lautsprecherstille; die produktiven Stop-Pfade blieben
unverändert und werden nicht durch Testeingriffe in Worker-State ersetzt.

MDS-10 ist damit nach seinen vier Port-/Lifecycle-/Transportkriterien abgeschlossen.
Letzter Gesamtcheck: 541 Frontendtests, 485 Node-Prüfungen, 0 Fehler, 2 explizite
Skips (Node 63.97 s). Neun andere Track-Tasks sowie Anantas breitere Persona-/
Stimmen-/Last-/Produktionsarbeit bleiben offen; der Track wird nicht archiviert.
