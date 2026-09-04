# Broadcast Admission-Control, Backpressure und Abuse-Schutz

Stand: 2026-09-04. TBP-033 stellt eine gemeinsame, default-deny
Admission-Grenze sowie begrenzte Queue- und Abuse-Primitiven bereit. Da die
produktive Program-Orchestrierung noch nicht aktiviert ist, bleibt der Track
`partial`; die Regeln dürfen erst dort als durchgängig aktiv bezeichnet werden,
wenn jeder Startpfad die Admission-Lease vor der ersten Medienallokation
erzwingt.

## Pre-Allocation-Grenzen

`BroadcastAdmissionController` prüft einen geschlossenen, idempotenten
Startplan, bevor eine Lease angelegt wird. Standardmäßig gelten:

| Ressource | Grenze |
| --- | ---: |
| HTTP-Request / Control-Message | 32 KiB / 16 KiB |
| aktive Programme Deployment / Tenant / Principal / Gateway | 32 / 8 / 3 / 16 |
| Quellen / Renditions / Encoder je Programm | 4 / 3 / 3 |
| Queue | 256 Einträge und 32 MiB |
| flüchtiger Segment-Speicher / Livefenster | 512 MiB / 30 s |
| Viewer / Egress je Admission | 500 / 1 Gbit/s |
| Programmlaufzeit | 4 h |
| Startversuche | 10 je Principal und 10 min |
| Katalog / expandierter Payload / Inflationsfaktor | 256 Einträge / 4 MiB / 20× |

Die Grenzen sind Operator-Konfiguration, keine neue globale Raumgrenze.
Identische `operationId` und identischer Plan liefern dieselbe Lease; eine
Mutation unter derselben ID wird als Replay abgewiesen. Abgelaufene Leases
werden freigegeben. Ein Limitfehler erhält öffentlich nur
`broadcast_temporarily_unavailable`; der Operator kann den Grund über eine
HMAC-pseudonymisierte `BCAST-…`-Diagnosereferenz korrelieren, ohne Tenant-,
Principal- oder Gateway-ID im UI offenzulegen.

## Queue- und Socket-Backpressure

`BoundedBroadcastQueue` akzeptiert ausschließlich kleine Metadaten-Envelopes,
nicht die Medieninhalte selbst. Realtime-Medien und Captions dürfen bei
Überlauf die älteste noch nicht verarbeitete Arbeit verwerfen. Control- und
Delivery-Arbeit wird nicht still verworfen: wiederholter Überlauf führt
deterministisch von `degrade` zu `stop`. Ein Alterslimit entfernt stale Arbeit;
`clear()` räumt Stop, Handoff und Destroy idempotent auf.

Der vorhandene private HLS-Proxy begrenzt zusätzlich gleichzeitig offene
Upstream-Anfragen global und pro Playback-Session. Response-Body, Idle-Zeit
und gesamte Streamlaufzeit sind begrenzt. Fehler, Cancel, HEAD und normales
Streamende geben den Slot genau einmal frei. Redirects, fremde Ziele,
unbekannte MIME-Typen, unzulässige Ranges und Antworten über 24 MiB bleiben
verboten.

## Abuse-Matrix

| Angriff | Durchgesetzte Grenze |
| --- | --- |
| Token-Raten / Pfadenumeration | einheitliches 404 für private Misses; Playback-Probes pro HMAC-pseudonymisiertem Actor begrenzt |
| Hotlinking | exakter Origin, SameSite-Strict-/HttpOnly-/Secure-Cookie und resourcegebundener Pfad |
| Credential-Stuffing | getrennte 5-Minuten-Buckets vor Playback-Exchange und internem Gateway-Auth |
| Start-/Stop-Flapping | Principal-Startfenster plus idempotente Operation-ID |
| View-Bots | aktive Session-Quoten, HMAC-deduplizierte Viewer-Leases und Heartbeat-Bucket |
| Catalog-Flood | feste Kataloggröße, cachebare statische Liste und eigener Read-Bucket |
| JSON-/Archivbomben | Wire-, Expanded-, Verhältnis- und Eintragsgrenze vor Verarbeitung |
| SSRF / DNS-Zielmissbrauch | fester HLS-Gateway-Origin sowie bestehende exakte MoQ Host-/Pfad-Allowlist ohne IP-Literale, Query oder Redirect |
| offener Relay-/Proxy | action-, resource-, path-, program- und epochgebundene Grants; unbekannte Methoden/Pfade default-deny |

`BroadcastAbuseGuard` speichert nie rohe IP-, Token- oder Principalwerte,
sondern nur keyed HMAC-Buckets. Seine Anzahl und Lebenszeit sind begrenzt.

## Verifikation und offene Gates

Unit- und Negativtests prüfen jede Ressourcendimension, Scope-Quoten,
Idempotenz/Replay, Flapping, Queue-Drop/Degrade/Stop, Actor-Buckets,
Payload-Inflation und langsame HLS-Verbindungen. Ein gemeinsamer synthetischer
Lasttest erzeugt 1.000 abgewiesene Broadcast-Starts und belegt parallel, dass
RoomRegistry weiter exakt 20 Teilnehmer aufnimmt und Coturn-REST-Credentials
ausgibt.

Noch offen sind die Verdrahtung der Admission-Lease in den echten
Program-Composition-Root, native Encoder-/Providerqueues, transaktionale
clusterweite Quoten, reale Bot-/WAN-/Slowloris-Tests und ein gemessener
gemeinsamer Lastlauf gegen Signaling, SFrame-Medien, TURN und MediaMTX. Bis
dahin schützt die neue Grenze vorhandene Playbackpfade und kommende Adapter,
ist aber keine vollständige Produktionsgarantie.
