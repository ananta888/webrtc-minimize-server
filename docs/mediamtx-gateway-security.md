# MediaMTX-Gateway-Sicherheitsgrenze

## Zweck und Status

Der externe Auth-Adapter übersetzt ausschließlich den geschlossenen
MediaMTX-HTTP-Auth-Contract in bereits vorhandene, kurzlebige Broadcast-Grants.
Er erzeugt selbst keine Berechtigung. Ohne eine im selben Serverprozess aktive
`BroadcastGrantAuthority` startet das sichere Gateway-Profil absichtlich nicht.

Das ist eine harte Control-Plane-Grenze: MediaMTX erhält weder OIDC-Tokens noch
Raum-Membership und darf daraus keine Policy ableiten. Der Adapter prüft das vom
Gateway gelieferte Bearer-Grant erneut kryptografisch und gegen den
autoritativen, flüchtigen Grant-Datensatz.

## Erlaubte Abbildung

| MediaMTX-Aktion | Protokoll | Grant-Aktion | Pfad |
|---|---|---|---|
| `publish` | WebRTC/WHIP | `whip:create` | `/broadcast/ingest/{resourceRef}` |
| `read` | WebRTC/WHEP | `whep:read` | `/broadcast/play/{resourceRef}` |
| `read` | HLS | `playback:manifest` und `playback:segment` | `/broadcast/play/{resourceRef}` |

Andere Aktionen, Protokolle, zusätzliche JSON-Felder, Basic-Credentials,
Query-Tokens, ungültige IP-Adressen und nicht kanonische Resource-Namen werden
fail-closed abgelehnt. Publisher- und Packager-Grants sind einmalig;
Playback-Grants dürfen innerhalb ihrer kurzen Laufzeit wiederholt Manifest,
Part und Segment abrufen. Epoch-Widerruf, Ablauf, Signatur, Audience, Aktion und
Pfad werden bei jedem Callback geprüft.

## Netzgrenze

`infra/mediamtx/compose.secure.yaml` ist nur zusammen mit der Haupt- und der
Gateway-Compose-Datei gültig. Der Callback liegt auf einem internen Docker-Netz
mit festen Quelladressen. Der HTTP-Handler akzeptiert ausschließlich `POST`,
`application/json`, keine Query und keinen Browser-Origin. Die öffentliche
Reverse-Proxy-Konfiguration darf `/internal/` niemals an Clients weiterleiten.
Das kleine Standardnetz `10.255.254.0/29` und beide Adressen sind über
`BROADCAST_GATEWAY_CONTROL_SUBNET`, `BROADCAST_WEB_CONTROL_ADDRESS` und
`BROADCAST_GATEWAY_CONTROL_ADDRESS` austauschbar, falls sie mit der lokalen
Docker-Adressplanung kollidieren; Subnetz und beide Adressen müssen gemeinsam
geändert werden.

```bash
docker compose --project-directory . \
  -f compose.yaml \
  -f infra/mediamtx/compose.yaml \
  -f infra/mediamtx/compose.secure.yaml \
  --profile broadcast-gateway config -q
```

Das Overlay ist noch kein Produktions-Startsignal: Die Program-Orchestrierung
muss die Grant-Authority als Composition-Root bereitstellen und der Reverse
Proxy muss die späteren WHIP-/Playback-Pfade getrennt freigeben. Bis dieses
Live-Gate reproduzierbar bestanden ist, bleibt TBP-018 `partial` beziehungsweise
`in_progress` und der öffentliche Dienst verwendet das Gateway nicht.

## Inhaltsschutz und Logs

Der Callback antwortet bei Erfolg leer mit `204`, bei Ablehnung ohne
Grant-Inhalt. Tokens, Pfade, Query, User-Agent, IP und Identitätsfelder werden
nicht geloggt. MediaMTX-API und Metrics sind von der HTTP-Authentisierung
ausgenommen, aber nur im internen Control-Netz erreichbar. Packet-Dumps,
Recording, DVR und Debug-Ausgaben bleiben deaktiviert.
