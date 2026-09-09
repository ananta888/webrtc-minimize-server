# Ananta: Ablaufgrenze bei der Sitzungserneuerung

Der priorisierte Meet-Review vom 9. September 2026 betrifft die bereits
integrierten Ports für Audioempfang, Chat, agenteneigenen Bildschirm,
Sitzungserneuerung und Quellenfreigaben in Angular. Er fügt keine Hub- oder
Projektfreigabe hinzu und verändert das Ananta-Repository nicht.

## Konkrete Korrektur

`MachineSessionLeases.renew()` prüft zunächst die bestehende Sitzung mit
`live()` und liest anschließend die Uhr für seine Erneuerungsentscheidung.
Lief die alte Lease zwischen diesen Beobachtungen ab oder sprang die Uhr
zurück, konnte bisher trotzdem eine neue Generation ausgegeben werden.
Beide Fälle sind vor der Korrektur mit injizierten Zeitfolgen reproduziert:
Die erwartete Ablehnung fehlte in beiden Tests.

Die neuere Beobachtung wird nun vor jeder Verlängerung gegen die alte
Deadline und den zuletzt akzeptierten Zeitpunkt geprüft. Bei Verlust der
Gültigkeit wird die Sitzung entfernt, ihr eigener Stop genau einmal ausgelöst
und `machine_session_unavailable` zurückgegeben. Eine gültige Entscheidung
aktualisiert zudem die Zeitbasis für spätere Rücksprungprüfungen.
Frische Hub-Signatur, Gerätebindung, Scope, Generation/CAS, unveränderte Rechte,
zehn Minuten je Lease und zwei Stunden Gesamtbudget bleiben erforderlich.
Es gibt keinen automatischen Wiederbeitritt oder Wiederherstellen von Consent.

Dies ist kein nachgewiesener Fix für den separaten Bildschirmstillstand nach
etwa 36 Minuten. Die Langzeitabnahme bleibt offen.

## Gezielte Verifikation

- Drei neue Regressionen prüfen Deadline, Rücksprung und die gespeicherte
  neuere Entscheidungszeit. Mit Admission-, Trust-, Receive-, Retirement- und
  Integrationsprüfungen bestanden 102 Node-Fälle.
- Der echte TLS-/SFrame-Dialog bestand in Chromium und Firefox in insgesamt
  20,915 Sekunden: je vier Phasen mit 16.000 entschlüsselten PCM-Samples,
  korrelierten Chatantworten und dekodierten roten/grünen Bildschirmbildern,
  drei aktive Lease-Erneuerungen, unveränderte Freigaben und wirksamer Entzug.
  Die Maschinenclients öffneten keine menschliche Capture-API.
- Dieser Kurzlauf verwendet das vorhandene isolierte Frontend von
  `/tmp/webrtc-rollover-release.QBPCPE/dist/browser` und den aktuellen lokalen
  Server. Er ist kein vollständiger Check der offenen Broadcast-Arbeitskopie.
  Der Serving-Build blieb unverändert.

## Isolierter Abschlusscheck

`npm run check` auf dem festen Stand `bbc526f` plus diesem Sitzungsfix bestand
mit Exit 0: 1.198 Frontendtests und 1.117 Node-/Browserprüfungen, null Fehler,
vier explizite Node-Skips (483,525 Sekunden Node-Lauf). Produktionsbuild,
Typprüfung, Go-Unit/Vet und statische Gates bestanden. 14 externe Infrastruktur-
Gates und der optionale Container-Image-Scan blieben ausdrücklich übersprungen.
Auch im frischen Build bestanden die aktiven Chromium-/Firefox-Dialoge und
beide nativen Szenen-/HLS-Fälle. Der frühere fehlgeschlagene CI-Lauf wird durch
diesen neuen lokalen Lauf nicht nachträglich grün oder ursächlich erklärt.

Prüfverzeichnis: `/tmp/webrtc-ananta-renewal-check.OxZHls`, Protokoll `check.log`.
Die offene native Audio-/Broadcast-Arbeitskopie wurde nicht hineingenommen.
Der lokale Serving-Index behält SHA-256
`2a9259b48e7e9676d8d48346247c4bd0e2bf37c1855b2fa9b8428618aa2ea783`.
Neue CI, Deployment, öffentliche Hub-/Projektaktivierung und Zweistundenabnahme
sind eigene Schritte, keine Ergebnisse dieses Checks.

Öffentlich meldet `/api/machine/integration` weiterhin
`admissionEnabled: false`, bei vorhandenen Softwarefähigkeiten. Für den
tatsächlichen Hub-/Worker-Beitritt fehlen weiterhin das ausgewählte öffentliche
Trustprofil und der freigegebene Ananta-Projektauftrag. Softwaretests ersetzen
diese Betreiberentscheidung nicht. Details zur vorhandenen Oberfläche und
Aktivierung: [Integrationsstand](ananta-integration-status.md).
