# Standby-Editor: sichere initiale Bedienbarkeit

Die Handoff-Prüfung scheiterte wiederholt beim ersten Laden des neu erstellten
Standby-Editors. Der Button war im DOM aktiviert, es folgte aber kein HTTP-Aufruf.
Eine begrenzte Beobachtung im privaten Browsertest bestätigte Fokus, Keydown,
echten Click und Keyup auf dem neuen, verbundenen Button.

Eine ausschließlich lokale instrumentierte Buildkopie zeigte anschließend:
Die neue Komponente las beim Eintritt in `load()` noch `disabled() === true`
und `busy() === false`. Ihr Guard verweigerte die Aktion korrekt, während der
native HTML-Button bereits bedienbar erschien. Es wurde keine fehlende
Authentisierung umgangen. Die Diagnosekopie war kein unverändertes
Produktionsbinary; ihre Service-/Komponenteninstrumentierung ist nicht Teil
der Änderung.

Der Button erhält nun zusätzlich zur bestehenden Angular-Propertybindung ein
statisches `disabled`-Attribut. Damit ist bereits der neu eingefügte DOM-Knoten
deaktiviert. Erst die reguläre Bindung gibt ihn unter den unveränderten
Voraussetzungen frei. Es gibt weder automatische Requests noch einen Retry,
Timeoutaufschub, simulierten Click oder eine Lockerung des Komponenten-Guards.

Die Regression beobachtet den tatsächlichen Zustand beim DOM-Einfügen, bevor
spätere Binding-Updates ihn verdecken. Vor der Korrektur erhielt sie `[false]`
statt `[true]` und scheiterte nach 15,792 s. Nach der Korrektur bestanden
48 Service-/Controllerprüfungen (0,971 s) sowie drei echte Browserfälle
(40,123 s): initialer und nach Handoff ersetzter Editor, Standby-CAS,
bestätigter Alt-Writer-Stopp, neue Epoche, fehlender Ton vor erneutem Consent
und Mono-AAC danach. Build und bisherige Sicherheitsgrenzen bleiben erhalten.

Auch die erweiterte Prüfung mit zwei zusätzlichen Editor-Neuerstellungen durch
Navigation bestand (38,623 s): vier initial deaktivierte DOM-Knoten, jeweils
derselbe aktuelle serverbestätigte Standby-Stand und keine weitere Capture-Aktion.
Der isolierte Build bestand in 13,756 s unter dem unveränderten Hardlimit;
die bekannte 1,50-MB-Warnschwelle bleibt überschritten. Kein erneuter großer
Gesamtcheck nach dieser kleinen Korrektur; die gemeinsame Abnahme bleibt offen.
CI `34471659288` auf dem vorherigen `12b6393` ist inzwischen mit beiden
Szenenfällen und dem alten Standby-Fehler gescheitert. Sie enthält diese
Korrektur nicht; die separate Ananta-TURN-Prüfung bestand.

Die Ergebnisse bleiben im TBP-030-Track festgehalten. Die getrennten nativen Szenenfehler,
weitere Broadcast-Ausbaukriterien sowie die öffentliche Hub-Aktivierung sind
dadurch nicht abgeschlossen. Kein Deployment oder Ananta-Repository-Write.
