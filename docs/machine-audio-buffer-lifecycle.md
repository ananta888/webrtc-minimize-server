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
Todo-Checks bestanden. Die reale Zweibrowser-Dialogprüfung wird zusätzlich eine
noch aktiv abholende Subscription widerrufen: fortlaufendes Poll/ACK verhindert,
dass ein Queueüberlauf als erfolgreicher Rechteentzug missverstanden wird.
Vor dem Klick muss der Empfänger noch offen sein, danach muss die Bindung
geschlossen sein und Poll/ACK müssen abgewiesen werden. Chromium/Firefox und
der isolierte Gesamtcheck stehen für diesen Änderungsstand noch aus.
