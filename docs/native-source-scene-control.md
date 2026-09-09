# Native Szenensteuerung: Vertrag und nativer Control-Pfad

Diese Ergänzung unter TBP-030 verbindet jetzt Angular, den menschlichen
HTTP-Director, den Server-Broker und den nativen Control-Pfad. Die gemeinsame
Abnahme mit tatsächlich komponiertem Zuschauerbild steht noch aus.
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

## Nativer Control-Pfad

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
Bestätigung muss der Director den Zustand frisch abfragen; die Revision
darf nicht geraten werden. Falsche Authentisierung, Ownerbindung und abgelaufene
Befehle bleiben abgewiesen. Die Apply-Frist wird zusätzlich unmittelbar vor der
Szenenänderung unter der Render-Sperre geprüft.

Die neue Agent-Version `0.9.0` kennzeichnet die Szenenprotokoll-Generation.
Zusätzlich muss der authentisierte Capability-Bericht `capabilityVersion: 2`
und `sourcePrograms: true` enthalten. Alte oder Vorabversionen erhalten keine
unbekannten Szenenbefehle; ein Versionsstring ohne lokale Quellenprogramm-
Freigabe reicht nicht. Es gibt keinen neuen Netzwerkport oder Capture-Pfad.

## Menschlicher Director und Angular

`POST /api/broadcasts/:programId/native-source-scene` besitzt einen geschlossenen,
versionierten Query-/Apply-Vertrag. Aktuelle OIDC-Identität, konkrete Geräte-
Membership, Programmbesitz und Programmrevision, Writer-Lease, v4-Assignment,
Raumconsent und dieselbe authentisierte Verbindung werden vor Versand, während
der Wartezeit und vor Ausgabe erneut geprüft. Die Anfrage kann höchstens vier
Sekunden leben. Ein Packager hat höchstens eine offene Szenenoperation, der
Prozess höchstens 128; das ist ein Ressourcenbudget, keine globale Raumgrenze.
Abbruch, Disconnect, Shutdown, Uhr-Rücksprung und Autoritätsverlust räumen die
Operation auf. Späte gültige Antworten werden nicht als neue Aufträge behandelt.
Der HTTP-Director gibt weder interne Writer-Lease noch Command-ID aus.

Unter **Broadcast → Mehrquellen-Sendung → Sendeszene** lässt sich der tatsächliche
Zustand ausdrücklich abfragen. Danach können bis zu 20 angebotene Videoquellen
in Auswahlreihenfolge angeordnet, auch widerrufene Quellenplätze entfernt und
die sieben Layouts ausgewählt werden. Audio bleibt unabhängig. Die Quellen-
anzeige enthält Quellart und opaque Quellenreferenz, noch keine Publishernamen.
Ein lokaler Bestätigungsdialog prüft die unveränderte Auswahl nochmals.
Abfragen lösen keinen Capture, Consent oder Sendestart aus.

Ein Snapshot ist höchstens fünf Sekunden frisch. Nach Apply, Konflikt oder
verlorener Antwort muss neu abgefragt werden: keine geratene Revision und kein
automatischer Apply-Retry. Auch das Endbild ist kein Stop der Sendung; dafür
bleibt der getrennte sofortige Stop erhalten. Panelwechsel räumen nur die lokale
Szenenoperation auf, nicht die laufende Sendung.

**Noch offen:** gemeinsamer Angular/Node/native-Compositor/Zuschauer-Nachweis,
weitere Layout-/Handoff-/Standby-/Produktionskriterien des vollständigen TBP-030.
Diese Integration aktiviert keinen öffentlichen Trust und ist noch nicht deployed.

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

Die nachfolgende Director-Runde bestand 30 fokussierte Frontendtests, Typprüfung,
16 Szenen-Vertrags-/Brokerprüfungen und die zusätzliche Control-/Handoff-Matrix
(27 Tests in 1,934 Sekunden). Der tatsächliche HTTP-/P-256-WebSocket-Test bestand
in 0,334 Sekunden mit synthetischen nativen Szenenantworten. Die echte gebaute
Angular-Tastaturbedienung bestand in 4,773 Sekunden mit ausdrücklich simuliertem
HTTP: Query, Auswahl, abgebrochene und bestätigte Änderung, erneute Abfrage,
Quellenentfernung und Konflikt ohne Retry. Capture und zusätzliche Browser-
Medienverbindungen bleiben null. Beide Prüfungen ersetzen nicht den noch
ausstehenden gemeinsamen Compositor-/Zuschauer-Nachweis.

Der isolierte Produktionsbuild bestand in 13,511 Sekunden; das unveränderte
harte Bundlebudget bleibt eingehalten, die Warnschwelle wird weiterhin
überschritten. Die gemeinsame Gesamtregression folgt auf diesem Integrations-
Batch; frühere fehlgeschlagene Checks werden nicht rückwirkend grün.

Der erste Gesamtcheck von `7617084` bestand 1.151 Frontendtests, Typprüfung,
Build und statische Gates, scheiterte aber im Go-Vergleich der gemeinsamen
Capability-Fixture: Diese erwartete noch `0.8.0` statt der neuen nativen
`0.9.0`. Die gemeinsame Fixture wurde aktualisiert; der exakte Vergleich bleibt
unverändert. Acht Node-Capability-/Assignmentprüfungen bestehen danach.
Node-/Browser-Gesamtmatrix und Infrastruktur wurden im ersten Check nicht mehr
erreicht. Ein korrigierter Gesamtcheck ist ein neuer Nachweis, kein rückwirkender
Erfolg dieses Laufs.
