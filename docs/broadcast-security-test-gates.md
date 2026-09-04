# Broadcast-Sicherheits- und Negativtest-Gates

Stand: 2026-09-04.

`infra/testing/broadcast-security-coverage.v1.json` ist die prüfbare Coverage-Matrix. Sie verbindet positive und negative Tests für Schemas, Zustandswechsel, Idempotenz, Fencing, Grants, Sichtbarkeit, Consent, Capability-/Codec-Auswahl, Adapter, Cleanup, Überlast, Cross-Origin, unbekannte Messages und Disconnects mit ihren konkreten Testdateien. Fehlende Dateien oder doppelte Matrixbereiche brechen das Leakage-Gate.

Das Chromium-E2E-Szenario startet auf einem Broadcast-Deep-Link, öffnet das Panel, lädt gespeicherte Capture-/Caption-Präferenzen, führt einen Refresh aus, öffnet einen Viewer-Link, tritt einem Raum bei und empfängt Peer-Signale. Vor dem sichtbaren Kamera-, Mikrofon-, Bildschirm- oder Preview-Klick bleibt die protokollierte Capture-Liste leer. Decrypt-Consent wird weiterhin nur über die getrennte lokale Bestätigung ausgestellt.

`npm run security:leakage` scannt das gebaute Angular-Bundle sowie vorhandene Agent-Artefakte streamend und größenbegrenzt auf feste synthetische Token-, Secret-, Private-Key-, Room-, SDP-, ICE- und Caption-Canaries. Unit-/Integrationstests injizieren dieselben Canaries in serverseitige TURN-/Agent-Konfiguration und prüfen öffentliche Responses, Header, Fehlerseiten und normale Startup-Logs. Symlinks und übergroße Scanziele werden abgewiesen.

In CI wird das fertig gebaute OCI-Image per `docker save` zusätzlich vollständig gescannt. Ein lokales `npm run check` meldet den Image-Scan sichtbar als `SKIP`, solange kein `BROADCAST_IMAGE_ARCHIVE` angegeben ist; Bundle-, Response-, Log- und Artefaktprüfung laufen trotzdem. Externe Keycloak-, TURN-, MediaMTX-, WHIP-, Native-Packager-, LL-HLS- und Origin-Lasttests melden fehlende Infrastruktur ebenfalls explizit als Skip mit Aktivierungsvariable.

Das Gate beweist, dass die festen synthetischen Canaries auf den geprüften Pfaden nicht erscheinen. Es ersetzt weder eine allgemeine DLP-Lösung noch ein externes Penetrationstest- oder Provider-Audit.
