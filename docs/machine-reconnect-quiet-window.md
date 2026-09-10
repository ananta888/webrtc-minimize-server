# Monotones Ruhefenster im privaten Ananta-Reconnect-Test

Diese Änderung betrifft ausschließlich Testevidenz, nicht Medien-, Hub- oder
Sitzungsrechte. Der isolierte Gesamtcheck auf `cb2e6e7` plus TLS-Diagnose
verfehlte die bisherige Mindestanzahl von Samples im Ruhetest nach 205,612 ms.
Die Beobachtung verwendete `Date.now()` für ein angebliches 300-ms-Ruhefenster.
Dieser Befund allein beweist nicht die Ursache des damaligen Fehlers.

Ein gezielter Vorher-/Nachher-Test belegt die konkrete Schwachstelle: Bei einer
vorwärts springenden Wanduhr gab die unveränderte Funktion sofort den positiven
Ruhebeleg aus; die Regression scheiterte nach 2,810 ms. Die Kontrolluhr dieses
Tests ist unabhängig und monoton. Es wurden keine Produktuhren verstellt.

Der separate `machine-reconnect-quiet-window.mjs`-Beobachter verlangt jetzt:

- 300 ms anhand einer monotonen Uhr, nicht anhand von Epochzeit;
- gültige geschlossene All-Track-Samples mit ein bis vier beobachteten Tracks;
- höchstens 150 ms zwischen Samples, also drei normale 50-ms-Pollintervalle;
- ein neues Fenster nach Aktivität, größerer Beobachtungslücke oder geänderter
  Trackzahl; ungültige oder rückwärts laufende Beobachtungsuhren schlagen fehl.

Der bestehende Gesamtzeitrahmen von drei Sekunden bleibt unverändert.
Es gibt keine zusätzlichen Polls, Capture-Aufrufe, Quellen, Grants oder Retries.
Auch dieser Beleg bleibt eine begrenzte Stichprobenbeobachtung, kein Beweis
vollständiger akustischer Stille zwischen den Samples.

Die alte schedulerabhängige Forderung nach acht Aufrufen wurde durch
deterministische Dauer-/Lückenprüfungen ersetzt. Ein vollständiger zulässiger
Verlauf mit zwei aktiven und anschließend drei stillen Samples kann schon fünf
Aufrufe enthalten, wenn die stillen Samples jeweils 150 ms auseinanderliegen.
Der Test gegen Wanduhrsprünge verlangt zusätzlich echte monotone Laufzeit.

Alle 43 fokussierten Reconnect-/Proxy-/TLS-/STUN-Prüfungen bestehen ohne Skip
(1,099 s), einschließlich des vorher fehlgeschlagenen Wanduhrtests. Der zuvor
gestartete Gesamtcheck enthält diese spätere Teständerung ausdrücklich nicht.
Keine sofortige Wiederholung der großen Suite; neue gemeinsame CI bleibt
separate Evidenz. Der öffentliche Software-Rollout `cb2e6e7` enthält weder
diese Änderung noch die uncommittete TLS-Diagnose. Der historische
Ananta-Langzeitstillstand ist damit nicht als behoben ausgewiesen.
