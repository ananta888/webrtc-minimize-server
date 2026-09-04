# Broadcast-Last-, Qualitäts- und Kostenbericht

Stand: 2026-09-04. Profile und Budgets stehen in `infra/testing/broadcast-validation-profile.v1.json`, die tatsächlich beobachteten Werte in `infra/testing/broadcast-validation-results.v1.json`. Eine konkrete maximale Zuschauerzahl ist ausdrücklich keine Produktgarantie.

## Reale lokale Messung

Ein MediaMTX-1.20.1-Origin wurde gestuft mit 5, 20 und 50 gleichzeitigen LL-HLS-Viewern belastet. Alle Viewer beendeten alle drei Läufe ohne Fehler. Der 20er-Lauf erreichte 183,33 Requests/s, 6,39 ms p95 Request-Latenz, 86,65 Mbit/s Origin-Egress, 2,70 % Gateway-CPU und 47,32 MiB Gateway-RAM. Der 50er-Lauf erreichte 431,20 Requests/s, 13,94 ms p95, 204,63 Mbit/s Egress, 3,23 % CPU und 66,62 MiB RAM. Diese lokalen synthetischen Werte sind keine Hochrechnung auf einen Produktions-CDN.

Der interaktive Raum nimmt unabhängig davon 20 Teilnehmer an, lehnt Teilnehmer 21 ab und blieb im deterministischen Overload-Isolationstest funktionsfähig. Eine reale Vorher-/Während-/Nachher-Latenzmessung unter Broadcastlast steht noch aus.

Der reproduzierbare Qualitäts-Gate kodiert ein fünfsekündiges 1280×720/30-Testbild mit libx264 CRF 23 und vergleicht das dekodierte Ergebnis gegen die Quelle. Der beobachtete SSIM-All-Wert war 0,993941 bei 2,7719 Mbit/s. VMAF, Screen-OCR, Packet-Loss, Rebuffering, physischer A/V-/Caption-Sync und eine subjektive Stichprobe sind noch nicht gemessen.

## Ausführung

```sh
RUN_LIVE_MEDIAMTX_ORIGIN_LOAD=1 MEDIAMTX_LOAD_VIEWERS=20 MEDIAMTX_LOAD_DURATION_MS=15000 node scripts/live-mediamtx-origin-load-gate.mjs
RUN_LIVE_BROADCAST_LOAD_MATRIX=1 npm run test:load:local
RUN_LIVE_BROADCAST_QUALITY=1 node scripts/live-broadcast-quality-gate.mjs
node --test test/server.integration.test.js test/broadcast-overload-isolation.test.js test/broadcast-failover-coordinator.test.js test/broadcast-validation-evidence.test.js
```

Das Release-Soak-Profil verlangt mindestens vier Stunden und erfasst Quellen-, Layout- und Renditionwechsel, Caption-Cues, Late Join, Netzfehler und Stop zusammen mit Memory, Handles, CPU/GPU, Disk, Egress, Freeze, Drift und Cleanup. Dieser Lauf wurde noch nicht ausgeführt. Ebenso fehlen reale Control-Plane-Restarts, DNS-/TLS-/Partitionsfehler sowie ein Provider-/CDN-Tenant. Deterministisch geprüft sind Fencing, Packager-/Gateway-Übernahme, abgelaufene Grants und Split-Brain-Abwehr; der lokale LL-HLS-Gate prüft Publisher-Neustart und Muxer-Cleanup.

## Kosten

Die lokale Messung liefert Ressourcen- und Egressmengen, aber keine belastbaren Preisraten. Compute-, GPU-, Provider-, CDN-, Observability- und Speicherpreise bleiben deshalb `null` beziehungsweise `rate-unavailable`. Quoten oder Warnschwellen werden erst aus einem realen Produktionsprofil mit hinterlegten, zeitgebundenen Providerpreisen abgeleitet; dieser Bericht erfindet keine Kostenangabe.
