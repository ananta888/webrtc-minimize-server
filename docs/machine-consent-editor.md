# Ananta-Freigaben bearbeiten

Unter **Analyse → Ananta · Freigaben meiner Quellen** wird jede autorisierte
KI-Membership getrennt angezeigt. „Für diese KI einstellen“ übernimmt die noch
gültigen Freigaben für eigene, aktuell laufende Quellen und neue eigene
Chatbeiträge. Die Auswahl allein sendet nichts; erst der explizite Freigabeklick
ersetzt den bisherigen Umfang. Nicht laufende Mikrofon-/Bildschirmtonquellen
sind deaktiviert. Ein neu gestarteter Track übernimmt keine Freigabe einer alten
Publikations-ID. Das Panel startet weder Capture noch eine KI-Verarbeitung.

Eine Rückmeldung nennt den betroffenen technischen KI-Peer. Pending und
Bestätigung sind an den Raum und die eigene aktuelle Membership-Peer-ID gebunden.
Beim Raum-/Membershipwechsel, Disconnect oder Entfernen der KI wird eine alte
Anfrage nicht durch einen späteren Receipt bestätigt. Die Prüfung erfolgt vor
jedem Receipt/Request sowie alle 250 ms; nach dem Zerstören des Panels kann sein
Service nicht erneut senden. Die bestehende Fünf-Sekunden-ACK-Frist bleibt bestehen.

Eine erfolgreiche Serverbestätigung ist keine dauerhafte Laufzeitmeldung: Ablauf
wird sichtbar, eine geänderte/entzogene Freigabe entfernt die alte Bestätigung.
Es gibt weder automatische Verlängerung noch automatische Freigabe neuer Quellen.
Auch eine bestätigte Freigabe beweist keine Audioerkennung, Dialogantwort oder
flüssige Medienwiedergabe. Serverpolicy und SFrame-Schlüsselprüfung bleiben die
maßgebliche Empfangsgrenze, nicht diese Anzeige.

## Verifikation

Zehn gezielte Serviceprüfungen und der Angular-Template-/Typcheck sind bestanden:
Quell-ID-Wechsel, Ablauf, lokaler Klick, exakter Receipt, Raum-/Peerwechsel,
Disconnect, Zielverlust, ACK-Timeout und Destroy ohne automatische Verlängerung.
Die reale Chromium-/Firefox-Dialogprüfung am isolierten Stand `9f72368` ist
bestanden (12,41 / 15,21 Sekunden). Sie prüft deaktivierte Quellen vor Capture,
Bearbeitung vorhandener Freigaben, jeweils 16.000 entschlüsselte PCM-Samples
mit Nutzsignal, eine korrelierte Chatantwort, tatsächlich dekodierte bewegte
Bildschirmpixel, drei Renewals derselben Sitzung und anschließenden Rechteentzug.
Required-SFrame war aktiv; keine Transformfehler wurden beobachtet. Die
synthetisch vorautorisierte Fixture öffnet keine menschlichen Capture-Geräte.
Der isolierte Gesamtcheck von `9f72368` ist ebenfalls mit Exit 0 abgeschlossen:
683 Frontendtests, 763 erfolgreiche Nodeprüfungen, null Fehler und zwei explizite
Node-Skips; Node-Laufzeit 276,229 Sekunden. Build, Go-Unit/Vet und statische
Sicherheits-/Konfigurationsgates bestanden. Die 14 externen Infrastruktur-Gates
und der optionale Container-Image-Scan bleiben ausdrücklich übersprungen.
Der laufend ausgelieferte lokale Build blieb SHA-256-identisch.

Dies ist eine Meet-seitige UI-Ergänzung. Sie aktiviert keinen produktiven
Hub-Trust und ersetzt nicht die separate Hub-/Worker-/TURN-/Langzeitabnahme.

## Quellwechsel während der Auswahl

Die Editor-Auswahl ist zusätzlich an Raum, eigenen Membership-Peer, KI-Ziel und
die konkreten Publikations-IDs beim Öffnen gebunden. Vor dem Versand vergleicht
der Service die ausgewählten IDs mit dem aktuell erzeugten Freigabebefehl.
Ein gleich benanntes Ersatzmikrofon oder neuer Bildschirmton übernimmt dadurch
keine alte Auswahl. Bei einer Abweichung wird nichts gesendet; die Ansicht
fordert eine erneute Auswahl über „Für diese KI einstellen“. Nicht ausgewählte
Quellen beeinflussen die Freigabe nicht. Ein reiner Widerruf benötigt keinen
alten Snapshot und bleibt nach einem Quellenwechsel möglich.

Das ist eine zusätzliche lokale Schutzprüfung, keine neue Serverautorität.
Die Serverprüfung aktueller Membership, Publikation, Capability und Revision
sowie die Schlüsselverteilung bleiben unverändert maßgeblich.

Die Regression hat vor der Korrektur den Versand einer Ersatz-Mikrofon-ID
reproduziert. Danach bestanden 18 Serviceprüfungen und insgesamt 217 gezielte
Maschinen-Frontendtests. Die erweiterte Chromium-/Firefox-Dialogfixture ersetzt
die synthetische Mikrofonquelle über die sichtbare Mediensteuerung bei geöffnetem
Editor: Die alte Auswahl wird abgelehnt, erst eine neue bewusste Auswahl erlaubt
Audio. Anschließend werden jeweils 16.000 entschlüsselte Samples, eine korrelierte
Chatantwort, bewegte Bildschirmpixel, drei Renewals und laufender Rechteentzug geprüft.

Ein erster Gesamtcheck war wegen eines Fehlers im erweiterten Testablauf rot:
Beim erneuten Öffnen las Playwright noch den alten angehakten DOM-Zustand und
übersprang den Mikrofon-Klick. Die begrenzte Diagnose zeigte eine tatsächliche
Chat-only-Freigabe, nicht eine verlorene Audiofreigabe. Der Test wartet jetzt vor
der neuen Auswahl auf den vollständigen Checkbox-Reset; es gibt keine erneute
Fachaktion oder aufgeweichte Freigabeprüfung. Der gesamte Dialog bestand danach
in Chromium (14,055 s) und Firefox (16,802 s). Der abschließende Gesamtcheck wird
separat protokolliert; das ist keine produktive Hub-/Worker-/TURN-Abnahme.

Der abschließende isolierte `npm run check` auf Basis von `3e6d7d7` endete am
9. September 2026 mit Exit 0: 765 Frontendtests, 794 erfolgreiche Nodeprüfungen,
null Fehler und zwei explizite Node-Skips (Node 347,879 s). Build, Go-Unit/Vet und
statische Sicherheits-/Konfigurationsgates bestanden. Die 14 externen
Infrastruktur-Gates und der optionale Image-Scan wurden sichtbar übersprungen.
Der erweiterte Dialog bestand darin in Chromium (13,259 s) und Firefox (14,698 s).
Die uncommittete native v4-Control-Erweiterung war nicht Teil dieses Kandidaten;
der lokale Serving-Build blieb unverändert. Der frühere separat beobachtete
Audio-Worklet-Ladefehler wird dadurch nicht als ursächlich behoben behauptet.
