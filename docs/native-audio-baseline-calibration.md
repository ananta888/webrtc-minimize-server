# Referenzpegel der nativen Audiostrategie-Prüfung

Die digitale CI-Fixture erzeugt Mikrofon und Bildschirmton als Sinustöne mit
440 beziehungsweise 880 Hz und jeweils Gain 0,25. Eine Hann-gefensterte,
begrenzte Frequenzsuche misst beide Beiträge getrennt in beiden dekodierten
AAC-Kanälen; die DFT am exakten Nominalwert bleibt als Diagnose erhalten. Das ist keine
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
von 20 Sekunden blieben bei dieser Diagnose-Erweiterung unverändert. Der konkrete Fehler war dadurch noch
nicht behoben; neue reale CI-Evidence ist erforderlich.

## Getrennte Befunde aus dem gebündelten Check

Der isolierte Gesamtcheck auf `bcd68e1` endete mit zwei Fehlern bei
1594 bestandenen Node-/Browsertests und vier Skips. Neben der separat
korrigierten Machine-Admission-Test-Erwartung meldete der Strategietest nach
„Sprache zuerst“ vier Nullamplituden bei fortlaufendem Video und einer neuen
MediaSource-Generation. Ein bestandener Einzelnachlauf (74,744 Sekunden)
beweist keine Behebung dieses Ausfalls.

Die Strategie- und Retained-Microphone-Fehler erfassen deshalb zusätzlich die
bereits vorhandene unabhängige FFmpeg-Dekodierung des neuesten privaten
HLS-Fragments und den passiven, ausschließlich im Testbinary vorhandenen
Source-State-Observer. Er liest mit `TryLock` und ruft keine Policy-,
Freshness- oder Capture-Funktionen auf. Audio-Decoder- und Mixer-Details werden
vom derzeit videoorientierten Observer noch nicht dargestellt; fehlende
Detailverfügbarkeit bedeutet nicht, dass ein Audiodecoder geschlossen ist.

Der native Statusverlauf hält die letzten 32 Übergänge statt der ersten 32
Meldungen fest. Identische aufeinanderfolgende Statusmeldungen erhalten einen
bei 1000 saturierenden Zähler. Alte Einträge bleiben unveränderlich. Die
Fehleraufnahme vor dem Cleanup ist von späteren Stop-/Restart-Meldungen des
Testabbaus zu unterscheiden. Es werden keine Quellenkennungen, Medienbytes,
Schlüssel oder freien Fehlertexte ausgegeben.

Ein zweiter, auf zwei parallele Tests begrenzter Nachlauf zeigt einen anderen
Fehler: Szenenwechsel und zwei Encoderersetzungen bestanden (69,978 Sekunden),
Audio scheiterte bereits an der Kalibrierung (59,774 Sekunden). Beide Quellen
hatten vier gültige Senderreports, offene Clocks und vorhandene Decoder;
die committed und producer HLS-Fragmente enthielten jeweils 48000 dekodierte
Stereosamples mit RMS ungefähr 0,2492 pro Kanal. Der Player spielte, ohne
Fehlercode. Das Messfenster erreichte jedoch nur 0,479 Sekunden, bei 27
Pegeldrift-Resets. Das belegt weder den Grund dieser Schwankungen noch den
Grund des separaten vollständigen Tonausfalls. Zeitlimits, Pegelgrenzen,
Quellenconsent und Runtime bleiben unverändert; beide Fehler bleiben offen.

## Reproduzierter Messfehler bei Sample-Rate-Anpassung

Der implementierte native Resampler erzeugt bei einem Program-/Input-Verhältnis
`r` eine entsprechend angepasste Wellenform: Der Sinuston liegt dann bei
`f / r`, nicht zwingend bei exakt `f`. Das bestehende Go-Wellenform-Gate
`TestSourceAudioResamplerConvertsSamplesAndKeepsProgramCursor` prüft genau diese
Ausgabe für `r = 0,95 / 1 / 1,02 / 1,05` bei unverändertem Pegel. Ein bloßer
DFT-Wert bei 440/880 Hz verwechselt Frequenzabweichung mit Pegelverlust.

Die neue Regression reproduzierte vor Korrektur ein falsches Strategieergebnis
für tatsächlich konstante 0,25-Amplituden. Sie prüft beide Kanäle, verschiedene
Pegel, Phasen, 44,1/48 kHz sowie vier nichttriviale Sample-Verhältnisse. Die
begrenzte Frequenzsuche findet dabei den tatsächlichen Peak innerhalb 0,2 Hz
und den Pegel innerhalb 0,001. Die zwei bestehenden echten Go-Tests für
Wellenform und wechselnde Clock bestanden in 0,809 Sekunden.

Die Probe verwendet deshalb jetzt Peak-Amplituden mit folgenden Grenzen:

- unverändert 2048 Samples, genau zwei Fixture-Töne und zwei Kanäle;
- Suche nur im festen Umfeld von ±10 Prozent, mit begrenzter Verfeinerung;
- akzeptierter Peak ausschließlich bei `f / 1,05 … f / 0,95`, plus 0,2 Hz
  numerischer Suchauflösung; erkannte stärkere Verschiebungen bleiben ungültig;
- unterhalb der bisherigen Stillegrenze 0,0002 muss keine physikalisch
  bedeutungslose Peak-Frequenz nachgewiesen werden;
- absolute Pegel-, Zwei-Prozent-Stabilitäts-, Strategie-, Ein-Sekunden- und
  20-Sekunden-Grenzen sowie alle Consentfristen bleiben unverändert.

Falsche Prioritäten, echte Unterpegel, fehlende Kanäle/Töne, Stille und
unzulässige Frequenzverschiebungen haben weiterhin Negativtests. Die alte
Nominal-DFT, ermittelte Frequenzen und Wiedergaberate bleiben ausschließlich
begrenzte numerische Diagnosen. Es werden keine PCM-Folgen oder Medien-URLs
gespeichert. Die Korrektur betrifft den Test, nicht den produktiven Mixer.

Damit ist ein eigenständiger Messfehler bewiesen, **nicht** die Ursache aller
historischen CI-Fehler. Vor Umstellung bestand ein echter Browser-Einzellauf
in 65,337 Sekunden. Im parallelen Lauf bestand die Szene mit zwei
Encoderwechseln in 41,802 Sekunden, Audio scheiterte dagegen nach 37,012
Sekunden erst beim Bildschirmton-Widerruf: Alle Strategien waren zuvor
bestätigt, beide nativen Quellen aber bereits gestoppt; auch unabhängig
dekodiertes HLS war tatsächlich still. Dieser Quellen-Lifecycle-Fehler bleibt
separat zu untersuchen.

Nach Umstellung bestanden die Szene (42,581 s) und Ausgewogen/Sprache zuerst
einschließlich Quellenwiderruf und Stop (48,316 s). Bildschirm zuerst/
Unverarbeitet scheiterte nach 29,615 s erneut an der Kalibrierung:
34 Pegeldrift-Resets, maximal 0,568 s stabiles Fenster, Wiedergaberate 1,
zuletzt Peakfrequenzen etwa 440,17/879,03 Hz und Amplituden 0,2481/0,2483.
Die beiden Quellen waren offen; unabhängiges HLS hatte RMS 0,24937 pro Kanal.
Die kleine Frequenzabweichung erklärt diesen verbleibenden Fehler also nicht.
Die gemeinsame Prüfung bleibt mit zwei Erfolgen und einem Fehler rot.
Auch der frühere echte Quellenstopp ist durch diesen Nachlauf nicht behoben.
Produktionsimage, gemeinsame CI und Langzeitabnahme bleiben zusätzliche Gates.
