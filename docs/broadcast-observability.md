# Inhaltsfreie Broadcast-Observability

Stand: 2026-09-10. TBP-034 definiert und testet eine kleine Metrik- und
Readiness-Grenze sowie einen angeschlossenen Control-Plane-Messport.
Es ist noch kein externer Collector im öffentlichen
Deployment aktiviert; die SLOs bleiben deshalb `runtimeVerified: false`.

## Metrikgrenze

`BroadcastMetricRegistry` kennt ausschließlich 19 feste Metriknamen und pro
Metrik geschlossene Enum-Labels. Der Katalog umfasst Program-State und
Start/Stop/Handoff, WHIP-Sessions, Ingest-/Egress-Bitrate, encoded/keyframe/
dropped Frames, Encoderzeit, Segmente/Parts, Viewerklassen, Playerstart,
End-to-glass, Rebuffering, A/V-Sync-Proxy, Caption-Delay, CPU/RAM/Disk,
Quota-Auslastung, Failover und Error Budget.

Program-ID, Tenant, Principal, Gerätename, Titel, Room-Code, IP, User-Agent,
Token, SDP/ICE, Medien- und Captioninhalt sind keine zulässigen Labels. Die
maximal 512 Zeitreihen sind dadurch schon per Vertrag cardinality-begrenzt.
Histogramme speichern Count, Summe und feste Buckets, keine einzelnen
Beobachtungen. Stale Werte können über `purgeBefore` gelöscht und bei Destroy
vollständig verworfen werden. Eine Prometheus-Darstellung existiert als
interner Port, wird aber nicht öffentlich ausgeliefert.

### Angeschlossene Runtime-Instrumentierung

`createAppServer().broadcastMetrics` bietet in-process `snapshot()` und
`prometheus()`. Beide lesen denselben Cache und fragen höchstens einmal pro
15 Sekunden `BroadcastRuntimeRegistry.programStateCounts()` ab. Es gibt keinen
Hintergrundtimer, Exportprozess oder HTTP-Endpunkt. Nach Server-Close werden
Cache und Runtime-Referenz verworfen; spätere Leseaufrufe bleiben leer.

Die neue Gauge `broadcast_control_programs{state="…"}` zählt die neun exakten
Domainzustände: `draft`, `preparing`, `awaiting_consent`, `publishing`, `live`,
`degraded`, `stopping`, `stopped`, `failed`. Jede erfolgreiche Stichprobe enthält
auch Nullwerte. Gezählt werden alle in dieser Serverinstanz registrierten
Programme, einschließlich beendeter Einträge, über alle Tenants hinweg.
Das ist ein interner Operator-Messwert, keine öffentlich zulässige Übersicht.
Der Registry-Port gibt weder einzelne Records noch IDs, Namen oder Titel aus.

Ein `live`-Control-State beweist weder aktuelle Writer-Leases noch decodierte
Frames, hörbaren Ton oder erreichbare Zuschauer. Deshalb wird er nicht als
Medien-SLO und nicht als die profilabhängige Gauge `broadcast_program_state`
ausgegeben. Die Runtime kennt keine verlässliche Origin/CDN-Profilzuordnung;
diese wird nicht geraten. Auch kurzlebige Zwischenzustände und ihre Dauer lassen
sich aus 15-s-Stichproben nicht zuverlässig ableiten.

Fehlende Runtime-Capability, unbekannte Felder, ungültige Counts, Abfragefehler
oder ungültige Uhrwerte leeren den Cache, ohne Ausnahmeinhalte zu loggen oder
Programmzustände zu ändern. Eine zurückspringende Uhr leert den Cache und setzt
die 15-s-Samplinggrenze neu. Ein Fehler erzeugt keine erfundenen Nullmesswerte.
Der Port hält nur neun aktuelle aggregierte Gauges, keine Einzelereignisse oder
Historie. Die übrigen Katalogmetriken sind damit ausdrücklich noch nicht an
Medien-, Player- oder Hostmessungen angeschlossen.

## Health und Readiness

`/healthz` bleibt absichtlich der kleine Meet-Liveness-Pfad. `/readyz` trennt
Control Plane, Trusted Packager, Media-Gateway, Origin/CDN und optionalen MoQ-
Adapter. Ein deaktivierter oder ausgefallener optionaler MoQ-Adapter macht das
Meet nicht ungesund. Nur ein nicht bereiter Control-Plane-Prozess setzt den
Gesamtstatus auf `unavailable`; Broadcast kann unabhängig `disabled`, `ready`
oder `degraded` sein. Bei aktiviertem Native-Pfad prüft `/readyz` eine frische,
gesunde Agent-Capability und den internen Origin über einen auf zwei Sekunden
begrenzten Health-Request. Ein nicht verwendeter Media-Gateway-Pfad bleibt
`disabled` und verschlechtert den gesunden Native-Pfad nicht. Beobachtungen nach
30 Sekunden ohne Erneuerung gelten als stale.

## Dashboard, Alarmierung und Datenschutz

[`broadcast-dashboard.v1.json`](../infra/observability/broadcast-dashboard.v1.json)
gruppiert die erlaubten Metriken in Program, Ingest/Encoding, Delivery,
Viewer-Erlebnis, Kapazität/Kosten und Recovery/Error-Budget. Alle zehn
Schwellen besitzen feste Warn-/Critical-Codes und Repository-Runbooks.

Das geplante Exportziel ist nur für die Rolle `broadcast-operator` erreichbar.
Counters/Gauges werden höchstens alle 15 Sekunden, inhaltsfreie
Viewer-Erfahrungswerte aus zehn Prozent der Sessions und Fehler/Failover
vollständig erfasst. Hochauflösende Werte werden maximal 14 Tage, aggregierte
Rollups 90 Tage gehalten. Rohmedien und Captiontext werden nie exportiert.
Löschung erfolgt im Collector per TTL und im In-Memory-Port per Purge/Clear.

## Verifikation und offene Gates

Tests prüfen vollständigen Metrikkatalog, geschlossene Labels, Aggregation,
Cardinality, Purge, getrennte Readiness, alle Alarm-/Runbook-Zuordnungen und
synthetische Leakage-Canaries. Der Runtime-Port wird zusätzlich gegen echte
Registry-Erstellung, Publisher-Autorisierung/Gateway-Aktivierung und Stop sowie
die Server-Close-Grenze geprüft, ohne Browser oder Audio zu starten.
Offen bleiben Medien-/Player-/Host-Instrumentierung, Übergangslatenzen,
abgesicherter Prometheus-Collector,
Dashboard-Import, Alarmzustellung, Zugriffsaudit und Last-/SLO-Messungen auf
dem Zielhost. Daher bleibt TBP-034 offen (`in_progress`).
