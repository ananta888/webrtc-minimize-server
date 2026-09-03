# Broadcast contracts v1

Diese Verträge beschreiben ausschließlich herstellerneutrale Control-Plane-
Metadaten. Sie transportieren keine Medien, keine Untertiteltexte, keine
SFrame-Schlüssel und keine Signaling-Daten. Das Vorhandensein der Schemas
aktiviert noch keinen Broadcast-Pfad.

## Familien

| Type | Verantwortung | Programmgebunden |
| --- | --- | --- |
| `broadcast-program` | Lifecycle und Sichtbarkeit eines Programms | ja |
| `program-source` | bewusst ausgewählte lokale oder consentierte Quelle | ja |
| `publication` | Packager-Publikation aus einer begrenzten Quellenmenge | ja |
| `rendition` | Codec-, Bitrate-, Audio- oder Video-Ziel einer Publikation | ja |
| `delivery-endpoint` | opaque Ausgabereferenz für HLS/LL-HLS/WHEP/MoQ | ja |
| `provider-capability` | kurzlebige, runtime-geprüfte Adapterfähigkeit | nein, tenantweit |
| `consent` | quellen-, action-, epoch- und zeitgebundene Freigabe | ja |
| `lease` | gefenceter Packager-/Gateway-Writer | ja |
| `grant` | kurzlebige erlaubte Protokollaktionen ohne Tokenmaterial | ja |
| `viewer-policy` | private/öffentliche Sichtbarkeit und Auth-Regel | ja |
| `caption-track` | Sprache, Format und flüchtiger Live-Lifecycle | ja |
| `health` | begrenzte technische Zustände ohne Freitext | optional |
| `event` | geschlossene Lifecycle-Ereignisse und Idempotency-Hash | ja |

[`common.v1.schema.json`](common.v1.schema.json) enthält nur wiederverwendbare
Definitionen. Jede der 13 eigentlichen Familien liegt in einer eigenen
additiven `*.v1.schema.json`-Datei, ist mit `additionalProperties: false`
geschlossen und besitzt einen konstanten `type` und `contractVersion: 1`.

## Bindungen und IDs

- `tenantId` und alle Subject-/Principal-Werte sind opaque pseudonyme
  Referenzen. OIDC-Issuer, Subject und Tokens gehören nicht in die Contracts.
- Programmgebundene Objekte tragen `roomId`, `programId`, `programEpoch` und
  `revision`. Eine bekannte Room-ID oder Program-ID verleiht allein keine
  Autorität.
- Ressourcen- und Endpoint-Referenzen sind opaque IDs. Insbesondere enthalten
  sie keine signierte Playback-URL, keinen WHIP-Token und kein Providersecret.
- Consent, Lease, Grant, Health und capability-basierte Endpoints tragen enge
  Zeitgrenzen. Ihre Nutzung wird zusätzlich gegen die aktuelle Serverzeit und
  den aktuellen Scope geprüft.
- Actions sind geschlossene Enums. Weder ein unbekannter Action-String noch ein
  Adaptername kann Room-, Membership- oder Decrypt-Rechte erfinden.

## Serverseitige Grenze

Die Servergrenze bleibt auf drei kleine, getrennte Ports verteilt:

- [`broadcast-contracts.js`](../../src/broadcast-contracts.js) begrenzt mit
  `parseBroadcastContract()` Wire-JSON vor dem Parsen auf 32 KiB,
  akzeptiert nur bekannte v1-Typen und liefert tief eingefrorene Objekte;
- [`broadcast-aggregate.js`](../../src/broadcast-aggregate.js) prüft mit
  `validateBroadcastAggregate()` tenant-/room-/program-/epochgleiche
  Referenzen, Consent, Sichtbarkeit, genau einen aktiven Writer pro Rolle und
  tatsächlich runtime-geprüfte Delivery-Capabilities;
- [`broadcast-transitions.js`](../../src/broadcast-transitions.js) fordert mit
  `assertBroadcastTransition()` eine exakt nächste Revision, dieselbe
  Identität und Epoch sowie einen erlaubten Lifecycle-Schritt.

Die Funktionen sind noch an keinen HTTP- oder WebSocket-Endpunkt angebunden.
Diese Trennung ist beabsichtigt: TBP-006 führt erst die zustandsbesitzende
Domain ein und TBP-007/TBP-008 ergänzen Autorisierung und Signaling-Verträge.

## State-Maschinen

Die wichtigsten terminalen Regeln sind:

- Program: `draft → preparing → awaiting_consent → publishing → live → stopping → stopped`;
  `degraded` und `failed` besitzen nur explizite Recoverypfade, `stopped` bleibt
  terminal. Publication verwendet den kleineren Pfad
  `planned → starting → live → stopping → stopped`.
- Source: `selected → active → ended|revoked`; `ended` und `revoked` bleiben
  terminal.
- Endpoint: `provisioning → ready → active → draining → stopped`; Fehler- und
  frühe Stopppfade sind explizit, `stopped` bleibt terminal.
- Consent, Lease und Grant beginnen aktiv/issued und können nur widerrufen,
  freigegeben, konsumiert, verloren oder abgelaufen werden. Ein alter Status
  kann nicht reaktiviert werden.
- Caption: `planned → active → stopped`; ein Fehler darf nur kontrolliert zu
  `active` oder `stopped` wechseln.

Eine unveränderte State-Angabe mit exakt nächster Revision ist für reine,
schemaerlaubte Metadatenänderungen zulässig. Cross-Tenant, Cross-Room,
Cross-Program, falsche Epoch, Revisionssprung und Rückkehr aus terminalen
Zuständen werden abgewiesen.

## Fixtures und Tests

[`fixtures/contract-fixtures.v1.json`](fixtures/contract-fixtures.v1.json)
enthält pro Familie ein gültiges Minimalobjekt, ein gültiges Vollobjekt und
einen gezielten Negativpatch. `test/broadcast-contracts.test.js` kompiliert
alle Schemas im strikten JSON-Schema-2020-12-Modus und prüft zusätzlich:

- Unknown Type, Unknown Field, inkompatible Version und Oversize;
- Subject-/Principal-, Tenant-, Room-, Program- und Epoch-Mismatch;
- Ablauf, Not-before und Zeitreihenfolge;
- Cross-Referenzen, Consent, Capability, Sichtbarkeit und Writer-Fencing;
- erlaubte und verbotene Zustandsübergänge;
- Abwesenheit von Token-, Secret-, SDP-, ICE-, Caption-Text- und
  Medienpayloadfeldern.
