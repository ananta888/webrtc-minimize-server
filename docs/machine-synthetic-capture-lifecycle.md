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
