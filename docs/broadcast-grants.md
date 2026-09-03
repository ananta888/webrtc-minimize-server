# Kurzlebige Broadcast-Grants

TBP-007 ergänzt eine serverseitige Autorisierungsgrenze für Publisher,
Trusted-Packager und Zuschauer. Sie ist noch nicht an einen öffentlichen HTTP-
oder Medienendpunkt angeschlossen und aktiviert deshalb weder WHIP noch
Playback. Ihr Zweck ist, vor der späteren Adapterintegration eine kleine,
fail-closed Grant-Schnittstelle festzulegen.

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
6. Erst danach greifen die aktiven Quoten pro Subject, Tenant und Programm und
   die Authority signiert einen kurzlebigen ES256-Grant.

OIDC-Issuer und Subject werden für Broadcast-Contracts mit SHA-256 in stabile,
opaque `tenantId`-/`subjectRef`-Werte überführt. Der Gerätefingerprint wird
ebenfalls als `deviceRef` pseudonymisiert. Rohe Tokens oder OIDC-Claims sind
keine Bestandteile der versionierten Broadcast-Contracts.

## Token- und Pfadbindung

Publisher- und Packager-Grants laufen standardmäßig nach 60 Sekunden ab und
sind genau einmal verwendbar. Playback-Grants laufen standardmäßig nach 120
Sekunden ab und können innerhalb ihrer kurzen Laufzeit für die erlaubten
Manifest-/Segmentaktionen wiederverwendet werden. Keine konfigurierte Laufzeit
darf fünf Minuten überschreiten; das OIDC-Ablaufdatum bildet immer die engere
Obergrenze.

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
