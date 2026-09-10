# Referenzpegel der nativen Audiostrategie-Prüfung

Die digitale CI-Fixture erzeugt Mikrofon und Bildschirmton als Sinustöne mit
440 beziehungsweise 880 Hz und jeweils Gain 0,25. Eine Hann-gefensterte DFT
misst beide Beiträge getrennt in beiden dekodierten AAC-Kanälen. Das ist keine
Messung physischer Lautheit, Echofreiheit oder der Windows-Audioausgabe.

Im Lauf `34533667009` wurde für den Bildschirmton eine Referenz von ungefähr
0,155 übernommen. Die spätere Ausgewogen-Ausgabe lag bei 0,125, also nahe der
halben bekannten Quellamplitude, aber nicht nahe der halben übernommenen
Referenz. Die alte Referenzprüfung verlangte lediglich hörbare Werte über
0,02 für eine Sekunde und konnte damit auch eine noch ansteigende Ausgabe
übernehmen. Die Ursache dieses anfänglichen Unterpegels bleibt separat offen.

Vor der ersten Strategieauswahl muss die Referenz jetzt:

- in beiden Kanälen für beide Töne zwischen 0,225 und 0,275 liegen;
- mindestens eine Sekunde fortschreitender Medienzeit und Frames derselben
  Ausgabegeneration umfassen;
- gegenüber dem Fensterbeginn je Ton und Kanal höchstens zwei Prozent driften.

Ein Pegelausfall, größere Drift, Zähler-Rücklauf oder Generationswechsel
verwirft das laufende Messfenster. Der gesamte Versuch behält sein bisheriges
20-Sekunden-Limit. Danach gibt es einen Fehler mit der Phase `calibration`,
keinen Ersatzpegel und keinen automatischen Neustart. Späte Messantworten
können einen abgelaufenen Versuch nicht wieder erfolgreich machen.
Zählerrückläufe werden gegen die unmittelbar vorherige gültige Messung
geprüft, nicht nur gegen den Fensterbeginn. Zwei zusätzliche Regressionen
belegen Rückläufe, die noch oberhalb des Startwerts liegen.

Nach gültiger Referenzübernahme bleiben die bisherigen relativen
Strategietoleranzen unverändert: unprocessed 1/1, balanced 1/0,5,
speech-first 1/0,28 und screen-first 0,28/1. Consent-, Quellen- und
Programmlaufzeiten sowie der produktive Mixer wurden nicht geändert.

Vier neue Regressionen scheiterten vor der Korrektur an der zu frühen
Referenzübernahme. Deterministische Messfolgen prüfen den aufgezeichneten
Unterpegel, Rampen, Einbrüche, jede Kanal-/Tonkombination, Generationswechsel,
das exakte Zeitlimit und verspätete Antworten. Die DFT-Prüfung mit zwei
Sampleraten und mehreren Phasen bleibt erhalten. Diese Tests öffnen weder
Browser noch AudioContext oder FFmpeg; der erneute reale Mediennachweis
erfolgt ausschließlich in CI und ist bis dahin nicht erbracht.

Die gemeinsame browserfreie Prüfung mit Polling- und synthetischen
Capture-Lifecycle-Fixtures besteht mit 57 Tests in 2,813 Sekunden ohne Skip.
