# Aktive Tracks

Ausführbare Arbeit liegt als `todo.<track>.json` in diesem Ordner. Nutzer- und Gerätegates (Safari, MiniPC, physische Audio-/Soak-Läufe) stehen in jedem Track zuletzt. Vor Codeänderungen wird ein passender Task auf `in_progress` gesetzt; nach vollständigem Abschluss und erfolgreichem `npm run todos:validate` wandert der unveränderte Track nach `todos/archive/`.

Lokale Slices bleiben klein und nutzen gezielte Unit-Tests. `git push` erfolgt erst nach einem abgeschlossenen Block — bevorzugt ein vollständiger Track, mindestens ein erfüllter Task oder Milestone. `npm run check` und lange Integrations- oder Browserläufe gehören an das Blockende, nicht an jeden Slice. Die verbindliche Regel steht in `AGENTS.md`.
