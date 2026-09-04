# ADR 0002: MoQ Secure Objects bleibt eine getrennte Experimentalstufe

- Status: angenommen für Forschung, nicht für Produktion
- Datum: 2026-09-04
- Todo: `TBP-028`
- Entwurfsbasis: `draft-ietf-moq-secure-objects-01` vom 6. Juli 2026

## Kontext

Der interaktive Raum besitzt bereits SFrame-Frame-E2EE. Der bewusst
entschlüsselte Broadcast-Zweig endet dagegen an einem Own-Source- oder
Trusted-Program-Packager und erzeugt H.264/AAC für LL-HLS. TLS schützt diesen
Zweig auf den einzelnen Transportstrecken, macht Gateway oder CDN aber nicht
kryptografisch blind.

Der IETF-Entwurf [Secure Objects draft-01](https://datatracker.ietf.org/doc/draft-ietf-moq-secure-objects/)
beschreibt Ende-zu-Ende authentifizierte Verschlüsselung einzelner MoQT-
Objekte zwischen Original Publisher und End Subscriber. Relay-Knoten sollen
den Payload nicht entschlüsseln können, behalten aber für Store-and-forward
benötigte Metadaten. Der Entwurf ist Work in Progress, läuft am 7. Januar 2027
ab und referenziert intern noch MOQT draft-18. Das Projekt pinnt unabhängig
davon MOQT draft-20. Daraus folgt ausdrücklich keine derzeitige
Wire-Interoperabilität.

## Entscheidung

Secure Objects bleibt ein eigener, standardmäßig deaktivierter
Experimentaladapter. Es ersetzt weder SFrame im Raum noch TLS/QUIC und wird
nicht als vorhandene Broadcast-E2EE-Produkteigenschaft beworben.

`src/moq-secure-objects-prototype.js` bildet nur einen überprüfbaren
kryptografischen Kern nach:

- draft-01 und die dort verpflichtende Suite
  `AES_128_GCM_SHA256_128` (`0x0004`) sind fest gepinnt;
- Track-Basisschlüssel leiten mit HKDF-SHA-256 getrennte Schlüssel und
  96-Bit-Salts aus serialisiertem Full Track Name, Cipher Suite und Key ID ab;
- Group ID (64 Bit) und Object ID (maximal 32 Bit) bilden den Nonce-Counter;
- Group, Object, Publisher-Priorität, Key ID und öffentliche immutable
  Properties sind AEAD-Additional-Data;
- Payload und private Properties sind verschlüsselt und durch den vollen
  128-Bit-GCM-Tag authentisiert;
- doppelte `(Key ID, Group ID, Object ID)` beim Sender und Replay beim Empfänger
  werden verworfen;
- Schlüssel besitzen Zeitfenster, ein konservatives Invocation-Limit,
  explizite Rotation/Revoke und werden bei Device-Loss/Destroy überschrieben.

Der Prototyp ist **keine vollständige Draft-Implementierung**: Er besitzt
keinen MoQT-Wireadapter, keinen Catalogschutz, kein standardkonformes
Key-Distribution-Protokoll, keine Padding-Property, keine extern geprüften
Testvektoren und keine Browserintegration. Seine kanonische Behandlung
zusätzlicher immutable Properties ist projektintern und darf nicht als
Interoperabilitätsnachweis dienen.

## Abgrenzung zu SFrame

| Thema | Interaktives SFrame | MoQ Secure Objects |
| --- | --- | --- |
| Einheit | codiertes Medienframe | vollständiges MoQT-Objekt |
| Nonce/Counter | SFrame-KID und Counter im Medienpfad | Key ID plus Group-/Object-ID aus MoQT |
| Authentisierte Metadaten | SFrame-Header/Codec-Kontext | Track, Group, Object, Priorität, immutable Properties |
| Zwischenknoten | Blind-Agent leitet Frames weiter | Relay darf Ciphertext speichern und verteilen |
| ABR | Sender-/Relay-Layer nach vorhandener Raumtopologie | getrennte verschlüsselte Rendition-Tracks möglich |
| Random Access | Keyframe plus aktueller SFrame-Kontext | Group-/Object-Grenze, Catalog und aktueller Track-Key nötig |
| Trust-Ende bei Komposition | Trusted Relay/Endpunkt entschlüsselt | Trusted-Packager entschlüsselt Quellen vor neuer Programmverschlüsselung |

Wenn ein Trusted-Packager fremde Quellen mischt oder transcodiert, endet die
Quell-SFrame-Sicherheit an diesem Packager. Optionales Secure Objects beginnt
danach mit einem **neuen Programmschlüssel und neuem Trust-Kontext**. Der
Packager bleibt für die ausgewählten Quellen vertrauenswürdig und darf niemals
als blindes Relay bezeichnet werden.

## Metadaten und Relay-Cache

Auch Secure Objects verbirgt nicht alles. Relay/Provider sieht mindestens
Verbindungszeitpunkt und -adresse, Namespace-/Trackrouting soweit nicht separat
geschützt, Key ID, Group-/Object-Folge, Priorität, Ciphertextlänge, Timing,
Abrufmuster und Publikumslast. Ein Catalog kann zusätzlich Codec-, Rendition-
und Programminformation verraten. Padding kann Größenanalyse reduzieren, ist
aber kein vollständiger Schutz gegen Timing- und Traffic-Analyse.

Ciphertextobjekte dürfen gecacht und an viele Abonnenten verteilt werden,
solange der Full Object ID unveränderlich bleibt. Individuelle ABR-Auswahl
erfolgt über getrennte Rendition-Tracks. Ein Relay kann weiterhin Objekte
verzögern, neu ordnen oder vollständig unterdrücken; AEAD verhindert das nicht.
Monotone IDs und End-of-Group/-Track helfen nur bei partieller
Lückenerkennung.

## Schlüssel- und Entitlement-Modell

Für eine spätere Runtime gilt folgende Mindestentscheidung:

1. Der Original Publisher beziehungsweise Trusted-Program-Packager erzeugt
   zufällige Track-Basisschlüssel lokal. Gateway, Relay, CDN, Logs und URLs
   erhalten sie nie.
2. Die Control Plane autorisiert Viewer anhand Tenant, Program, Epoch,
   Audience, OIDC und Gerät, besitzt aber keinen Klartextschlüssel.
3. Ein noch zu entwerfender Key Distributor verpackt den Track-Key an einen
   separaten nicht exportierbaren Viewer-ECDH-Schlüssel. Die vorhandene
   Signaturidentität wird nicht ohne formalen Nachweis als ECDH-Schlüssel
   umgedeutet.
4. Key ID ist innerhalb des Namespace eindeutig. Programm-/Policy-Epoch,
   Zeitintervall, Invocation-Grenze, Rollenwechsel und Geräteverlust lösen
   Rotation aus.
5. Late Join erhält standardmäßig nur den aktuellen Key. Ein optionales
   Rewind-Fenster braucht explizite Policy und separat verpackte alte Keys.
6. Revocation wirkt für neue Objekte durch Rotation. Bereits an ein Gerät
   ausgelieferte alte Schlüssel und gespeicherter Klartext können technisch
   nicht zurückgerufen werden.
7. Logout/Leave/Destroy entfernt erreichbare Key-Handles; verlorene Geräte
   werden gesperrt und erzwingen eine neue Epoch. Backup, Recovery und
   Mehrgerätebetrieb benötigen eine eigene bewusste Policy.

MLS, ein Hardware-/OS-Keystore oder ein externer KMS sind mögliche Bausteine,
aber nicht durch diese ADR ausgewählt. Kein Langzeitsecret darf in Local
Storage, URL, Provider-Control-Plane oder Telemetrie landen.

## Sicherheits- und Betriebsgrenzen

- Der Prototyp läuft nur mit `enabled: true` in einem expliziten lokalen
  Kontext; es gibt kein Runtime-Feature-Flag, das ihn heute öffentlich macht.
- Maximal 1 MiB Payload, 4 KiB private/immutable Properties und höchstens eine
  Million Verschlüsselungen pro Key sind harte Projektgrenzen. Produktion muss
  aus Codec-/Objektrate und der dann aktuellen AEAD-Limitanalyse eine deutlich
  begründete Rotationsschwelle ableiten.
- Auth-Fehler liefern einen einheitlichen Code. Ein reales System muss
  zusätzlich Fehler-Timing, Fan-out-Forgery-Raten und DoS durch unbekannte Key
  IDs begrenzen.
- Browser-WebCrypto kann HKDF und AES-GCM grundsätzlich bereitstellen. Das
  beweist weder sichere Key-Verteilung noch MoQT-/LOC-Wirekompatibilität,
  Worker-Isolation, konstantes Fehlerverhalten oder mobile Leistung.

## Verifikation und Freigabegate

Unit-Tests belegen Roundtrip, Ciphertextblindheit der Relayfunktion,
Manipulation von Payload/Priorität/Group/Object/immutable Properties,
Nonce-Reuse, Replay, Rotation, Late Join, Revocation, Geräteverlust,
Object-ID-Breite, Invocation-Limit und default-off. Noch erforderlich sind:

- Abgleich gegen veröffentlichte draft-01-Testvektoren und mindestens eine
  unabhängige Implementierung;
- separate Security-/Kryptografiereview;
- browserseitige nicht exportierbare Schlüssel und isolierte Worker;
- Catalog-/Key-Package-Contracts, MLS/KMS-Entscheidung und Metadatenreview;
- reale Publisher–Relay–Subscriber-Tests mit mehreren Renditions, Rotation,
  Verlust, Late Join und HLS-Fallback.

Bis alle Gates grün sind, bleiben Capability, UI-Schalter und Deployment aus.

## Folgen

Positiv ist, dass ein künftiger MoQ-Relay Medienobjekte verteilen könnte, ohne
ihren Inhalt zu kennen, und Manipulation authentisierter Felder erkannt wird.
Negativ steigen Schlüsselmanagement, Objektlatenz, Browserkomplexität,
Fehlerflächen und der Aufwand für Random Access/ABR erheblich. LL-HLS bleibt
der interoperable Basispfad; private HLS-Autorisierung ist kein E2EE-Ersatz.
