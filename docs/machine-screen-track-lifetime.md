# Agenteneigene Bildschirmquelle: tatsächliches Track-Ende

Der getrennte Canvas-Adapter liefert ausschließlich die eigene synthetische
640×360-Ansicht. Er öffnet keine Kamera, kein Mikrofon, keinen Desktop und kein
menschliches Browserprofil. Autorisierung, fünf FPS, das 30-Sekunden-Limit und
die erneuerungsgebundene Source-Generation bleiben unverändert.

Eine offene Source-Generation allein beweist keinen lebenden Videotrack.
`MachineScreenSource` prüft daher jetzt die tatsächliche Oberfläche bei Start,
vor und nach jeder asynchronen Frame-Dekodierung sowie im vorhandenen
100-ms-Watchdog. Ein beendeter Track oder inaktiver Stream schließt die Quelle
mit der festen Diagnose `source_ended`. Die Prüfung vor dem Zeichnen verhindert
auch, dass ein spät dekodiertes Bitmap nach Track-Ende veröffentlicht wird.
Der Watchdog ist ein Prüfintervall, keine Echtzeitgarantie bei suspendierten
Browsern.

Die Bereinigung stoppt und entfernt nur die eigene Bildschirm-Publikation,
setzt den Canvas zurück und bleibt idempotent. Der zugehörige Bildschirmton
verliert über seine bestehende Bindung an die Screen-Generation die Autorität;
Avatar und synthetische Sprache werden nicht neu gestartet. Ein Neustart
benötigt einen erneuten expliziten Controller-Aufruf unter aktueller
Hub-/Meet-Autorisierung. Alte Generationen bleiben ungültig. Die tatsächlich
noch laufende native Bitmap-Dekodierung bleibt bis zur Auflösung belegt; siehe
[Decoder-Lebensdauer](machine-screen-decoder-lifetime.md).

## Verifikation

Drei neue Regressionen scheiterten vor der Korrektur: bereits beendete
Oberfläche, Track-Ende während einer offenen Quelle und Ende während eines
ausstehenden Decodes. Danach bestanden 29 gezielte Source-, Canvas- und
Bildschirmton-Tests sowie Angular-Typprüfung und Todo-Validierung.

Die gezielte Chromium-/Firefox-Gegenstellenprüfung bestand mit zwei Fällen in
8,008 Sekunden. Der Browsertest stoppt den echten Canvas-Track, nicht die Source-API oder die
Session. Er verlangt danach lokale Schließung, das Verschwinden des entfernten
Bildschirm-Tiles bei weiterhin bestehender Membership und erneut dekodierte
grüne Frames erst nach expliziter Aktivierung. Er kontrolliert außerdem
Bitmap-Bereinigung, Ablehnung alter Aktivierungen und null menschliche
Capture-/Transformfehler. Die Fixture ist privat und synthetisch; sie ist kein
Nachweis einer produktiven Hub-Freigabe oder eines allgemeinen Ananta-Browser-
Workers. Die gemeinsame Integrations- und Rollout-Abnahme bleibt separat.

## Abgrenzung der Meet-Implementierung (MDS-05)

Der abschließende isolierte `npm run check` bestand am 9. September 2026:
914 Frontendtests, 923 bestandene Node-Prüfungen, keine Fehler und zwei
ausdrückliche Node-Skips; Node-Laufzeit 426,219 Sekunden. Build, Typprüfung,
Go-Tests/Vet und statische Gates bestanden. Die 14 externen Infrastruktur-Gates
blieben mangels explizitem Opt-in übersprungen. MDS-05 ist für den unten
abgegrenzten Adapter abgeschlossen, nicht die gesamte Ananta-Anbindung.

Die vier Quellkriterien werden durch folgende vorhandene Bausteine abgedeckt:

- `MachineScreenSessionService` leitet die Source-ID ausschließlich aus der
  verifizierten Hub-Session ab. `createMachineScreenSurface` erzeugt nur den
  eigenen Canvas. Anantas `BrowserWorkspaceFrameSource` verwendet denselben
  Vertrag für den separat autorisierten `public-dom-v1`-Workspace.
- Bildschirmvideo und `MachineScreenAudioSessionService` sind getrennte
  Publikationen. Der Ton benötigt `screen-audio.publish` und eine laufende
  eigene Screen-Generation. `machine-media.browser.e2e.test.js` prüft den
  tatsächlichen getrennten Start/Stop neben den übrigen Quellen.
- Byte-, Decode-, Queue-, FPS- und Aktivierungsgrenzen liegen im Source-Port;
  Codec-Envelope, Schlüssel-ACK und Transportrechte bleiben im Peer-Mesh.
  Die Dialog-/Avatar-Browsertests prüfen dekodierten Screen, Audio und
  erforderliches SFrame mit drei echten Lease-Wechseln je Gegenstelle.
- Decoder-, Track-Ende-, Ablauf- und Coexistenztests prüfen das Verwerfen alter
  Frames, explizite frische Aktivierung und getrennte Medien-Lifecycles.
  Die öffentliche Textansicht ersetzt keine Freigabe beliebiger Browserquellen.

Nicht mit dieser Quellimplementierung abgeschlossen sind der vollständige
Hub-Reconnect (MDS-06), die breite Netzwerk-/Langzeitmatrix (MDS-08) und der
explizit vorautorisierte öffentliche Rollout (MDS-09). Die menschenbezogene
Capture-Regel sowie Hub-, Projekt- und Publisherfreigaben bleiben unverändert.
