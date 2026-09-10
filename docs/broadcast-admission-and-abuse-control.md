# Broadcast Admission-Control, Backpressure und Abuse-Schutz

Stand: 2026-09-10. TBP-033 stellt eine gemeinsame, default-deny
Admission-Grenze sowie begrenzte Queue- und Abuse-Primitiven bereit. Der Track
bleibt `in_progress`; die Regeln dürfen erst als durchgängig aktiv bezeichnet werden,
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

### Nachweis und Korrektur der HLS-Backpressure

Der frühere rekursive Upstream-Pump ignorierte den Downstream-Bedarf. Eine
Regression auf dem unveränderten Code las alle drei Chunks einer kontrollierten
Antwort, obwohl der Zuschauer noch kein `read()` aufgerufen hatte. Der Pump
konnte so die gesamte zulässige Antwort puffern und den Concurrency-Slot schon
nach Upstream-EOF freigeben. Das war kein wirksamer Schutz langsamer Zuschauer.

Der Proxy verwendet jetzt `pull()` mit `highWaterMark: 0`: kein eigener
Prefetch-Puffer, höchstens ein Upstream-Read gleichzeitig. Ein erfolgreicher
Read leitet genau einen Chunk weiter; erst neuer Downstream-Bedarf liest nach.
Der Slot bleibt bis zum vom Downstream angeforderten EOF, Cancel oder Fehler
belegt. Fetch-/TCP-/HTTP-Pipeline-Puffer bestehen weiterhin; dies ist keine
Behauptung über exakt null Speicherverbrauch oder vollständig beim Zuschauer
angekommene Bytes. Der unveränderte 24-MiB-Gesamtdeckel gilt auch für viele
kleine Chunks; Nicht-Byte-Chunks werden abgelehnt.

Das Idle-Limit gilt auch für einen nicht weiterlesenden Downstream. Erfolgreich
weitergegebene Chunks erneuern nur diese Idle-Frist, niemals die gesamte
Streamfrist. Cancel/Timeout fencen einen noch laufenden Read und geben den Slot
genau einmal frei. Upstream-Cancel darf werfen, ablehnen oder hängen, ohne die
Freigabe zu blockieren oder rohe Fehlertexte zu loggen. Abgewiesene Statuscodes,
Content-Type/-Length sowie unbenötigte HEAD-Bodies werden ausdrücklich gecancelt.

39 gezielte Node-Prüfungen für HLS, Admission, Playback-Rate und Sessionbindung
bestehen in 0,789 s ohne Skips. Darunter sind echte WHATWG-Streams, kontrollierte
Timer, ein hängendes Cancel und ein echter lokaler HTTP-Upstream, dessen noch
offener 401-Body nach Ablehnung transportseitig geschlossen wird. Keine Browser,
Audioquellen oder öffentlichen Dienste werden dafür gestartet. Dieser Nachweis
ersetzt weder die vollständige CI noch die noch offene gemeinsame WAN-Lastabnahme.

## Aggregierte HLS-Transportbudgets

Der Produktions-Composition-Root verbindet jetzt ENV/Compose mit einem
`BroadcastHlsBudget` im realen `BroadcastHlsProxy`. Alle Sessions und Resources
dieses Proxy-Prozesses teilen sich zwei Tokenbudgets:

| Operatorvariable | Default | Bedeutung |
| --- | ---: | --- |
| `BROADCAST_HLS_MAX_REQUESTS_PER_SECOND` | 200 | Nachfüllrate; Burst ebenfalls 200 Requests |
| `BROADCAST_HLS_MAX_EGRESS_BITS_PER_SECOND` | 100000000 | Nachfüllrate für weitergegebene Body-Bytes, 100 Mbit/s |
| `BROADCAST_HLS_EGRESS_BURST_BYTES` | 25165824 | maximal 24 MiB angespartes Bytebudget |

Es werden niemals mehr als `Burst + Rate × Zeit` Einheiten zugelassen, auch
bei vielen Sessions oder lange unbenutztem Proxy. Das ist keine harte
Momentanbandbreite, kein Fairness-Scheduler und kein gemessener Hostdurchsatz.
Die monoton laufende Prozessuhr verhindert Nachfüllen durch Wanduhrsprünge.
Eine ungültige/rückläufige injizierte Uhr sperrt das Budget terminal; der
normale Produktionspfad verwendet `performance.now()`.

Request-Zulassung erfolgt nach der unveränderten aktuellen Sessionautorisierung,
aber vor dem Upstream-Fetch. Ein ungültiger privater Request bleibt 404 und
verbraucht kein Transportbudget. Der bestehende vorgelagerte Abuse-Schutz
bleibt aktiv. Ein erlaubter Request verbraucht sein Token auch bei Fehler oder
Cancel; dadurch können Fehlversuche kein Budget zurückgewinnen.

Body-Bytes werden unmittelbar vor `enqueue()` reserviert, gemeinsam über alle
laufenden Streams. Bei Überschreitung wird ausschließlich der betreffende
Stream abgebrochen, der Upstream gecancelt und der Slot genau einmal freigegeben.
Es gibt keine Warteschlange und keinen automatischen Retry. Vor HTTP-Headern
ist ein Request-Limit ein 429; nach begonnenem Body beendet ein Byte-Limit den
Stream, **ohne einen nachträglichen HTTP-429 zu versprechen**. Die Player-Recovery
bleibt durch ihre bereits vorhandenen Grenzen beschränkt.

Die Zählung umfasst Body-Bytes, nicht TLS-/HTTP-Overhead oder bestätigten Empfang.
Der zuvor gelesene Upstream-Chunk und Transportpuffer sind weiterhin vorhanden;
dies ist weder Upstream-Ingress-Policing noch eine Begrenzung fremder direkter
MediaMTX-/CDN-Pfade. Mehrere Prozesse haben getrennte Budgets. Die native
Start-Admission, clusterweite Quoten, Viewer-/Blocking-Reload-Profilbindung und
gemessene gemeinsame Lastabnahme bleiben offen.

Zwei neue Regressionen scheiterten am alten Proxy (weiterer Upstream-Request
trotz Requestlimit; weiterer Datenblock trotz erschöpftem Bytebudget). Der
reale lokale HTTP-Nachweis nutzt den Produktions-Serverkonstruktor, echten
Cookie-/Session-Store und separaten HTTP-Upstream: erstes Manifest vollständig,
zweiter Viewer bei Byteknappheit abgebrochen, privater Miss weiter 404,
Health weiter 200. Das ist ein Transport-/Verdrahtungsnachweis ohne Browser
oder Audio, kein Medien- oder WAN-Lasttest.

67 gezielte Node-/Stream-/HTTP-/Session-/Abuse-/Config-/Profilprüfungen
bestehen in 0,543 Sekunden ohne Skip. Deployment-, Workflow-, Release- und
Todo-Gates bestehen ebenfalls. Die vollständige CI und das Deployment dieses
Nachtrags stehen noch aus; die lokale ausgelieferte Angular-Datei blieb
unverändert.

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
