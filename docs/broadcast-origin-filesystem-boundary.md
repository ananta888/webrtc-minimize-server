# HLS-Origin: gepinnte Dateisystemgrenze

Der separate Go-HLS-Dateidienst wird als Linux-Container ausgeliefert. Er öffnet den konfigurierten Ausgabeordner einmal als Directory-Capability (`os.OpenRoot` unter Go 1.24) und hält einen Deskriptor dieses Verzeichnisses. Spätere Requests lösen den konfigurierten absoluten Pfad nicht erneut auf. Ein Umbenennen oder Ersetzen dieses Pfads lenkt die laufende Instanz daher nicht auf einen fremden Baum um. Der Start verweigert einen bereits als Symbolic Link vorliegenden Rootpfad.

Jeder Request öffnet Resource, gegebenenfalls Rendition und Datei komponentenweise relativ zum bereits geöffneten Elternverzeichnis. Linux `openat` verwendet `O_NOFOLLOW`, für Verzeichnisse zusätzlich `O_DIRECTORY`, sowie `O_CLOEXEC` und `O_NONBLOCK`. Das Linkverbot gilt beim tatsächlichen Öffnen, nicht nur bei einem vorangehenden `Lstat`. Es verhindert auch Links zu einem anderen Programm innerhalb desselben Ausgabeordners. Ein rein auf `os.SameFile` beruhender Zwischenschritt wurde verworfen: Ein Negativtest zeigte die Wiederverwendung einer freigegebenen Inode-Kennung. Ein solcher Vergleich ist keine dauerhaft eindeutige Dateiidentität.

Nach Öffnung muss der finale Deskriptor eine reguläre Datei von höchstens 24 MiB bezeichnen. FIFOs werden nicht als Medien akzeptiert; `O_NONBLOCK` verhindert ein unbegrenztes Warten auf einen Writer. Parent-Deskriptoren bleiben während des Systemaufrufs durch `SyscallConn.Control` lebendig. Pro Anfrage werden höchstens ein Resource-, ein Rendition- und ein Datei-Deskriptor angelegt und auf allen Rückwegen geschlossen. Der gepinnte Root wird beim Shutdown idempotent geschlossen.

Legitime atomare Publikation einer neuen regulären Datei bleibt erlaubt. Ein bereits geöffneter Request darf seinen bisherigen regulären Dateideskriptor zu Ende lesen; neue Requests öffnen den aktuellen zulässigen Dateinamen. Es gibt keine Prüfung der Medieninhalte und keine neue Zusage eines sofortigen Widerrufs laufender Response-Bodies.

## Unveränderte Sicherheitsgrenzen

Die exakten Resource-/Dateinamen, GET/HEAD-/Range-Unterstützung, Untertitel und privaten Cache-Header bleiben erhalten. Andere Plattformen als Linux erhalten keinen stillen unsicheren Fallback; dieser Dateidienst verweigert dort den Start. Das betrifft nicht die separat plattformübergreifend gebauten Edge-Agenten oder Packager.

Dies ist keine neue Authentisierung. Der Origin vertraut weiterhin auf sein isoliertes internes Docker-Netz und den vorgelagerten autorisierten Playback-Proxy; sein Bearer-Präfixcheck allein verifiziert keinen Grant. Er darf deshalb nicht direkt öffentlich oder als ungeschützter CDN-Origin betrieben werden. CDN-Origin-Authentisierung, Host-/Path-Allowlist, öffentliche Programmpolicy, Rotation, Purge und Shielding müssen zusätzlich angeschlossen werden.

Ein berechtigter Writer kann weiterhin reguläre Dateien im Ausgabeordner ersetzen. Die Dateisystemgrenze schützt nicht gegen absichtliches Überschreiben erlaubter Inhalte, Hardlinks, Mount-Austausch durch privilegierte Hostprozesse oder einen kompromittierten Host. Read-only-Mount im Origin, getrennte Schreibrechte des Packagers, fehlende Container-Capabilities und fehlender Zugriff auf fremde Secrets bleiben notwendig.

## Nachweise

Vor der Änderung reproduzierte ein deterministischer Handler-Test mit synthetischen Dateien den Zugriff auf einen fremden Baum nach Austausch des Rootpfads. Neue Tests prüfen Root- und Resource-Rename, Ersatz durch Links innerhalb und außerhalb des Roots, zulässige atomare Dateipublikation, FIFO-Ablehnung, Deskriptor-Cleanup, parallele Dateitauschversuche und echte HTTP-GET/HEAD-Range-Antworten. Diese Tests belegen keinen erfolgten Zugriff auf reale Medien in Produktion und ersetzen nicht die Produktions-/Browser-/CDN-Abnahme.
