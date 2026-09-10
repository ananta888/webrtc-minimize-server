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
