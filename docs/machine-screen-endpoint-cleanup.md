# Agenteneigener Bildschirm: fehlerisolierter Stop

Der bestehende `window.anantaMachine.screen`-Port komponiert Bildschirm und
optionalen Bildschirmton über einen schmalen lokalen Adapter. `close()` versucht
beide Stopps unabhängig voneinander. Bei einem Fehler liefert er ausschließlich
`meet_screen_cleanup_failed`, keine internen Fehlerdetails. Auch `open()` beendet
zuerst beide alten Quellen; ein fehlgeschlagener Cleanup startet keine Ersatzquelle.
Die bestehende Source-Autorisierung, Generationen, Fristen und Wire-Form bleiben
erhalten. Statusabfragen und das Erzeugen des Adapters starten keine Aufnahme.

Der synthetische Bildschirmton versucht bei Cleanupfehlern weiterhin alle übrigen
Nodes zu stoppen, PCM-Puffer zu leeren, Tracks zu stoppen, die eigene Publikation
abzuhängen und den AudioContext zu schließen. Ein Fehler beim Erzeugen des
Audio-Destinationsknotens verliert den bereits erzeugten Kontext nicht mehr.
Ein fehlerhafter natürlicher Node-Abschluss beendet den eigenen Graphen;
Abort-Callbacks geben keine ungefangenen Cleanupfehler an den Browser weiter.
Ein vom Browser abgewiesenes `AudioContext.close()` ist dennoch kein bewiesener
erfolgreicher Ressourcenabbau. Der Adapter kann Browserfehler nicht ungeschehen
machen und startet keinen automatischen Ersatz.

Dies ändert weder menschlichen Capture noch Hub-Trust, Empfangsfreigaben oder
Session-Erneuerungsrechte. Avatar und synthetische Sprache sind keine Ziele des
Bildschirm-Endpoints. Die Ananta-Runtime bleibt außerhalb dieses Repositorys.

37 fokussierte Tests für Endpoint, Bildschirmquelle und Bildschirmton bestanden.
Darunter sind Fehler beider Stop-Ports, teilweise Graphfehler, PCM-Löschung,
fehlgeschlagene Allokation und spätes Resume nach Abort. Die gemeinsame
Browser-/Gesamtprüfung ergab anschließend 936 bestandene Frontendtests sowie
969 bestandene Nodeprüfungen, einen Fehler und zwei ausdrückliche Skips
(428,155 Sekunden für Node). Build, Typprüfung, Go und statische Gates bestanden;
die externen Infrastrukturprüfungen wurden nach dem Nodefehler nicht erreicht.

Der Fehler liegt im Firefox-Avatarvideotest nach dem Wechsel zur gehaltenen
Videoquelle (`avatar_not_moving`); seine Ursache bleibt ungeklärt. Die getrennten
kombinierten Dialogtests bestanden in Chromium und Firefox mit jeweils 16.000
PCM-Samples, Chat, bewegtem Screen, drei Renewals und Freigabeentzug unter aktivem
SFrame ohne Transformfehler. Auch der echte separate Bildschirmton-Test bestand.

Der Avatar-Test erhält nun eine feste, begrenzte Fehlerprojektion für Phase,
synthetische Testpixel und Quellenzustand. Der isolierte Nachlauf bestand; das
ist kein kausaler Fix und macht den Gesamtcheck nicht grün. Die ausführliche
Testhistorie einschließlich eines zunächst falsch kopierten Diagnosekandidaten
steht unter MDS-08 im aktiven Todo. Kein Produktionsrollout und kein neuer
Hub-Trust wurden vorgenommen; der Serving-Build blieb unverändert.
