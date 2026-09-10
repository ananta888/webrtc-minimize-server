# Kurzlebige Broadcast-Grants

TBP-007 und TBP-022 bilden die serverseitige Autorisierungsgrenze für Publisher,
Trusted-Packager und Zuschauer. Playback ist über den gleichursprünglichen
HLS-Proxy angeschlossen; der rohe Grant wird dort einmalig gegen eine
pfadgebundene HttpOnly-Cookie-Sitzung getauscht und gelangt nie in eine URL.

## Vertrauenskette

Die Ausgabe eines Grants ist nur nach dieser Reihenfolge möglich:

1. Der bestehende OIDC-Verifier prüft Signatur, exakten Issuer, erlaubten
   Algorithmus, Audience, Ablauf und Subject des Access Tokens.
2. Die Grant-Policy bindet diese verifizierte Identität an den aktuellen
   Tenant sowie eine aktive Room-Membership und eine für die Grant-Art erlaubte
   Rolle.
3. Ein frischer P-256-Gerätebeweis bindet die Anfrage an Raum, Programmrevision,
   Program-Epoch, Grant-Art, Token-Audience, Empfänger, Ressource, Pfad-Hash und
   Aktionen. Nonces sind kurzlebig und nur einmal verwendbar.
4. Publisher und Packager werden gegen den aktuellen Programmzustand geprüft.
   Ein Trusted-Packager benötigt zusätzlich aktive, nicht abgelaufene
   `decrypt-source`-, `compose-program`- und `publish-program`-Consents für alle
   Programmquellen und genau sein registriertes Gerät.
5. Playback benötigt die exakt aktuelle Viewer-Policy samt Revision und
   identischer Programmsichtbarkeit.
6. Vor der Signatur reserviert die Authority die Grant-ID sowie einen Platz in
   den Quoten pro Subject, Tenant und Programm. Nach der ES256-Signatur prüft
   sie Schlüsselgeneration, Programm-Epoch und Widerruf erneut vor der Ausgabe.

### Steuerung einer laufenden WHIP-Sendung

Publisher und Trusted-Packager können für ein bereits `live` geschaltetes
Programm genau einen `whip:update`- oder `whip:delete`-Grant anfordern. Die
frühere pauschale Zustandsprüfung lehnte diese Steuerung mit 403 ab, obwohl die
Runtime sie vorsah. `live` erlaubt weiterhin weder `whip:create` noch
`moq:publish`; auch Update und Delete zusammen bleiben verboten. Jeder
Publisher-/Packager-Grant enthält unverändert genau eine Aktion und ist nur
einmal verwendbar.

| Programmzustand | Publisher-/Packager-Aktionen |
| --- | --- |
| `preparing`, `publishing`, `degraded` | Bisherige einzeln erlaubte Publikations- und Steueraktionen, unverändert |
| `live` | Ausschließlich ein einzelnes `whip:update` oder `whip:delete` |
| `draft`, `awaiting_consent`, `stopping`, `stopped`, `failed` | Keine Publisher-/Packager-Grant-Ausgabe |

OIDC, aktuelle Membership, Rollen, P-256-Gerätenachweis, Programmrevision und
Epoche, Ressourcenpfad, Quoten, Deadline sowie vollständiger Packager-Consent
bleiben erforderlich. Steuerrechte erzeugen keinen neuen Ingress-URL und
verändern allein weder den Programmzustand noch dessen Laufzeit. Ein erteilter
oder verbrauchter Delete-Grant beweist noch keine physische Gateway-Abschaltung.

Vor der Korrektur scheiterten vier Live-Policy-Regressionsgruppen und der echte
HTTP-Updatepfad trotz kryptografisch geprüftem OIDC-/Gerätenachweis. Nach der
Korrektur bestehen 73 gezielte Node-/HTTP-/P-256-/JWT-/Laufzeitprüfungen in
0,628 Sekunden. Die Matrix umfasst beide Grant-Arten, neun Zustände und sieben
Aktionsauswahlen einschließlich weiterhin abgewiesener Kombinationen. Der
HTTP-Fall prüft Challenge-Einmaligkeit, Live-Update und -Delete, falsche Aktion
und Ressource, Gateway-Einmalverbrauch, Membershipverlust und Programmstop.
Er verwendet einen ephemeren lokalen OIDC-Issuer und keinen Browser oder
Medienprozess; ein echter MediaMTX-DELETE und dessen Ressourcenfreigabe bleiben
ein separater Integrationsnachweis.

OIDC-Issuer und Subject werden für Broadcast-Contracts mit SHA-256 in stabile,
opaque `tenantId`-/`subjectRef`-Werte überführt. Der Gerätefingerprint wird
ebenfalls als `deviceRef` pseudonymisiert. Rohe Tokens oder OIDC-Claims sind
keine Bestandteile der versionierten Broadcast-Contracts.

## Parallelität und Widerruf während der Signatur

Ausstehende Signaturen zählen zusätzlich zu aktiven Grants. Ihre reservierten
IDs sind eindeutig, aber noch nicht als ausgestellte Grants oder Gatewayrechte
sichtbar. Auch eine abgebrochene oder inzwischen abgelaufene Signatur belegt
ihren Platz bis zu ihrem tatsächlichen Ende; Pruning darf keinen weiteren
Signaturauftrag an diesem Ressourcenlimit vorbeischleusen. Ein Fehler gibt
genau diese Reservierung frei, ohne einen Grant-Record zu hinterlassen.

Ein einzelner Widerruf kann bereits die reservierte Grant-ID sperren.
Programm-Epoch-Widerruf oder erfolgreiche Schlüsselrotation während der
Signatur verhindern ebenso die nachträgliche Ausgabe. Ein ungültiger oder
doppelter Rotationsauftrag verändert die laufende Schlüsselgeneration nicht.
Unverändert prüft jeder Gatewayzugriff die Signatur, den aktuellen Record,
Ablauf und exakten Scope. Diese Reservierungen begrenzen Parallelität; sie
führen keinen neuen externen Signaturdienst oder eine Garantie seiner Laufzeit
ein. Der Publisher-Start besitzt zusätzlich seine eigene begrenzte Transaktion.

Sieben Regressionen reproduzierten vor der Korrektur unter anderem zwölf
gleichzeitig ausgestellte Grants bei einer Quote von eins. Zehn neue Race- und
Fehlerprüfungen decken die Reservierung, doppelte IDs, Rotation, Widerruf,
Pruning und Freigabe nach Signaturfehler ab. Ein verspäteter echter JWT bleibt
am Gateway unbrauchbar, während ein frischer Nachfolger weiterhin funktioniert.
Die gemeinsame browserfreie P-256-/JWT-/HTTP-/Runtime-/Quoten-/Playback-Matrix
besteht mit 63 Tests in 0,468 Sekunden. Das ersetzt weder Live-JWKS-/TURN-Prüfung
noch Produktionsabnahme; TBP-033 bleibt offen.

## Token- und Pfadbindung

Die Programm-ID aus `POST /api/broadcasts/{programId}/playback` ist an der
Runtimegrenze verpflichtend. Sie muss zur Challenge passen, bevor diese
verbraucht oder ein Grant signiert wird. Auch der ursprüngliche authentisierte
Principal muss passen; eine anonyme Challenge kann ausschließlich im anonymen
Pfad eingelöst werden. Eine falsche Programm-URL oder Identität lässt die
legitime Challenge unberührt. Ein ungültiger Gerätebeweis bei korrekt gebundenem
Scope verbraucht dagegen weiterhin den einmaligen Versuch.

`test/broadcast-playback-path-http.test.js` prüft diese Grenze über echtes HTTP,
ephemere kryptografisch verifizierte OIDC-Identitäten sowie echte P-256-Beweise
und JWT-Grants für private und anonym öffentliche Programme. Vor der Korrektur
stellten vier URL-Negativfälle trotz HTTP 404 einen Grant aus; zwei
Identitäts-Negativfälle verbrauchten unberechtigt die Challenge. Die Fixtures
setzen ausschließlich Control-Plane-Zustände, ohne Medien oder Packagerprozess.

Publisher- und Packager-Grants laufen standardmäßig nach 60 Sekunden ab und
sind genau einmal verwendbar. Playback-Grants laufen standardmäßig nach 120
Sekunden ab und können innerhalb ihrer kurzen Laufzeit für die erlaubten
Manifest-/Segmentaktionen wiederverwendet werden. Keine konfigurierte Laufzeit
darf fünf Minuten überschreiten; das OIDC-Ablaufdatum bildet immer die engere
Obergrenze.

Ein laufender Player erneuert seine kurze Sitzung vor Ablauf ohne erneute
Medienfreigabe. Dazu erzeugt der Browser einen neuen, nicht exportierbaren
P-256-Gerätebeweis und sendet den neuen Playback-Grant ausschließlich im
Authorization-Header an `PUT /api/broadcast/playback-sessions/{id}`. Der Server
akzeptiert die Rotation nur mit dem vorhandenen exakten Cookie und bei
identischem Tenant, Audience, Gerät, Raum, Programm, Program-Epoch, Ressource
sowie Policy-ID/-Revision. Die pseudonyme Audience bleibt auch bei anonymem
Playback gebunden; dasselbe Gerät allein erlaubt keinen Wechsel des
Sitzungseigentümers. Nach
Visibility-/Epoch-Wechsel, Widerruf, Programmende, falschem Cookie oder
abweichendem Scope schlägt die Erneuerung nicht unterscheidbar mit 404 fehl und
der Player räumt seine lokale Sitzung auf.

Damit der Medien-Cookie nicht auf die gesamte Anwendung erweitert werden muss,
setzt der Austausch zwei gleichnamige Secure-/HttpOnly-/SameSite-Strict-Cookies:
einen ausschließlich unter `/broadcast/play/<resource>/` und einen
ausschließlich unter dem exakten Playback-Session-Endpunkt. Rotation und Close
aktualisieren beziehungsweise löschen beide Pfade; andere API-Routen erhalten
keinen dieser Cookies.

Jeder Grant ist gebunden an:

- Signatur-Key und dessen Generation;
- Token-Audience und pseudonymen Aussteller-/Empfänger-/Gerätekontext;
- Tenant, Raum, Programm, Programmrevision und Program-Epoch;
- genau erlaubte Aktion beziehungsweise Playback-Aktionsmenge;
- opaque Ressource und einen normalisierten Pfadpräfix;
- bei Playback zusätzlich Policy-ID und Policy-Revision.

Der rohe Pfadpräfix bleibt in der serverseitigen Grant-Registry. Token und
Contract tragen nur dessen SHA-256-Hash und eine opaque Ressourcenreferenz.
Traversal, Backslashes, doppelte oder codierte Slashes, Query, Fragment und
Steuerzeichen werden vor der Autorisierung abgewiesen.

Die spätere HTTP-/Gateway-Grenze darf den Token ausschließlich als strikten
`Authorization: Bearer …`-Header annehmen. Query-Parameter, Redirect-URLs,
Referer, Signaling-Nachrichten und allgemeine Analyseevents sind keine
zulässigen Tokenkanäle. Fehlercodes und Inventaransichten enthalten ebenfalls
kein Token- oder Schlüsselmaterial.

## Widerruf, Rotation und Betrieb

Die Authority hält aktuell ein begrenzbares In-Memory-Register ausgestellter
Grants. Dadurch wirken expliziter Grant-Widerruf, Program-Epoch-Widerruf,
Einmalverbrauch und Key-Rotation sofort und nicht erst beim JWT-Ablauf. Ein
Prozessneustart verwirft das Register; persistente beziehungsweise verteilte
HA-Semantik wird erst mit dem späteren Store-/Operations-Track eingeführt.

ES256-Private-Keys, Provider-Langzeit-Secrets und Gateway-Control-Credentials
werden ausschließlich zur Laufzeit serverseitig injiziert. Sie gehören weder
in Browsercode noch in Contracts, Logs oder versionierte Konfigurationsdateien.
Das öffentliche Key-Inventar zeigt nur Key-ID, Generation sowie
`active`/`enabled`. Rotation widerruft alle noch aktiven Grants; ein alter Key
kann anschließend deaktiviert und sein privater Anteil aus dem erreichbaren
Authority-State entfernt werden.

Öffentliches oder anonymes Playback wird durch die Grant-Schicht allein nicht
freigeschaltet. Die getrennte
[Broadcast-Audience-Policy](broadcast-audience-policy.md) entscheidet
Sichtbarkeit und Viewerzugriff; die spätere HTTP-/Player-Integration verbindet
diese Entscheidung mit der Grant-Ausgabe. Viewerentscheidungen erzeugen dabei
niemals Room-Membership, Peer-IDs, Signaling-Tickets, Chat-, Capture- oder
SFrame-Rechte.

## Verifikation

`test/broadcast-grant-authority.test.js` prüft Ausgabe und Nutzung sowie
Negativfälle für OIDC-Attestation, Membership/Rollen, Gerätebindung,
Consent-Abdeckung, Quoten, Replay, falsche Audience, Tenant, Raum, Programm,
Epoch, Gerät, Aktion und Pfad, Ablauf, Einzelverbrauch, expliziten Widerruf,
Epoch-Widerruf, Key-Rotation und Key-Deaktivierung.
`test/broadcast-playback-session-store.test.js`,
`test/server.integration.test.js` und die Angular-Tests des Playback-Gateways
prüfen zusätzlich Cookie-Besitz, Header-only-Rotation, unveränderten Scope,
Gerätewechsel, Ablauf und Cleanup der erneuerten Sitzung.
