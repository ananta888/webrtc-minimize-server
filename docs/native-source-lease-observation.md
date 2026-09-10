# Begrenzte Diagnose des nativen Source-Interop-Tests

Der gemeinsame Check auf `7137e85` endete im Chromium-Fall nach 200 tatsächlich
authentifizierten und dekodierten VP8-Frames. Transportfehler 5 bedeutet einen
nicht mehr gültigen Receiver; er beweist keinen Codecfehler. Der konkrete
Abbruchschritt war im Browser-Testbericht bisher nicht sichtbar.

Nur die synthetische Go-Testfixture und ihre Node-Auswertung wurden ergänzt.
Keine Änderung am nativen Produktivreceiver, Protokoll, Decrypt-Port oder
an Lease-, Consent- und Beobachtungsfristen:

- Feste Phase: Vorbereitung, Warten, Receiver-Ende, Deadline, Erneuerung,
  Control oder Medienprüfung.
- Anzahl erfolgreich angenommener Erneuerungen, maximal 32.
- Restzeit der **zuletzt angenommenen** Source-Lease zum Diagnosezeitpunkt,
  begrenzt auf −35.000 bis 5.000 ms; kein absoluter Zeitstempel.
- Boolesches Ergebnis der lokalen Parent-Policy zum Diagnosezeitpunkt.
- Bestehende begrenzte Framezähler, Transportcode und Teardown-Zustand.

Der Policy-Snapshot ist nicht zwangsläufig der zuerst auslösende Fehler.
Ein späterer Snapshot oder eine negative Restzeit beweisen insbesondere nicht,
dass die Lease schon bei der ersten Unterbrechung abgelaufen war. Der zuletzt
versuchte, aber abgelehnte Renewal ersetzt die angenommene Lease nicht.

Vorzeitig signalisiertes `Done` beendet den positiven Test als Fehler. Der
Test wartet dabei über seinen bestehenden begrenzten Cleanup-Helper auf den
Transportabschluss, bevor er dessen Zustand berichtet. Er repariert oder
erneuert den Empfänger nicht. Unbekannte Felder, Phasen, falsche Typen und
Zahlen außerhalb der Grenzen verwerfen die gesamte Diagnose. Rohfehler,
Identitäten, Keys und Medien werden nicht weitergereicht.

## Positiver und negativer Nachweis

Die positiven Chromium-/Firefox-Fälle verlangen weiterhin mindestens 401
authentifizierte Frames, bei vorhandenem FFmpeg mindestens 350 tatsächlich
dekodierte Frames, sichtbare Bildänderungen beziehungsweise PCM sowie
terminales Cleanup ohne Stoppen des geliehenen Browsertracks.

Zwei separate Negativfälle entziehen nach mindestens 20 authentifizierten
Frames die **synthetische** lokale Control-Anmeldung. Sie verlangen den
frühen Receiver-Abbruch mit falscher Parent-Policy und abgeschlossenem
Transport. Die Einstellung existiert ausschließlich in der Testfixture;
die positiven Fälle setzen sie ausdrücklich zurück.

Die erste kombinierte Negativprüfung bestand für Chromium, scheiterte aber
für Firefox an der Diagnoseerwartung. Der Bericht enthielt damals nicht die
einzelnen abweichenden Felder; seine genaue Ursache ist nicht bewiesen.
Nach getrennten Fällen, begrenztem Warten auf den tatsächlichen
Transportabschluss und geschlossener Fehlerausgabe bestanden beide
Negativfälle in 9,022 s: 23 beziehungsweise 30 dekodierte Frames,
`receiver-ended`, Parent-Policy falsch, Transport geschlossen. Beide
Parser-/Negativmatrizen bestanden ebenfalls.

Der abschließende gemeinsame Nachlauf besteht mit allen vier echten
Browserfällen ohne Skip in 61,574 s. Die beiden normalen Fälle erreichen
weiterhin ihre vollständigen VP8-/Opus-Nachweise; die getrennten Widerrufe
zeigen 26 beziehungsweise 38 dekodierte Frames und korrekt geschlossene
Empfänger. Die positive Prüfung wird nicht durch den erwarteten Fehler
eines Negativfalls ersetzt.

Dies ist bessere Fehlerlokalisierung, **kein Fix** für den ursprünglichen
intermittierenden Abbruch oder die separaten Audio-/Szenenfehler. TBP-030
und die gemeinsame Abnahme bleiben offen; kein Deployment dieses Testnachtrags.
