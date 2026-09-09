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
