# Aktiver Ananta-Dialog über Sitzungserneuerungen

Die Meet-Ports für Audioempfang, Chat und agenteneigenen Bildschirm sind vorhanden.
Der ergänzte Test `test/machine-active-renewal.browser.test.js` prüft ihren
gemeinsamen Lebenszyklus: Der bisherige Dialogtest beendete den Bildschirm vor
seinen drei Renewals und belegte deshalb diesen Übergang nicht.

## Vertrag für den Worker

1. Mit frischem Hub-Grant und gebundener Geräteidentität beitreten. Ein Beitritt
   erlaubt noch keinen Empfang menschlicher Quellen.
2. Die explizite Publisherfreigabe abwarten. Audio und neue Chatereignisse über
   ihre getrennten Ports öffnen; die eigene Bildschirmquelle separat starten.
3. Vor Lease-Ablauf einen frisch autorisierten Grant über `renew()` anwenden.
   Session-ID und Membership bleiben erhalten, die Lease-Generation steigt.
4. Alte Audio-, Chat- und Bildschirmaktivierungen sind an die alte Generation
   gebunden und enden. Alte Frames und Abfragen dürfen nicht weiterverwendet
   werden. Nach bestätigter Erneuerung öffnet der autorisierte Worker die
   benötigten Ports neu, mit neuen Sequenzen und Quellenaktivierungen.
5. Quellenfreigaben bleiben zeitlich begrenzt. Renewal verlängert sie nicht und
   macht einen Widerruf nicht rückgängig. Ein entzogenes Empfangsrecht sperrt
   nicht automatisch den separat erlaubten agenteneigenen Bildschirm.

Das ist kein nahtloser Medienwechsel: Beim generationsgebundenen Neuaufbau kann
eine kurze Unterbrechung entstehen. Wiederanlauf und Auftragspolitik bleiben
beim Hub/Worker, nicht bei einem selbstständig erneuernden Browser-Timer.

## Reproduzierbarer Test

Der private Test nutzt den echten TLS-/Signaling-Server, ephemere signierte
Hub-Grants, P-256-Gerätenachweise, isolierte Browseridentitäten und required-SFrame.
Der Maschinenclient läuft in Chromium, die menschliche Gegenstelle wahlweise
in Chromium oder Firefox; daraus folgt keine Firefox-Screen-Publisher-Freigabe.
Der menschliche Testpublisher startet per sichtbarem Klick einen synthetischen
Ton, niemals ein reales Mikrofon. Der Maschinenclient öffnet keine Capture-API.

Vier Dialogphasen liefern jeweils mindestens 16.000 entschlüsselte PCM-Samples,
eine korrelierte Chatantwort und tatsächlich dekodierte rote/grüne Bildschirm-
Pixel. Drei Renewals erfolgen bei gleichzeitig offenen Quellenports. Alte
Zugriffe müssen danach scheitern; die UI muss unveränderte Quellenfreigaben und
weiterhin genau einen KI-Teilnehmer zeigen. Nach Widerruf darf auch ein weiterer
frischer Grant weder Chatlesen noch Audioempfang wieder freigeben.

Erster Lauf: beide Fälle fehlgeschlagen wegen neuer Testnavigation. Chromium
füllte das ausgehende Live-Chatformular, bevor die Chatansicht gerendert war;
Firefox suchte den nur in Live vorhandenen Teilnehmerzähler in Analyse.
Der Test wartet nun auf die tatsächlich gewählte Ansicht. Keine Runtime-,
Berechtigungs- oder Timeoutgrenzen wurden dafür gelockert.

Der nachfolgende Kurzlauf bestand beide Fälle in 21,800 Sekunden: viermal
16.000 Samples pro Browsermatrix, drei aktive Renewals, neue Chatantworten,
dekodierte wechselnde Bildschirmfarben und anschließender Entzug. Dieser Lauf
verwendete den isolierten Build von `f67c9e5` mit den getrennten Broadcast-v4-
Parserkorrekturen; er ist kein unabhängiger Gesamtcheck dieses Arbeitsstands.
Der abschließende isolierte Gesamtcheck auf `f67c9e5` plus diesem Testnachtrag
bestand mit Exit 0: 1.192 Frontendtests, Produktionsbuild (18,322 Sekunden),
Typprüfung, Go-Unit/Vet und statische Gates sowie 1.096 bestandene Node-/Browser-
prüfungen, null Fehler und vier explizite Node-Skips (501,938 Sekunden).
Die neuen aktiven Dialogfälle bestanden dabei in 11,959 beziehungsweise
13,964 Sekunden, einschließlich noch nicht abgeschlossener Audioaufnahme und
aktivem SFrame in jeder Phase. 14 externe Infrastruktur-Gates, der optionale
Image-Scan und die Langzeit-Compositorprüfungen blieben ausdrücklich übersprungen.
Die offenen Broadcast-Arbeitskopieänderungen waren nicht Teil dieses Prüfstands.

Das ist Meet-seitige synthetische Integration, keine öffentliche Hub-/Worker-
Aktivierung, Modellqualitätsprüfung oder Zweistundenabnahme. Das Ananta-Repository,
produktiver Trust und der laufend ausgelieferte Browserbuild bleiben unverändert.
