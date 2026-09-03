# Broadcast-Audience- und Directory-Policy

TBP-008 trennt die Sichtbarkeit eines Broadcast-Programms ausdrücklich von
der Sichtbarkeit des interaktiven Raums. Die Domain-Komponenten sind noch nicht
an öffentliche HTTP-Endpunkte oder einen Player angeschlossen. Sie aktivieren
keinen Medienpfad und verändern die bestehende Raumoberfläche nicht.

## Drei Broadcast-Sichtbarkeiten

| Broadcast-Sichtbarkeit | Im Broadcast-Verzeichnis | Zuschauerregel |
| --- | --- | --- |
| `private` | nein | OIDC-authentifiziert und explizit serverseitig berechtigt |
| `unlisted` | nein | OIDC-authentifiziert und explizit serverseitig berechtigt |
| `public` | ja | gemäß `required`, `optional` oder `none`; anonym nur bei explizitem `anonymousAllowed` |

`private` und `unlisted` erzwingen im v1-Contract `authentication=required`,
`directoryListed=false` und `anonymousAllowed=false`. `public` erzwingt
`directoryListed=true`; eine anonyme Freigabe muss zusätzlich konsistent zur
Authentifizierungsregel gesetzt werden. Optional kann eine Liste gehashter,
erlaubter Origins den Viewerzugriff weiter einschränken.

Ein privater Raum darf nach einem bewussten, berechtigten Broadcast-Schritt ein
öffentliches Programm besitzen. Das macht ausschließlich die ausgewählten
Programmausgaben öffentlich. Es ändert weder den Room-Invite noch
Room-Membership, Raumverzeichnis, Peer-Liste, Chat oder SFrame-Schlüssel. UI und
spätere HTTP-Routen müssen deshalb immer die Bezeichnung
`Broadcast-Sichtbarkeit` verwenden und dürfen sie nicht als Raumfreigabe
darstellen.

## Atomarer Policy-Wechsel

`BroadcastAudienceRegistry.changeVisibility()` akzeptiert nur geschlossene,
idempotente v1-Kommandos und eine aktuelle serverseitige Rollenprojektion. Ein
erfolgreicher Wechsel:

1. prüft Tenant, Raum, Subject, Rolle und Membership-Epoch;
2. prüft erwartete Programmrevision, Program-Epoch und Policy-Revision;
3. erhöht Programmrevision, Program-Epoch, Lease-Epoch und Policy-Revision;
4. widerruft alle Grants der vorherigen Program-Epoch über einen kleinen
   synchronen Revocation-Port;
5. veröffentlicht erst danach den gemeinsam validierten Programm-/Policy-
   Snapshot und die neue Directory-Sicht.

Writer der alten Epoch werden gefencet und müssen neu autorisiert werden. Alte
Manifest- oder Segmententscheidungen passen weder zur neuen Policy-Revision
noch zur neuen Program-Epoch. Scheitert der Revocation-Port, wird kein neuer
Snapshot sichtbar; ein bereits erfolgter Teilwiderruf bleibt dabei bewusst
fail-closed. Wiederholungen desselben Idempotency-Keys erzeugen weder eine
weitere Revision noch einen zweiten Widerruf.

## Serverseitige Rollen

Rollen sind keine Clientangaben. Owner, Moderator, Presenter und Packager
müssen aus einer aktiven, epochgleichen Room-Membership-Projektion stammen;
Viewer stammen aus der getrennten Broadcast-Audience-Projektion.

| Aktion | Owner | Moderator | Presenter | Packager | Viewer |
| --- | --- | --- | --- | --- | --- |
| Programm starten/sofort stoppen | ja | ja | nein | nein | nein |
| Broadcast-Sichtbarkeit ändern | ja | ja | nein | nein | nein |
| Quelle publizieren/widerrufen | ja | ja | nur eigene | nein | nein |
| Packager-Handoff | ja | ja | nein | nein | nein |
| Packager betreiben | ja | nein | nein | ja | nein |
| Viewer erlauben/sperren | ja | ja | nein | nein | nein |
| Broadcast ansehen | ja | ja | ja | ja | ja |

Der Owner-Claim ist zusätzlich an das exakte `ownerSubjectRef` des Programms
gebunden. Ein Presenter kann keine fremde Quelle unter seiner Rolle
widerrufen. Der vorhandene `stop`-Befehl der Broadcast-State-Machine bleibt der
idempotente Sofort-Stopp; die Rollenpolicy entscheidet davor, wer ihn auslösen
darf.

## Directory und nicht enumerierbare Viewerfehler

Das öffentliche Broadcast-Verzeichnis liefert ausschließlich:

- Contract-Version und Typ `broadcast-directory-entry`,
- opaque Broadcast-Program-ID,
- freigegebenen Programmtitel,
- explizite `broadcastVisibility=public`,
- groben Zustand `live` oder `degraded`.

Room-ID, Tenant-ID, Owner-/Teilnehmerreferenzen, Viewerzahlen und Zeitstempel
werden nicht ausgegeben. Private, unlisted, vorbereitende, gestoppte und
fehlgeschlagene Programme erscheinen nicht.

Eine wohlgeformte unbekannte Program-ID, eine vorhandene private ID ohne
Berechtigung, falsche Origin sowie alte Policy-/Program-Epochen führen alle zu
demselben `404 broadcast_not_available`. Die Viewergrenze wartet für jeden
wohlgeformten Erfolgs- und Fehlerpfad mindestens 20 ms. Ein späterer HTTP-
Adapter muss dieses generische Body-/Header-/Cache-Verhalten und die gemeinsame
Zeitpolsterung unverändert übernehmen; interne Fehlerursachen dürfen nicht in
Antworten oder Analyseevents gelangen.

## Playback-only bedeutet keine Raumteilnahme

Eine erfolgreiche Viewerentscheidung ist kurzlebig und erlaubt nur
`playback:manifest` und `playback:segment`. Sie enthält keine Membership,
Peer-ID, Session-Ticket-, Signaling-, Chat-, Capture-, Publish- oder
SFrame-Berechtigung. Auch ein authentifizierter Viewer wird dadurch nicht auf
die 20 Room-Mitglieder angerechnet. Die spätere durchgängige Absicherung aller
HLS-Objekte und Browservarianten folgt in TBP-022.

Die Registry hält Programm-/Policy-Snapshots und die aktuelle private
Viewer-Zuordnung zunächst im Speicher. Persistenz, HA und Backup sind spätere
Tracks; ein Neustart darf keine alte Berechtigung aus implizitem UI-State
wiederherstellen.

## Verifikation

`test/broadcast-audience-registry.test.js` prüft alle drei Sichtbarkeiten,
Revision/Epoch/Revocation, Idempotenz, atomaren Fehlerfall, minimales Directory,
private/unlisted ACL, anonyme Public-Policy, Originbindung, generische gepolsterte
Fehler, die komplette Rollenmatrix und die Unabhängigkeit des bestehenden
`RoomDirectory`. Der State-Machine-Test prüft den Policy-Wechsel zusätzlich als
reinen, epochgetrennten Domain-Befehl.
