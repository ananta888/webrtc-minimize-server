# Widerruf und erneute Freigabe von Broadcast-Untertiteln

Der eigene Browser-Packager überträgt ausschließlich ausdrücklich gewählte
Untertitelziele. Der vorhandene geordnete DataChannel `broadcast-captions-v1`
führt direkt zum autorisierten nativen Packager; die Node-Control-Plane und
Blind-Agenten erhalten weiterhin keinen Transcript-Text.

## Browser

Bei einer Änderung von TextTrack- oder Burn-in-Consent werden alte Cues und
Overlays entfernt und eine neue Caption-Discontinuity ausgegeben. Erst lokale
Ergebnisse mit einem Zeitstempel **nach** dieser Entscheidung dürfen wieder
publiziert werden. Verspätete Ergebnisse vor der Entscheidung bleiben gesperrt,
auch wenn ihre Utterance-ID bisher unbekannt war. Einstellungen ohne Änderung
des Broadcast-Ziels erteilen keine neue Freigabe.

Der Zeitstempel ist der vorhandene lokale Vosk-Ergebniszeitpunkt, nicht der
samplegenaue Beginn eines gesprochenen Satzes. Die Änderung beweist weder
Spracherkennungsgenauigkeit noch eine samplegenaue A/V-Synchronität. Ungültige oder
rückwärts laufende Entscheidungszeit beendet den Caption-Packager fail-closed,
nicht die Audio-/Video-Sendung.

Widerrufene Source-Epochen bleiben gesperrt. Die gleiche ID kann erst mit einer
höheren Epoche wieder autorisiert werden. Maximal 80 Quellen sind gleichzeitig
aktiv; höchstens 1024 unterschiedliche Source-IDs werden pro Caption-Programm
als Epoch-Metadaten behalten, ohne alte Sperren zu verdrängen. Am Limit werden
weitere neue IDs abgewiesen; höhere Epochen bekannter IDs und Widerrufe bleiben
möglich. Program-Ende löscht diese Metadaten. Dies ist kein globales Raumlimit.
Utterance-Replay-Metadaten bleiben beim Zielwechsel bis zum bisherigen begrenzten
Gültigkeitsablauf erhalten.

## Nativer Empfänger

`mediaSequence` steigt im vorhandenen Browser-Sender über Discontinuities hinweg.
Der native Empfänger bewahrt das höchste akzeptierte Update unabhängig von der
zuletzt gespeicherten Revoke-Nachricht. Gleiche oder ältere Updates werden auch
nach einem Widerruf abgewiesen; eine größere Discontinuity ersetzt diese Prüfung
nicht. Frische, höhere Updates in einer gültigen Generation bleiben möglich.
Die Konfiguration bleibt v1; Assignment, Program-Epoch, Writer-Fence, geordneter
Kanal sowie bestehende Größen- und Zahlenlimits bleiben unverändert.
Unbekannte, doppelte oder nullwertige Felder und ungültiges UTF-8 werden verworfen.

## Zuschauer

HTTP 401, 403 und 404 beim geschützten Caption-Abruf entfernen den vorhandenen
TextTrack samt Blob-URL. 429 und 5xx bleiben vorübergehende Abruffehler, keine
Autorisierungsbestätigung. Untertitelfehler allein stoppen keine Medienwiedergabe;
deren Autorisierung wird unabhängig geprüft. Die vorhandene zwei Sekunden lange
Abfrageperiode und das Fünf-Sekunden-Requestbudget bleiben bestehen; es wird keine
sofortige Löschung bereits beim Zuschauer wahrgenommener Inhalte behauptet.

Nachweise: gezielte Browser-Domain-/Service-/Player-Tests sowie echte atomare
Caption-Dateiausgabe unter Go-Race-Tests. Keine neue physische Vosk-Sprachenmatrix,
kein Langzeit-/Produktionsgate und kein Mehrquellen-/MediaMTX-Captionadapter in
diesem Teilabschnitt.
