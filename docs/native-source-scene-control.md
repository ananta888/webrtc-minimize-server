# Native Szenensteuerung: Vertrag und nativer Control-Pfad

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

Der native Decoder und die bestehende authentisierte WebSocket-Leseschleife
nehmen nun `source-program-scene` und `source-program-scene-query` ausschließlich
bei eingeschaltetem lokalen Quellenprogramm-Pfad an. Der Adapter prüft den
wirklichen aktuellen v4-Programmbesitzer einschließlich Writer-Lease, Programm-
und Fencing-Revision. Er startet weder Quellen noch einen Ersatz-Encoder.

`source-program-scene-state` liefert die aktuell konfigurierte Szenenrevision,
das Layout, höchstens 20 konfigurierte Videoquellenplätze und höchstens 80 aktuell
verfügbare eigene Videoquellenleases mit Quellart. Ein widerrufener Platz bleibt
konfiguriert, rendert aber nur den bisherigen sicheren Platzhalter; die Quelle
erscheint nicht mehr als verfügbar. Die Zustandsabfrage ist keine Quellenfreigabe
und kein Nachweis dekodierter oder beim Publikum angekommener Frames.

Ein gültig gebundener, aber konkurrierender oder nicht ausführbarer Apply-Befehl
erhält `source-program-scene-rejected` mit ausschließlich `SCENE_NOT_APPLIED`.
Der laufende Encoder bleibt dabei erhalten. Nach Konflikt oder verlorener
Bestätigung muss der künftige Director den Zustand frisch abfragen; die Revision
darf nicht geraten werden. Falsche Authentisierung, Ownerbindung und abgelaufene
Befehle bleiben abgewiesen. Die Apply-Frist wird zusätzlich unmittelbar vor der
Szenenänderung unter der Render-Sperre geprüft.

**Noch offen:** explizite Feature-Aushandlung, der Node-Request-/Reply-Broker,
aktuelle menschliche Controllerberechtigung im HTTP-Pfad, Angular-Auswahl und
Bestätigung sowie die Prüfung des tatsächlich komponierten Browser-/HLS-Ausgangs.
Die Agent-Version und Capability-Ankündigung sind noch unverändert.
Die vorhandene `sourcePrograms`-Capability darf deshalb nicht als Unterstützung
dieser neuen Szenenbefehle interpretiert werden. Es wurde kein neuer Netzwerkport,
Capture-Pfad, Hub-Trust oder öffentliches Feature eingeschaltet.

## Gezielte Verifikation des nativen Abschnitts

Neun Node-/Schema-/Fixtureprüfungen bestanden in 302,5 ms. Der erste native
Nachlauf zeigte, dass ein widerrufener Input im Mixer bereits zu einem leeren
Platz wird. Die Abfrage führt deshalb die konfigurierte Auswahl unter derselben
Szenenrevision getrennt von den aktuell verfügbaren Quellen; sie rekonstruiert
keine Zustimmung aus einem früheren Quellenhandle.

Danach bestanden der Go-Racelauf für Scene-/Control-Tests (1,210 Sekunden) und
`go vet`. Die echte bestehende TLS-/P-256-/HLS-Fixture bestand alle sechs Fälle
in 10,336 Sekunden: Stop, Disconnect, Abbruch, doppelte Authentisierung sowie
abgeschalteter und nicht authentisierter Pfad. In den vier zugelassenen Fällen
laufen Query → Apply → CAS-Ablehnung → Query über den wirklichen nativen Socket;
die bestehende Prüfung von Renewal, HLS-Dateien und vollständigem Cleanup bleibt
erhalten. Ein eigener Test hält die Render-Sperre bis nach der Befehlsfrist und
prüft, dass die Szene unverändert und der Compositor offen bleibt.

Das ist noch kein Node-/HTTP-/Angular- oder komponierter Zuschauer-Nachweis.
Die nächste große Gesamtregression folgt gebündelt nach dieser verbleibenden
Verdrahtung. Der frühere fehlgeschlagene Gesamtcheck wird nicht als grün umgedeutet.
