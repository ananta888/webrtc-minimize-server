# Native Decoder-Zulassung

Stand 2026-09-08, interner Anschluss in TBP-030. Kein produktiver Source-Start:
Die Factory und der gemeinsame Programm-/Writer-Anschluss bleiben noch aus.

## Besitz und Grenzen

Audio- und Videodecoder benötigen jetzt zwingend einen expliziten
`sourceDecodeBudget`-Handle. Der spätere native Betreiber-/Client-Owner muss
diesen gemeinsam an seine Programme und Quellen weitergeben; ein neues Budget
je Quelle wäre keine Gesamtzulassung. Die Grenze ist ein Ressourcenbudget,
keine globale Anzahl erlaubter Räume und keine neue Medienberechtigung.

Ein Budget akzeptiert 1–80 gleichzeitige Decoderprozesse und 1 Byte bis 2 GiB
reservierte Medienkapazität. Jeder Decoder reserviert vor Prozessstart und
vor seiner Medienpufferanlage einen Prozessplatz und sein festes Profil:

- VP8: drei maximal 4 MiB große codierte Frames (zwei wartend, einer beim
  Schreiben) plus ein RGBA-Ausgabebild der konfigurierten Größe.
- Opus: konservativ 1 MiB für neun maximal 65.535 Byte große codierte Pakete,
  PCM-Ausgabescratch und begrenztes Ogg-Framing.

Fehlender Handle, ausgeschöpfte Prozess- oder Bytequote und terminaler Owner
lehnen die Konstruktion ab. Die Reservierung kann weder Quelle noch Codec
nachträglich vergrößern. Die bestehenden unabhängigen Decodergrenzen bleiben
zusätzlich wirksam. Die Mehrquellenfixtures teilen einen einzigen Handle für
beide Decoder; die kleineren Konfigurationsfixtures besitzen jeweils eigene
isolierte Testbudgets.

## Stop ist noch keine Rückgabe

`Close` widerruft Ausgabe, wischt wartende Medien und stoppt den eigenen
FFmpeg-Prozess. Seine Reservierung bleibt dabei belegt. Erst nach Ende aller
Decoderworker, Prozess-`Wait` und verbleibendem Cleanup gibt der jeweilige
Reaper sie genau einmal zurück; erst danach schließt `finished`.
Fehlgeschlagener Prozessstart gibt die Reservierung synchron zurück.

Ein geschlossener Budget-Owner nimmt keine neuen Decoder mehr an. Bereits
laufende Decoder prüfen ihn auf dem bisherigen Policy-Pfad vor Ausgabe und
mit ihrer 50-ms-Watch auch bei ausbleibenden Frames. Der Owner setzt laufende
Zähler nicht einfach auf null: Auch nach Widerruf bleiben Kinder bis zum
Reaping angerechnet. Der geschlossene Owner ist nicht wiederverwendbar.

## Was dies nicht begrenzt

Diese Buchhaltung ist kein Betriebssystem-RSS-Limit, CPU-Scheduler oder
Speicher-Sandbox für FFmpeg. Codec-interne Allokationen, Kernelpipes,
Transport-Assembly, Mixer-/Compositor- und Resampler-Puffer gehören nicht zu
diesem Zähler. Sie benötigen ihre eigenen Budgets beziehungsweise eine
betriebssystemseitige Prozessbegrenzung. Ein 32-MiB-FFmpeg-Einzelallokationslimit
ist weiterhin kein vollständiges Prozessspeicherlimit.

Der anwendende Client-Owner, Clock-gesteuerter Lazy-Start mit kontrollierter
Keyframe-Anforderung, Programmtakt und gefenceter Encoder-/Writer-Pfad werden
noch verbunden. Die neue Pflicht im Konstruktor verhindert einen vergessenen
Budget-Handle; sie beweist noch keinen vollständig implementierten
Produktions-Owner oder durchgehenden Broadcast-Lifecycle.

## Verifikation

Deterministische Tests prüfen Konfiguration, beide unabhängigen Quoten,
Überlaufversuche, parallele Reservierungen, doppelte Rückgabe, terminalen
Owner und wiederholt fehlschlagenden Prozessstart. Die echten Browser- und
Zwei-Decoder-Mixerfixtures verwenden ebenfalls die neue Pflichtzulassung.

Ein zusätzlicher FFmpeg-Test hält nach `Close` einen eigenen Worker-Barrier
offen: Der Prozessplatz muss trotz Stop belegt bleiben. Erst nach Freigabe,
`Wait` und `finished` kann ihn ein anderer Codec nutzen. Danach schließt der
Owner; ein untätiger Videodecoder muss samt Prozess enden und seine Zähler
freigeben. Reale Testergebnisse und der gemeinsame Gesamtcheck werden im Todo
festgehalten; opt-in Skips gelten nicht als Nachweis.

Der komplette Source-Browsertrack bestand mit neun Tests ohne Skips in
119,746 Sekunden. Die abschließende Quoten-/Parallel-/Startfehler-/FFmpeg-
Matrix bestand anschließend dreimal unter Race, ebenso Vet. Darin enthalten
sind die zusätzlichen echten Nil-/Minimal-/Terminalbudget-Startverweigerungen
und die gleichzeitige Rückgabe desselben Handles.

Der isolierte Gesamtcheck `npm run check` von `7584104` bestand: 665
Frontendtests, Build, statische/Security-Gates, Go Unit/Vet und 748 bestandene
Node-Tests, null Fehler, zwei explizite Node-Skips in 304,429 Sekunden für die
Node-Stufe. Der neue reale Zulassungstest lief dabei ebenfalls. Die gepaarten
SFrame-Quellen erreichten in Chromium/Firefox jeweils höchstens 30,8 ms
A/V-Abweichung. Vierzehn externe Infrastruktur-Gates und opt-in Langzeitläufe
wurden ausdrücklich übersprungen, nicht als produktiv verifiziert gewertet.
Der Serving-Build blieb unverändert; keine Source-Freischaltung oder Deployment.
