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
Die reale Chromium-/Firefox-Dialogprüfung wurde um deaktivierte Quellen vor
Capture und Bearbeitung vorhandener Freigaben ergänzt. Der gemeinsame Lauf mit
PCM-Empfang, Chatantwort, bewegtem Bildschirm und drei Renewals sowie der
isolierte Gesamtcheck stehen für diese Änderung noch aus.

Dies ist eine Meet-seitige UI-Ergänzung. Sie aktiviert keinen produktiven
Hub-Trust und ersetzt nicht die separate Hub-/Worker-/TURN-/Langzeitabnahme.
