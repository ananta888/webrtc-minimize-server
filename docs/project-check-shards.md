# Vollständige CI-Prüfung in zwei Testgruppen

Der Hauptjob von CI `34476790152` überschritt laut GitHub-Annotation das
15-Minuten-Limit. Ein abgebrochener Lauf ist kein bestandener Gesamtcheck.
Die CI verteilt daher die Node-Testdateien über deren native
`--test-shard=1/2` und `--test-shard=2/2`-Option auf zwei unabhängige Runner.
Kein Namensfilter oder handgepflegter Dateikatalog schließt Tests aus.

Jeder Runner führt vorher `npm run check:prepare` aus: Todo-, Workflow-,
Deployment-, Release-, Lizenz-, Typ-, Frontend-, Build-, Leakage- und
Go-Gates. Anschließend folgen sein Node-Shard und die vorhandenen optionalen
Infrastruktur-Gates einschließlich sichtbarer Skips. Das 15-Minuten-Limit
bleibt pro Runner bestehen. `fail-fast: false` lässt den zweiten Shard auch
dann zu Ende prüfen, wenn der erste scheitert.

Der bisherige erforderliche Checkname **Tests and browser E2E** bleibt als
abschließender Job erhalten. Er läuft nach beiden Shards auch bei Fehlern
und akzeptiert ausschließlich deren Gesamtergebnis `success`, niemals
`failure`, `cancelled` oder `skipped`. Docker bleibt von diesem Job und dem
nativen Packager abhängig. Der SBOM wird nur in Shard 1 erzeugt und unter
dem bisherigen Artefaktnamen hochgeladen; keine kollidierenden Uploads.

Lokal bleibt `npm run check` ein vollständiger, ungeteilter Check in derselben
Reihenfolge. `check:prepare` extrahiert lediglich die zuvor inline stehende
Vorbereitung. Die Änderung reduziert weder Testumfang noch Sicherheitsfristen
und verändert keine produktiven Anwendungen.

Die Regression prüft den vollständigen Skriptinhalt, die geschlossene
Matrix, Gate-Reihenfolge und den Aggregator. Zwei echte Node-CLI-Aufrufe
führen zusammen sechs synthetische Dateien disjunkt und vollständig aus;
ein absichtlich fehlerhafter Test pro Shard führt jeweils zu Exit 1. Für
diese unabhängigen Kindprozesse wird die vom übergeordneten Node-Testrunner
gesetzte Worker-Markierung entfernt. Ohne diese Isolation lieferte der erste
Fixture-Versuch keine TAP-Mitglieder und scheiterte ausdrücklich.

Sieben gezielte Workflow-/Shard-/Diagnoseprüfungen bestehen in 0,644 s,
ebenso die YAML- und Todo-Validierung. Ein erfolgreicher vollständiger Lauf
der neuen CI-Topologie steht noch aus. Bekannte Medienfehler bleiben offen;
die Aufteilung ist keine Behebung dieser Fehler und kein Deploymentnachweis.

Der nachfolgende alte, noch ungeteilte Lauf `34478718778` auf `e3c8ae8` ist
inzwischen mit Exit 1 beendet: 1.272 Node-Tests bestanden, einer scheiterte,
vier waren ausdrücklich übersprungen (697,520 s). Dieser Lauf erreichte sein
Node-Endergebnis und wurde nicht wegen des Zeitlimits abgebrochen. Die
Ein-Quellen-Szene scheiterte am dekodierten Bildnachweis; Ananta-TURN, native
Agenten und beide macOS-Jobs bestanden. Die neue Partitionierung war darin
noch nicht enthalten. Lokale Audio-/Browsertests sind wegen der gemeldeten
Windows-Audiostörung pausiert; weitere vollständige Prüfungen erfolgen
zunächst ausschließlich auf GitHub-Runnern, nicht über das lokale WSLg-Audio.

## Erster vollständiger Lauf der neuen Topologie

CI `34489193294` auf `cae41da` ist terminal fehlgeschlagen. Shard 1 besteht
mit 657 Node-Passes, null Fehlern und einem Skip (364,200 s); Shard 2 meldet
622 Passes, zwei Fehler und drei Skips (276,692 s). Beide Runner beenden ihre
Jobs innerhalb der unveränderten 15 Minuten: 9:40 beziehungsweise 7:46.
Die komplette Vorbereitung besteht auf beiden Runnern. Die neuen echten
Receiver-Widerrufe bestehen ebenfalls, nach 28 beziehungsweise 33 dekodierten
Frames mit geschlossenem Transport und entzogener Parent-Policy.

Shard 2 scheitert in beiden Szenenfällen an weiterhin dekodiertem Slate statt
Quellbild, bereits in Producer und committed HLS. Der andere Shard wird
dennoch bis zum Ende geprüft. Das Aggregat bleibt danach korrekt rot;
Docker und Live-Keycloak/TURN bleiben gesperrt. Separat scheitert Chromium
TURN-UDP vor Browserstart am Testproxy, während Firefox UDP und beide
TCP-Fälle bestehen. Native Agenten und beide macOS-Jobs bestehen.

Damit sind Ausführung und Fehlerweitergabe der Partitionierung real belegt,
nicht die Fehlerfreiheit der Anwendung oder ein erfolgreicher Release.

## Nachfolgender Lauf auf 5671aea

CI `34490651291` ist ebenfalls terminal fehlgeschlagen. Shard 1: 658 Passes,
null Fehler, ein Skip in 368,127 s. Shard 2: 624 Passes, ein Fehler, drei Skips
in 258,694 s. Die Ein-Quellen-Szene liefert weiterhin Slate in Producer und
committed HLS, obwohl der Player Frames dekodiert; der Zwei-Quellen-Fall
besteht diesmal. Daraus folgt keine Ursachenbehebung. Native Packager,
Blind Media und beide macOS-Jobs bestehen. Der separate Ananta-TURN-Job
scheitert in drei Fällen vor Browserstart am privaten Testproxy; Firefox TCP
besteht. Aggregat rot, Docker und Live-Keycloak/TURN übersprungen.

## Laufzeitmetriken und HLS-Backpressure

`34492118006` auf `cfdcf44` endet mit 620 Passes, einem Fehler und drei Skips
in Shard 1 (256,138 s) sowie 669 Passes, null Fehlern und einem Skip in
Shard 2 (339,634 s). Die neuen Runtime-Metriken bestehen. Ananta-TURN und alle
nativen Agenten-/macOS-Jobs bestehen; nur der Ein-Quellen-Szenentest scheitert.

`34493133874` auf `6408b96` endet mit 677 Passes, null Fehlern und einem Skip
in Shard 1 (364,585 s) sowie 623 Passes, einem Fehler und drei Skips in
Shard 2 (257,988 s). Der HLS-Backpressure- und reale HTTP-Abbruchnachweis
besteht. Der Ein-Quellen-Szenentest scheitert weiterhin vor diesem neuen
Decoder-Startfix. Separat scheitert Chromium TURN-UDP wieder vor Browserstart
(connect/refused, Container running, keine Startmarker); Firefox UDP und beide
TCP-Fälle bestehen. Native/Blind/macOS-Jobs bestehen. Beide Gesamtläufe bleiben
rot; Docker und Live-Keycloak/TURN werden nicht ausgeführt. Die Verteilung der
Testdateien auf Shards ändert sich durch neue Dateien; eine Shardnummer ist
keine dauerhafte Kategoriezuordnung.

## Decoder-Startfix auf 563561a

`34494345258` ist terminal fehlgeschlagen: Shard 1 enthält 677 Passes, null
Fehler und einen Skip (344,109 s); Shard 2 enthält 622 Passes, zwei Fehler und
drei Skips (266,364 s). Sowohl Ein- als auch Zwei-Quellen-Szenentest scheitern
bei der Prüfung des dekodierten Bildinhalts. Der deterministisch korrigierte
Startup-Quarantänefall ist damit keine ausreichende Behebung dieser Szenenfehler.
Native Packager, Blind Media, beide macOS-Jobs und Ananta-TURN bestehen.
Das Aggregat bleibt rot; Docker und Live-Keycloak/TURN werden übersprungen.
