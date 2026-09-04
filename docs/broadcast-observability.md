# Inhaltsfreie Broadcast-Observability

Stand: 2026-09-04. TBP-034 definiert und testet eine kleine Metrik- und
Readiness-Grenze. Es ist noch kein externer Collector im öffentlichen
Deployment aktiviert; die SLOs bleiben deshalb `runtimeVerified: false`.

## Metrikgrenze

`BroadcastMetricRegistry` kennt ausschließlich 18 feste Metriknamen und pro
Metrik geschlossene Enum-Labels. Erfasst werden Program-State und
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
synthetische Leakage-Canaries. Offen bleiben echte Instrumentierung der noch
nicht aktiven Program-Orchestrierung, abgesicherter Prometheus-Collector,
Dashboard-Import, Alarmzustellung, Zugriffsaudit und Last-/SLO-Messungen auf
dem Zielhost. Daher bleibt TBP-034 `partial`.
