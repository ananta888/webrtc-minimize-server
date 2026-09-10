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

## Noch ungeklärtes Kalibrierungsfenster

Im CI-Lauf `34536336514` bestand die Folge Ausgewogen/Sprache zuerst bis zum
Stop. Die Folge Bildschirm zuerst/Unverarbeitet scheiterte dagegen bereits
bei der Kalibrierung: Der letzte Sample enthielt ungefähr 0,2464/0,2483,
aber keinen Nachweis einer vollständigen stabilen Sekunde. Aus diesem einzelnen
Sample lassen sich weder die Ursache noch zu enge Toleranzen ableiten.

Die Fehlerdiagnose enthält deshalb jetzt `windowEvidence`: acht feste,
bei 1000 saturierende Grundzähler und die letzten acht projizierten Samples.
Sie trennt nicht spielende Ausgabe, verfehlten Zielpegel, Generationswechsel,
Zeit-/Frame-Rücksprünge und Pegeldrift. Dazu kommen die längste beobachtete
gültige Fensterspanne und der größte Framefortschritt; diese Maxima müssen
nicht aus demselben Fenster stammen. `deadline` unterscheidet ein abgelaufenes
Pollingbudget von `observation-failed`, ohne fremde Exceptiontexte auszugeben.

Auch der letzte Sample wird ausschließlich auf vier feste Tonamplituden,
numerische Zeit-/Frame-/Generations-/Readywerte und zwei Boolean-Zustände
projiziert. Keine PCM-Wertefolgen, URLs, Namen, Tokens oder unbekannten Felder
werden behalten. Ältere Snapshots bleiben unveränderlich. Die bestehende
Akzeptanzlogik, Zweiprozentgrenze, einsekündige Medienzeit und das Gesamtlimit
von 20 Sekunden bleiben unverändert. Der konkrete Fehler ist dadurch noch
nicht behoben; neue reale CI-Evidence ist erforderlich.
