# PCM-Eigentum beim KI-Audioempfang

MDS-03 ergänzt das Leeren gerade eintreffender, noch nicht angenommener PCM-Puffer.
Am Ausgangsstand `ff2676c` reproduzierten neun neue Assertions den Fehler:
Widerruf/Leasewechsel vor dem Callback, Timeline-Lücke, volle Queue, verspätete
oder ungültige Graphnachrichten, abweisender Consumer und unterbrochenes Cleanup.
Neun andere Prüfungen bestanden bereits; der alte Lauf war insgesamt nicht grün.

Der Subscription-Port besitzt einen Puffer erst nach erfolgreicher aktueller
Bindungsprüfung und Aufnahme in seine begrenzte Queue. Nicht übernommene eigene
ArrayBuffers werden in `finally` geleert. Angenommene Samples bleiben bis zum
ACK, Stop oder Widerruf erhalten. Der Graph leert auch verworfene/verspätete
Nachrichten und kann durch einen werfenden Fehlerbeobachter nicht offen bleiben.
Schon übertragene, detachierte Puffer können nicht mehr lokal geleert werden;
dieser Zustand verhindert das Freigeben weiterer eigener Ressourcen nicht.

Stop sperrt zunächst weitere Lieferung. Jeder Aufräumschritt wird unabhängig
versucht: Worklet-Port, stilles Audioelement, Graph-Verbindungen, eigene Trackkopie
und AudioContext. Fehler eines Schritts unterbrechen die übrigen nicht. Auch ein
Fehler beim Anlegen des Wiedergabeelements gibt die bereits erzeugte Trackkopie
frei. Die Aufnahme des menschlichen Publishers wird niemals gestoppt.

Dies ist eine Hygiene- und Lifecycle-Garantie für erreichbare, eigene JS-Puffer,
keine garantierte forensische Löschung im Browser, Betriebssystem oder entfernten
Ananta-Endpunkt. Bereits exportierte Base64-Strings und zuvor berechtigt
verarbeitete Inhalte lassen sich dadurch nicht rückwirkend zurückrufen.
SFrame, Freigaben, Chunk-/Queuegrenzen und die vorhandenen Watchdogs ändern sich
nicht; es gibt keinen Klartext-Fallback und keine neue Aufnahmeberechtigung.

## Verifikation

150 gezielte Maschinen-Frontendprüfungen sowie Angular-Typ-/Template- und
Todo-Checks bestanden. Die reale Zweibrowser-Dialogprüfung hat zusätzlich eine
noch aktiv abholende Subscription widerrufen: fortlaufendes Poll/ACK verhindert,
dass ein Queueüberlauf als erfolgreicher Rechteentzug missverstanden wird.
Vor dem Klick war der Empfänger noch offen, danach war die Bindung geschlossen
und Poll/ACK wurden abgewiesen. Chromium/Firefox bestanden am isolierten Stand
`41b2b38` in 12,874 / 14,745 Sekunden einschließlich echtem Sampleempfang,
Chatantwort, bewegtem Bildschirm und drei Renewals. Required-SFrame war aktiv,
keine Transformfehler wurden beobachtet. Das Drei-Sekunden-End-to-End-Wartebudget
enthält Signalisierung und UI; die unveränderte lokale 100-ms-Prüfung wird
separat deterministisch getestet.

Der isolierte `npm run check` von `41b2b38` ist mit Exit 0 abgeschlossen:
698 Frontendtests und 763 Nodeprüfungen bestanden, null Fehler, zwei ausdrücklich
übersprungene Nodefälle; Node-Laufzeit 298,869 Sekunden. Build, Go-Unit/Vet und
statische Sicherheits-/Konfigurationsgates bestanden. 14 externe Infrastruktur-
Gates sowie der optionale Image-Scan bleiben sichtbar übersprungen. Der lokal
ausgelieferte Build wurde nicht ersetzt; das ist keine Produktionsabnahme.
