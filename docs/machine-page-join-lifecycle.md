# Maschinenbeitritt und sichere Ablösung

Der Hub startet weiterhin jeden Beitritt ausdrücklich mit einem frischen Grant.
Die Maschinenpage führt weder automatische Reconnects noch eine eigene
Projekt-/Raumfreigabe ein. `RoomSessionService` besitzt unverändert Admission,
P-256-Nachweise, Signaling und erneuerbare Leases.

Der separate `MachinePageLifecycle` begrenzt das Warten auf Welcome nach der
Admission auf 20 Sekunden anhand der monotonen Uhr. Scheitert die eigene
Operation, beendet sie ihre Aufnahme und alle eigenen Endpunkte. Damit bleibt
nach einer an den Controller gemeldeten Ablehnung kein Signaling-Join offen,
der verspätet doch noch erfolgreich werden könnte.

Jeder explizite Leave und neue Beitritt invalidiert zuerst die vorherige
Page-Generation. Verspätete Auflösungen oder Fehler dürfen ausschließlich die
alte Operation ablehnen, niemals die neue Sitzung schließen. Nach Zerstörung
der Page kann auch eine gehaltene API-Referenz keinen neuen Beitritt starten.

Beim Stop werden zunächst Ablauftimer und Sessionautorität beendet, anschließend
Avatar, Sprache, Bildschirmton, Bildschirm, Audio-/Videoempfang, Chat und der
Legacy-Medienport getrennt bereinigt. Ein Fehler einer Bereinigung überspringt
keinen anderen Endpunkt. Angezeigt wird ausschließlich der feste Fehlercode
`machine_cleanup_failed`, kein Fehlertext mit möglicherweise privaten Inhalten.
Fehlgeschlagenes Cleanup wird nicht als erfolgreicher Ressourcenstopp behauptet.

## Gesperrter Client nach unbestätigtem Stop

Ein fehlgeschlagener Stop sperrt nun weitere Beitritte im selben Client dauerhaft.
Auch ein später fehlerfreier, aber möglicherweise leerer `close()`-Aufruf hebt
diese Sperre nicht auf: Ein bereits entferntes Handle beweist nicht, dass seine
Ressource beendet wurde. Ein frischer Grant ersetzt ebenfalls keine Stopbestätigung.
Der Hub muss den alten isolierten Browserkontext schließen und bei weiterhin
gültiger eigener Policy einen frischen Kontext verwenden. Das ist keine
automatische Wiederaufnahme oder Verlängerung bestehender Quellenfreigaben.

`RoomSessionService.leave()` liefert additiv einen booleschen Cleanup-Ausgang;
bestehende Aufrufer können ihn weiterhin ignorieren. Transport- und Meshfehler
bleiben im Sessiondienst vermerkt, einschließlich eines Meshfehlers beim
Socket-Disconnect. Neue Beitritte werden vor Gerätenachweis und HTTP verhindert
(auch für einen späteren menschlichen Join im selben beschädigten Client).
Die Maschinenpage wertet den Ausgang aus und sperrt zusätzlich nach Fehlern
ihrer einzelnen Quellen-/Empfangsports. Sie versucht trotzdem alle Stopps und
isoliert auch Fehler der Benachrichtigung. Die Statusansicht nennt den
unbestätigten Stop und den erforderlichen frischen Browserkontext; sie behauptet
keine erfolgreiche Ressourcenfreigabe und bietet keinen Sicherheits-Bypass.

Drei neue Regressionen reproduzierten zunächst unzulässige Folgebeitritte und
einen durchgereichten privaten Notifierfehler. Nach der Änderung bestehen die
erweiterten Lifecycle- und realen Sessiondienst-Tests. Dies ist ein gezielter
Fehlerpfadnachweis, keine kausale Behebung der separat untersuchten sporadischen
Avatar-/Sprach-Autoritätsfehler und keine öffentliche Hub-Freigabe.

Die fokussierten Tests decken Welcome-Timeout, tatsächliches Fencing eines
späten Welcome durch `RoomSessionService`, Admissionfehler, abgelöste erfolgreiche
und fehlerhafte Operationen, Leave während Konfigurationsladen, zerstörte Pages
und unabhängiges Cleanup ab. Sie verwenden synthetische Ports und beweisen keine
öffentliche Hub-Aktivierung oder automatische Wiederaufnahme. Die bestehenden
Chromium-/Firefox-Dialogfälle prüfen separat Audio, Chat, Screen, drei Renewals
und Rechteentzug.

Verifikation am 9. September 2026: 19 fokussierte Lifecycle-/Renewaltests
bestanden (1,230 s). Der anschließende isolierte `npm run check` bestand mit
922 Frontendtests und 946 Node-/Browserprüfungen, null Fehlern und zwei
Node-Skips (419,948 s Node-Laufzeit). Build, Typcheck, Go und statische Gates
bestanden; 14 externe Infrastruktur-Gates wurden ausdrücklich übersprungen.
Die Dialogfälle bestanden in Chromium (14,723 s) und Firefox (15,740 s), jeweils
mit 16.000 PCM-Samples und aktivem SFrame ohne Transformfehler. Der Prüfkandidat
enthielt auch den separaten v4-Broadcast-Serverpfad; Source und Tests waren
bytegleich zum lokalen Stand. Öffentliche Maschinenaufnahme und Serving-Build
wurden nicht verändert. Die gesamte Langzeit-/Produktionsabnahme bleibt offen.

Der neue Quarantäne-Nachtrag bestand 26 fokussierte Tests (1,170 s), einschließlich
der sieben neuen Fehlerpfadprüfungen. Sein isolierter Gesamtcheck bestand 1.085
Frontendtests sowie Build, Typcheck, Go und statische Gates. Die Node-Stufe endete
mit 986 bestanden, drei fehlgeschlagen und zwei übersprungen (446,888 s).
Die externen Infrastruktur-Gates wurden danach nicht erreicht. Audioempfang,
Chat, bewegter Bildschirm und drei Erneuerungen bestanden in Chromium
(14,014 s) und Firefox (16,246 s), jeweils 16.000 PCM-Samples und null
Transformfehler. Die drei Fehler betreffen separate Avatar-Coexistenz-,
Quellenzeit- und Zwei-Publisher-Personafälle; diese Abnahme bleibt offen.

Ein gezielter Nachlauf derselben Laufzeitdateien bestand sechs von sieben Fällen
in 45,952 s. Die Zeitüberwachung reproduzierte `controller-expired`, diesmal
schon 790 ms nach Beginn der privaten Beobachtung und vor dem ersten Testimpuls.
Die Ursache ist nicht bewiesen. Die vorhandenen geschlossenen Fehler-/Membership-
Beobachter erfassen jetzt auch Fehler außerhalb der Avatar-Bewegungsprüfung;
Fristen, Capture- und Autoritätsregeln bleiben unverändert. Der Nachlauf macht
den fehlgeschlagenen Gesamtcheck nicht nachträglich grün. Kein Deployment oder
Hub-Trustwechsel wurde aus diesen Ergebnissen abgeleitet.
