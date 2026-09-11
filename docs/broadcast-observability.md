# Inhaltsfreie Broadcast-Observability

Stand: 2026-09-11. TBP-034 definiert und testet eine kleine Metrik- und
Readiness-Grenze sowie angeschlossene Control-Plane-, Native-Budget-, HLS-Proxy-,
Übergangs- und Programquoten-Messports.
Es ist noch kein externer Collector im öffentlichen
Deployment aktiviert; die SLOs bleiben deshalb `runtimeVerified: false`.

## Metrikgrenze

`BroadcastMetricRegistry` kennt ausschließlich 28 feste Metriknamen und pro
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
interner Port und als optionaler, authentisierter Operator-Endpunkt. Anonyme
Besucher und gewöhnliche Raumteilnehmer erhalten keinen Export.

### Angeschlossene Runtime-Instrumentierung

`createAppServer().broadcastMetrics` bietet in-process `snapshot()` und
`prometheus()`. Beide lesen denselben Cache und fragen höchstens einmal pro
15 Sekunden `BroadcastRuntimeRegistry.programStateCounts()` ab. Es gibt keinen
Hintergrundtimer oder Exportprozess. Nach Server-Close werden
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
leeren die jeweilige Messgruppe, ohne Ausnahmeinhalte zu loggen oder
Programmzustände zu ändern. Eine ungültige oder zurückspringende Uhr leert den gesamten Cache und setzt bei Rücksprung
die 15-s-Samplinggrenze neu. Ein Fehler erzeugt keine erfundenen Nullmesswerte.
Der Programm-Port hält nur neun aktuelle aggregierte Gauges, keine Einzelereignisse oder
Historie. Die übrigen Katalogmetriken sind damit ausdrücklich noch nicht an
Medien-, Player- oder Hostmessungen angeschlossen.

### Angeschlossene HLS-Proxy-Instrumentierung

Ist ein `BroadcastHlsProxy` vorhanden, liest derselbe 15-Sekunden-Sampler dessen
inhaltsfreie `trafficCounts()`. Der Proxy besitzt vier feste Prozesszähler;
er kopiert dafür keine Nutzlasten und legt keine zusätzlichen Sitzungslisten an.
Vier Metriknamen ergeben sechs zusätzliche Zeitreihen:

| Metrik | Tatsächliche Bedeutung |
| --- | --- |
| `broadcast_hls_proxy_active_requests` | Aktuell zugelassene, noch nicht abgeschlossene Upstream-Anfragen |
| `broadcast_hls_proxy_active_sessions` | Unterschiedliche Cookie-Sitzungen mit mindestens einer solchen Anfrage; keine Zuschauerzahl |
| `broadcast_hls_proxy_body_bytes_total` | Body-Bytes, die der Proxy in seinen Downstream-Stream übergeben hat |
| `broadcast_hls_proxy_requests_total{outcome}` | Einmaliger Abschluss als `completed`, `cancelled` oder `failed` |

Bytes zählen erst bei tatsächlicher Nachfrage am Downstream-Stream, nicht beim
Eingang einer Content-Length oder durch Vorablesen. TLS-/HTTP-Overhead und der
Nachweis, dass Bytes beim Zuschauer angekommen sind, sind nicht enthalten.
Der Counter ist daher keine gemessene Netzwerk-Egress-Bitrate und keine
End-to-glass-Messung. Auch Manifeste und andere erlaubte Bodytypen zählen mit;
eine Aufteilung in Audio, Video und Bildschirm wird daraus nicht geraten.

EOF und erfolgreiches HEAD beenden eine Anfrage erfolgreich; Client-Abbruch
zählt `cancelled`, Upstream-/Header-/Streamfehler und Zeitüberschreitung zählen
`failed`. Ablehnungen vor Autorisierung oder wegen ausgeschöpfter Slots werden
nicht als zugelassene Anfragen gezählt. Wiederholter Abbruch zählt nicht doppelt.
Die Summe der abgeschlossenen Anfragen enthält keine noch aktiven Anfragen.

Die Counter laufen über die Prozesslebenszeit und beginnen nach einem Neustart
neu. Der Pullcache übernimmt jeweils den Gesamtstand und addiert ihn nicht
erneut. Bei Überlauf über sichere JavaScript-Ganzzahlen wird die Messgruppe
unverfügbar, ohne den Medienpfad abzubrechen oder unendliche Werte zu exportieren.
Eine fehlende/ungültige HLS-Messgruppe entfernt nur deren Serien; gültige
Programmzustände bleiben sichtbar, und umgekehrt. Kein Proxy bedeutet fehlende
HLS-Serien, nicht erfundene Nullmessungen.

### Angeschlossene Native-Planungsbudgets

Der Server verbindet denselben Sampler mit
`NativePackagerAssignmentRegistry.resourceCounts(now)`. Dieser liest die
tatsächlichen Assignment-Records mit derselben Belegungsregel wie die Admission:
`preparing`, `ready`, `starting`, `running`, `degraded`, `draining` sowie
`failed` bis zum Ablauf der bisherigen Lease. Ein angeforderter Stop gibt noch
nichts frei; eine gültige Stop-Quittung dagegen schon. Aktive abgelaufene Records
bleiben konservativ belegt, bis der normale Lifecycle sie verarbeitet. Der
Messaufruf selbst führt weder Prune noch Stop aus und reserviert nichts.

Fünf Gaugefamilien mit ausschließlich `kind="reserved"` beziehungsweise
`kind="limit"` ergeben zehn weitere Zeitreihen:

| Metrik | Planungseinheit |
| --- | --- |
| `broadcast_native_planning_cpu_units` | Aufgerundete Millionen Ausgabe-Pixel/s, einschließlich Software-Fallback |
| `broadcast_native_planning_memory_mib` | Planungsbudget in MiB |
| `broadcast_native_planning_encoder_slots` | Ausgewählte Rendition-Encoder |
| `broadcast_native_planning_gpu_slots` | Für Hardware-Encoding eingeplante Renditions |
| `broadcast_native_planning_egress_bits_per_second` | Ausgewählte Ausgabe-Bitraten plus Planungsaufschlag |

`reserved` summiert die tatsächlich belegten Zulassungsbudgets; `limit` stammt
aus der wirksamen Operator-Konfiguration. Das sind **keine Messungen** von
physischer CPU-/RAM-/GPU-Last, verfügbarem Speicher, tatsächlichem Netzwerkverkehr,
Zuschauer-Fanout oder Kosten. Die Berechnung steht in
[Codec- und Ressourcenadmission](broadcast-codec-admission.md).
Nullbudgets werden ohne Division explizit exportiert. Es gibt keine zusätzlichen
Tenant-/Owner-/Agent-/Raumlabels, Reservierungslisten oder Einzelrecord-Exporte.
Die Aggregate sind unveränderlich. Ungültige oder fehlende Ressourcenaggregate
entfernen nur diese Messgruppe; sie erzeugen keine vermeintlich freien Slots.

### Angeschlossene Übergangslatenzen und Control-Plane-Host

`broadcast_program_transition_seconds{transition="start"|"stop"|"handoff"|"source-change"}`
wird aus denselben committeten Runtime-Übergängen abgeleitet, die auch das
Programmjournal beobachten. `start` misst Registrierung bis zum ersten
bestätigten `live`, einmal je Programm; `stop` misst `stopping` bis `stopped`
(ein direkter Stop ohne `stopping`-Phase erzeugt keinen Wert); `handoff` misst
vom Beginn der Übergabe (Ausgabe-Neustart unter der nächsten Epoche) bis zur
bestätigten Ausgabe des Nachfolgers unter dieser Epoche – eine bloße
Writer-Zuordnung ist noch kein abgeschlossener Handoff; `source-change` misst
einen nicht-draft `preparing`-Neustart mit anderen Quellen ohne pending Writer
bis zur bestätigten `live`-Ausgabe unter der neuen Epoche. Quellen-IDs bleiben
intern und erscheinen nicht in Samples. Draft-Quellenzuweisung, Writer-Handoff
auch bei geänderten Quellen und ein Epochensprung mit gleichen Quellen erzeugen
keinen `source-change`-Wert. Werte werden nur in einem 15-Minuten-Fenster mit
höchstens 256 Beobachtungen gehalten, ohne Programm-, Tenant- oder Gerätebezug;
der Sampler übernimmt sie in dasselbe Histogramm bei jeder 15-s-Stichprobe.
Fehlende Übergänge erzeugen keine Nullhistogramme.

`broadcast_quota_ratio{scope=…,resource="programs"}` liest dieselbe Occupancy
wie die Programmzuteilung: aktive und pending Programme, keine Drafts/Stopped/
Failed, keine IDs. `deployment` und `gateway` sind die lokale Gesamtzahl gegen
das jeweilige Limit; `tenant` und `principal` sind das **Maximum** über die
jeweiligen Gruppen, nicht eine benannte Gruppe. Viewer-, Egress-, Encoder-,
Laufzeit- und Kostenquoten bleiben unangeschlossen, statt als Null erfunden
zu werden.

`broadcast_resource_utilization_ratio{component="control-plane",resource=…}`
liest ausschließlich diesen Prozesshost: `cpu` als 1-Minuten-Load geteilt durch
Kernanzahl, `ram` als belegten Anteil des Gesamtspeichers, `disk` als belegten
Anteil des Dateisystems unter dem Arbeitsverzeichnis, jeweils auf 0…1 begrenzt.
Unbekannte Kapazität (keine Kerne, kein Speicher, keine Blöcke) ergibt keinen
Wert statt einer falschen Null. Pfade, Mountnamen, Bytezahlen und fremde Hosts
(Packager, Gateway, Origin) werden nicht ausgegeben; deren Ressourcen bleiben offen.

### Optionaler Operator-HTTP-Export

`BROADCAST_METRICS_ENABLED=true` aktiviert `GET /api/broadcasts/metrics`.
Der Schalter ist standardmäßig aus und erfordert `AUTH_MODE=required` sowie
eine HTTPS-`PUBLIC_ORIGIN`. Die TLS-Terminierung muss wie beim übrigen Deployment
vor dem internen Node-Port erfolgen; der Node-Port darf nicht öffentlich
unverschlüsselt erreichbar sein.

Jeder Abruf benötigt einen Bearer-Access-Token im Authorization-Header mit der
exakten Realm-Rolle `broadcast-operator` in `realm_access.roles`. Signatur,
erlaubter Algorithmus, Issuer, Audience, Subject und Ablauf prüft derselbe
JWT/JWKS-Port wie bei menschlichen Sitzungen. Clientrollen, Scope-Strings und
eine gewöhnliche Anmeldung reichen nicht. URL-Parameter und Cookie-Tokens
werden nicht akzeptiert. Ein mitgesendeter Origin muss exakt dem Public-Origin
entsprechen; Collector-Anfragen ohne Origin sind zulässig. CORS wird nicht
freigeschaltet, Antworten sind `no-store` und variieren nach Authorization/Origin.

Pro Prozess gelten höchstens 60 zugelassene Prüfversuche pro 60-Sekunden-Fenster
und zwei gleichzeitige Prüfungen, auch für ungültige Tokens. Es entstehen keine
Identitäts- oder IP-Maps. Budgetüberschreitung liefert 429, fehlende/ungültige
Anmeldung 401, fehlende Operatorrolle 403 und fehlende Messfähigkeit 503.
Der Export verwendet den gemeinsamen 15-Sekunden-Cache. Er liefert die tatsächlich
erhobenen Control-State-, Native-Planungsbudget- und optionalen HLS-Proxy-Messwerte,
keine erfundenen Medienwerte.

Bei vorhandener Runtime, Native-Assignment-Registry und HLS-Proxy sind die
Control-State-, Planungsbudget-, HLS-Proxy-, Programquoten- und Host-Serien
verfügbar. Fehlende Messgruppen werden nicht als Nullzustand ausgegeben.
Die Implementierung vergibt keine Realm-Rollen und aktiviert keinen Collector.
Dessen dedizierte Identität, kurzlebige Tokens und Erneuerung müssen ausdrücklich
provisioniert werden. Ohne Token-Introspektion wird ein Rollenentzug spätestens
mit Ablauf des bereits ausgestellten Tokens wirksam, nicht unmittelbar.

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

Der optionale HTTP-Export ist auf die Rolle `broadcast-operator` begrenzt.
Für die noch anzuschließenden Messpfade gilt als Ziel: Counters/Gauges werden höchstens alle 15 Sekunden, inhaltsfreie
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
HTTP-Tests verwenden echte signierte ephemere JWTs und prüfen Rollen, falsche
Signaturen/Issuer/Audience/Algorithmen, fehlende Claims, Ablauf, JWKS-Ausfall,
Origins, Header, Budgets und Shutdown. Die TLS-/Keycloak-Abnahme auf dem Zielhost
ist dadurch nicht ersetzt.
WebStream-Tests prüfen tatsächliche Byte-Nachfrage, gemeinsame Sitzungsslots,
EOF/HEAD, Abbruch, Upstreamfehler und Timeout, einmalige Zählung, Überlauf und
unabhängig ausfallende Messgruppen. Der HTTP-Test exportiert auch Zähler eines
echten Proxys mit synthetischem Upstream; er beweist keine Zuschauerzustellung.
Native-Tests prüfen echte Prepare-/Stop-/Disconnect-/Lease-Übergänge, unveränderte
Records beim Lesen, geschlossene Aggregate, Nullbudgets, Fehlerisolation und
die tatsächliche Serververdrahtung bis zum JWT-geschützten HTTP-Export.
Übergangslatenzen und der Control-Plane-Host sind über deterministische
Übergangsfolgen, den echten Registry-Start/-Stop/-Handoff und den HTTP-Export
geprüft. Offen bleiben Medien-/Player-Instrumentierung, Packager-/Gateway-/
Origin-Hostressourcen, `source-change`, abgesicherter Prometheus-Collector,
Dashboard-Import, Alarmzustellung, Zugriffsaudit und Last-/SLO-Messungen auf
dem Zielhost. Daher bleibt TBP-034 offen (`in_progress`).
