# Native Trusted-Program: Raw-Encoder und Ausgabegrenze

Dieser interne Baustein verbindet den begrenzten PCM/RGBA-Ausgang mit einem
eigenen FFmpeg-Prozess. Er interpretiert Raw-Frames nicht als IVF/Ogg und ändert
den bisherigen Clear-Program-Ingress nicht. Gemeinsam genutzt wird nur der
vorhandene H.264/AAC-Ausgabeprofil-Builder. Das ist segmentiertes fMP4-HLS,
**kein LL-HLS-Part-/Blocking-Reload-Nachweis**.

## Zuständigkeiten

- `source_program_encoder.go` besitzt genau eine Encoder-Generation, Prozess,
  Eingabepipes, Watchdog und Ausgabeownership.
- `source_encoder_fence.go` behält bis zum Ende dieser Generation alle
  beitragenden Quellengrenzen, auch nach dem Schreiben in FFmpeg. Höchstens
  80 unterschiedliche Quellengrenzen; eine volle oder widerrufene Generation
  kann nicht durch Vergessen alter Quellen weiterlaufen.
- `source_hls_stage.go` prüft ausschließlich die Dateien des festen lokalen
  Profils und veröffentlicht referenzierte Init-/Medienobjekte vor Playlists.
  Es ist weder ein allgemeiner Playlist-Parser noch ein externer HLS-Proxy.

Eine Quellen-/Writer-Sperre entwertet die gesamte Encoder-Generation. Der
Abbruch entfernt deren bereits veröffentlichte Dateien, beendet den Prozess
und wartet auf ihn und die Raw-Schreiber. Erst danach wird die Ausgabeownership
freigegeben. Ein erneuter Programmlauf mit gültigen Quellen beziehungsweise
Stille/Slate muss eine neue Generation erhalten; dieser Owner-Anschluss ist
noch separat umzusetzen. Bereits berechtigt an einen Zuschauer gelieferte
Bytes können nicht rückwirkend zurückgerufen werden.

## Grenzen

Die Eingaben sind PCM16LE, 48 kHz, Stereo in 20-ms-Blöcken sowie RGBA in der
festgelegten Programmauflösung und Framerate. Separate begrenzte Raw-Schreiber
vermeiden Datei-/Pipe-I/O unter Mixerlocks. Die Uhr und Quellenfreigabe werden
vom aufrufenden Programmowner geliefert, nicht vom Encoder erzeugt.

Der Prozess erhält keine Control-Plane-Credentials aus der Umgebung. Nur die
bereits für lokale Codecprozesse zugelassenen OS-/Loaderpfade werden übernommen;
Stdout/Stderr werden nicht als Inhaltslogs gespeichert. Raw-Puffer sind auf
höchstens 128 MiB begrenzt. Der private und öffentliche Dateibestand wird jeweils
gegen das konfigurierte Limit von höchstens 128 MiB geprüft, einzelne Dateien
gegen 24 MiB und Dateizahlen gegen 64. Diese Bestandsprüfungen alle 50 ms sind
**keine harten Betriebssystem-Disk-/RSS-Quoten**. Prozess-/Containerbudgets bleiben
ein gesonderter Admission-/Deploymentauftrag.

FFmpeg schreibt nur in die eigene `.pending`-Ablage. Öffentliche Kopien entstehen
über temporäre Dateien und Rename mit erneuter Writer-/Quellenprüfung. Nicht
erwartete Dateien, Symlinks, externe URIs, geänderte Init-/Medienobjekte und
unzuordenbare öffentliche Dateien werden abgewiesen. Der Origin muss zusätzlich
die bereits implementierte exakte Dateinamen-/Pfadprüfung besitzen; der reine
Verzeichnisname `.pending` ersetzt keine Zugriffskontrolle.

Eine bereits erlaubte Datei darf zwischen Auflistung und Bestandsprüfung durch
FFmpegs atomaren Rename oder das Löschen eines abgelaufenen Segments verschwinden.
Ausschließlich `ENOENT` wird dabei als nicht mehr vorhandener Bestand behandelt;
andere Dateifehler bleiben Fehler. In einer Playlist referenzierte, aber fehlende
Objekte verhindern weiterhin die Veröffentlichung. Die Kontrolle ersetzt keinen
atomaren Dateisystemsnapshot.

Alle Renditions erhalten eine explizite FPS-Auswahl. Das vermeidet den zuvor
real beobachteten falschen zeitlichen Farbverlauf bei verschieden schnellen
Ausgängen. Startup ist auf 15 Sekunden, ausbleibender Ausgabefortschritt auf
20 Sekunden begrenzt. Der bisherige Raw-Pipe-Timeout bleibt zwei Sekunden.

## Abnahme und verbleibender Anschluss

Die kurzen Tests verwenden echte synthetische PCM-/RGBA-Daten, decodieren beide
H.264/AAC-Renditions und prüfen Farbreihenfolge, Bildanzahl, 700-Hz-Ton sowie
Quellenwiderruf nach der Übergabe an den Encoder. Ein weiterer echter Lauf
prüft über 26 Sekunden rollierende Sieben-Segment-Fenster und Writerwiderruf.
Die finale fokussierte Race-Matrix bestand dreimal, ebenso `go vet`. Die drei
Decodierläufe dauerten 4,40 / 4,40 / 4,43 Sekunden; bei 5 FPS entstand exakt
`RRRBBRRRBB`, bei 10 FPS `RRRRRBBBBBRRRRRBBBBB`. Die drei 26-Sekunden-Läufe
beobachteten jeweils 23 Veröffentlichungszyklen, 21 öffentliche Dateien und
38.804 Bytes. Das ist synthetische Funktions-/Lifecycle-Evidenz, keine
Qualitäts-, Echtwelt-Bandbreiten- oder mehrstündige Lastgarantie.

Die Inventory-Rename-/Delete-Fälle scheiterten mit der ursprünglichen
Fehlerbehandlung reproduzierbar; die korrigierte Matrix prüft zugleich, dass
andere Dateifehler und fehlende referenzierte Objekte nicht toleriert werden.
Der gemeinsame Gesamtcheck mit den neuen echten Node-Gates steht noch aus.

Danach bleiben der produktive Publisher-Clock-/Decoder-/Mixer-Owner,
Generationswechsel mit definierter Discontinuity, Gesamtprozesszulassung und
der öffentliche Approve-/Renew-Pfad samt durchgängiger Mehrpublisherabnahme
verbindlich. Die Produktionsfactory bleibt aus; diese Dateien aktivieren
weder neue Capabilities noch Hub-Trust oder eine Broadcast-Publikation.
