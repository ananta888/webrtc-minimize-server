# Native Szenensteuerung: Vertrags- und Adapterbasis

Diese Ergänzung unter TBP-030 ist noch **kein durchgängiger Bedienpfad**.
Der native Compositor besitzt bereits sieben Layouts. Ein geschlossener
`source-program-scene`-Befehl bindet deren Auswahl jetzt zusätzlich an Assignment,
Programm und Programmepoche, Writer-Lease und Fencing-Revision. Die erwartete
Szenenrevision verhindert konkurrierendes Überschreiben.

## Grenzen

- Höchstens 20 unterschiedliche aktuelle Video-Quellenleases; der bestehende
  Quellenbesitzer prüft weiterhin Consent, Lebensdauer und Widerruf.
- `single`, `screen-presenter`, `side-by-side`, `active-speaker`, `grid`,
  `waiting-slate`, `end-slate`; eine explizite aktive Quelle ist nur bei `single`
  und `active-speaker` zulässig. Das führt keine automatische Sprecherwahl ein.
- Maximal 16 KiB Rohbefehl, vier Sekunden Gültigkeit und eine Sekunde tolerierter
  Vorauszeit. Unbekannte Felder, doppelte JSON-Schlüssel, ungültiges UTF-8,
  falscher Scope und veraltete Revisionen werden nativ abgewiesen.
- Maximal 32 noch nicht abgelaufene Befehle im generationslokalen Verlauf.
  Gleiche Befehls-ID und gleicher Inhalt liefern den früheren Beleg; geänderter
  Inhalt ist ein Konflikt. Ein widerrufener Programmbesitzer darf auch keinen
  gespeicherten Beleg mehr abrufen.

`source-program-scene-applied` bestätigt eine **vergangene lokale Anwendung**,
nicht die aktuell sichtbare Szene, Zuschauerzustellung oder weitere Quellenrechte.
Ein zwischenzeitlicher Szenenwechsel kann den belegten Zustand bereits abgelöst
haben. Der Beleg verlängert weder Writer- noch Quellenleases.

Die Node-Normalisierer sind reine Vertragsprüfung, keine Controllerautorisierung.
Node und Go verwenden gemeinsame synthetische Befehls-/Belegfixtures. Native
Tests prüfen auch konkurrierende CAS-Aufrufe, begrenzten Verlauf und eine Quelle
aus dem wirklichen lokalen Quellenbesitzer.

## Noch zu verbinden

Explizite Capability-Aushandlung, authentisierter Control-Transport, aktuelle
menschliche Controllerberechtigung im HTTP-Pfad, Angular-Auswahl und Bestätigung
sowie die Prüfung des tatsächlich komponierten Browser-/HLS-Ausgangs fehlen noch.
Die vorhandene `sourcePrograms`-Capability darf deshalb nicht als Unterstützung
dieser neuen Szenenbefehle interpretiert werden. Es wurde kein neuer Netzwerkport,
Capture-Pfad, Hub-Trust oder öffentliches Feature eingeschaltet.
