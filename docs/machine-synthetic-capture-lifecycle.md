# Lebenszyklus des synthetischen Testmikrofons

Der private `machineBrowserFixture` verwendet einen separaten Init-Adapter
`test/helpers/machine-synthetic-capture.mjs`. Installation und das Öffnen der
Freigaben erzeugen keinen AudioContext. Erst die im Test über einen sichtbaren
Human-UI-Klick gestartete Mikrofonanforderung liefert den bisherigen 440-Hz-Ton.
Maschinen-, Bildschirm- und Kamera-Capture bleiben auf diesem Pfad verboten.
Es gibt keine Verbindung zur Lautsprecherdestination und keinen Host-Capture.

Der bisherige Adapter räumte nur bei einem `ended`-Event auf. Ein explizites
`MediaStreamTrack.stop()` löst dieses Event nicht aus; insbesondere der
Stop-/Neustart-Schritt im Dialogtest konnte deshalb einen alten AudioContext
weiterlaufen lassen. Jetzt besitzen expliziter Stop, Quellenende, `pagehide`
und Setup-/Resumefehler denselben idempotenten Cleanup: eigenen Track stoppen,
Oszillator stoppen, beide Nodes trennen und Context schließen. Ein verspätetes
Resume nach Seitenende darf keinen Stream mehr zurückgeben. Alte Stop- oder
Ended-Callbacks berühren keine neuere Quelle.

Neun browserfreie VM-Tests führen genau die serialisierte Init-Funktion mit
Fake-Tracks und Fake-Contexts aus. Sie bestehen in 0,055 Sekunden und prüfen
auch fehlende Speaker-Zugriffe, unveränderte Capture-Verbote, Teil-Setupfehler
und Cleanupfehler. Sie starten weder Browser noch Audio-Services. Die echte
Chromium-/Firefox-Abnahme erfolgt ausschließlich in CI, solange lokale
Medienprüfungen wegen der gemeldeten Windows-Firefox-Tonstörung pausieren.

Dieser belegte Ressourcenfehler beweist **nicht**, dass die Tests die
Windows-Tonausgabe oder einen historischen TURN-Fehler verursacht haben.
Produktions-Capture, Freigaben, Zeitlimits und Ananta-Repository bleiben
unverändert; MDS-08 ist damit nicht abgeschlossen.

## WAV-Sender für Ananta-Empfangstests

`startSyntheticAudioPublisher` installiert nun den ebenfalls eigenständig
serialisierbaren Adapter `test/helpers/machine-wav-capture.mjs`. Er ersetzt den
bisherigen Inline-Adapter für eine synthetische WAV-Datei als Mikrofon oder
Bildschirmton. Der sichtbare Startklick, die Datei-/Dauer-/Monogrenzen, das
320×180-Canvas mit einem Bild pro Sekunde und die höchstens drei ausdrücklich
ausgelösten Sprachabschnitte mit einer Sekunde Vorlauf bleiben erhalten.

Pro Installation ist höchstens ein aktiver oder noch startender Audiograph
erlaubt. Expliziter Stop eines zugehörigen Tracks, natürliches Trackende,
Seitenende und Teil-Setupfehler schließen denselben Graphen genau einmal:
alle eigenen Tracks stoppen, sämtliche noch vorhandenen BufferSources stoppen
und trennen, deren Buffer freigeben, Ausgang trennen, Canvas leeren und
AudioContext schließen. Das natürliche Ende eines einzelnen Sprachabschnitts
trennt nur dessen Player; es beendet nicht die laufende Publikation.
Ein alter Stop-/Ended-Callback darf den Speechcallback eines Nachfolgers nicht
löschen. Nach Stop oder Seitenende können verspätete Decode-/Resume-Ergebnisse
weder einen Stream zurückgeben noch einen Speechcallback installieren.

Die Regression führt genau die über `page.evaluate` installierte Funktion in
einer VM mit simulierten Web-Audio-/Canvas-/Track-Objekten aus. Gegen den alten
Adapter scheiterten zunächst fünf Stop-/Ended-/Pagehide-Prüfungen; der danach
unbegrenzt wartende Konkurrenztest wurde vom Node-Runner mit den restlichen
Tests abgebrochen. Diese Testwartebedingung ist inzwischen ebenfalls begrenzt:
die kontrollierte Decode-Barriere wird vor der Ablehnungsprüfung freigegeben.
Die korrigierten Lifecycle-, Eingangsvalidierungs- und bisherigen
Oszillatorprüfungen laufen gemeinsam ohne Browser, Audiogerät oder FFmpeg.
Eine echte WAV-Decodierung oder physische Audioqualität beweisen diese
Simulationen ausdrücklich nicht; die reale Ananta-Medienmatrix bleibt ein
separates CI-Gate.
