# Native Trusted-Source-Ingress

## Aktueller Implementierungsstand

`native-broadcast-packager/internal/trustedsframe` ist der getrennte
Entschlüsselungsbaustein für eine später ausdrücklich consentierte einzelne
Quelle. Der ergänzte `Receiver` verbindet einen zielgebundenen ephemeren
P-256-Key-Envelope mit genau einem Decoder. Ein separater nativer
PeerConnection-/Key-DataChannel-/RTP-Adapter ist jetzt implementiert und lokal
mit zwei echten Pion-Verbindungen getestet; **der Produktions-Compositor ist
noch nicht angeschlossen**.
Der neue `SourceReceiver` ergänzt einen kurzlebigen Source-Lease und Key-ACK;
der native Daemon besitzt dafür bereits den lokalen Assignment-/Geräte-/Room-
Policy-Adapter, Cleanup-Hooks und den unten beschriebenen authentisierten
Source-Control-Pfad. Die zusätzliche serverseitige Quellen-Signalisierung und
der geschlossene native Signalparser sind mit diesem Adapter verbunden.
Der produktive Browser-Publisher und die Compositor-Integration fehlen noch.
Eine Quellenanfrage in der Angular-App erteilt weiterhin keine Medienfreigabe.
Der bestehende `clear-program-v1`-Ingress bleibt unverändert; der
Blind-Media-Agent und die Node-Control-Plane erhalten keinen Decrypt-Port.

## Decoder-Grenze

Ein Decoder gehört genau einer autorisierten Publikation, einem ausgehandelten
Codec und einer unveränderlichen Consent-Laufzeit. Zulässig sind ausschließlich
`codec-prefix-v1`, `video/vp8` oder `audio/opus`. Er nimmt vollständige
depacketisierte Encoded Frames entgegen, keine RTP-Pakete. VP8-Key-/Delta-Präfixe
und das Opus-TOC werden zusammen mit dem Envelope und kanonischen SFrame-Header
authentisiert; erst danach wird Klartext ausgegeben. Unbekannte KIDs,
Manipulation, Replay oder Ablauf erzeugen ausschließlich geschlossene
Fehlercodes, keinen Klartext-Fallback.

Grenzen: 4 MiB pro Frame, vier gleichzeitige KIDs, 512 historische KIDs pro
Decoder, 128 Counter Replay-Fenster, maximal 60 Sekunden pro Schlüssel und
zehn Minuten pro umgebendem Consent. Ein identischer Install-Aufruf erhält das
Replay-Fenster; geänderte Schlüssel oder Laufzeiten für dieselbe KID sind
verboten. Abgelaufene und entfernte KIDs bleiben gesperrt. Clock-Rollback und
Consent-Ablauf schließen den Decoder terminal. Key-Ablauf wird vor jeder
Install-/Decrypt-Operation geprüft; der spätere Lifecycle-Adapter muss zusätzlich
bei Ablauf und Widerruf aktiv `Destroy` aufrufen.

`Remove`/`Destroy` überschreiben erreichbare Basis-/Salt-Arrays und entfernen
Cipher-Referenzen. Das ist **keine** Garantie über Kopien im Go-Runtime-Heap,
GC, Betriebssystem oder Speicherabbildern. Der Aufrufer besitzt ausgegebenen
Klartext und muss dessen begrenzten Lifecycle, Queue-Cleanup und erneute
Autoritätsprüfung vor Übergabe an den Compositor durchsetzen.

## Zielgebundener Schlüssel-Receiver

Der geschlossene [Wire-Vertrag](../contracts/trusted-decrypt/wire.v1.schema.json)
formalisiert die bestehenden Consent-/Announcement-/Key-Envelope-Nachrichten
getrennt vom allgemeinen Broadcast-Domain-Consent. Schema-Konformität ersetzt
keine aktuellen Rechte, Laufzeitprüfung oder kryptografische Verifikation.

`NewReceiver` verlangt neben dem geschlossenen Consent die erwartete
Packager-/Gerätereferenz, den passenden Codec und einen verpflichtenden
lokalen `Authorize`-Port. Dieser muss Quelle, Publication-Epoch, Membership
und aktuellen Writer-Lease gegen serverautorisierte lokale Zustände prüfen.
Ein JSON-Consent allein ist kein Autoritätsnachweis. Der Port wird vor jeder
Announcement-/Install-/Decrypt-Operation und erneut vor der Key-Installation
aufgerufen; Verlust schließt den Receiver terminal. Er darf den Receiver nicht
rekursiv aufrufen. Der `SourceReceiver` und lokale Daemon-Adapter implementieren
diesen Port mit kurzlebigem Source-Lease und laufendem Parent-Assignment.
Der unten beschriebene native Medientransport nutzt ihn vor Key- und
Frame-Annahme sowie erneut vor jeder Ausgabe.

Der Receiver erzeugt einen eigenen ephemeren P-256-Schlüssel pro Consent und
gibt nur das öffentliche `trusted-packager-key`-Announcement aus. Der vorhandene
Browser-Helper verschlüsselt das SFrame-Basismaterial per ECDH/AES-256-GCM.
Native Annahme prüft exakt denselben `trusted-decrypt-key`-AAD einschließlich
Quelle, Tenant, Zielgerät, Raum-/Programmepochen, KID und Laufzeit, bevor das
Material intern in den Decoder gelangt. Annahme liefert nur die KID für den
späteren ACK-Adapter. Unbekannte/fehlende/duplizierte JSON-Felder, ungültige
Kurvenpunkte, zusätzliche private JWK-Felder, nichtkanonisches Base64url,
Replay und mehr als 8 KiB pro Envelope werden abgewiesen. Authentisierungsfehler
verbrauchen keine Key-Slots; die Replay-Historie bleibt auf 512 Einträge begrenzt.

Consent- und Key-Timer räumen auch ohne weitere Medienpakete auf. Timer und
synchrone Zeitprüfung sind kombiniert: verspätete Timerausführung erlaubt keine
Entschlüsselung nach dem geprüften Ablauf. `Destroy` entfernt Timer,
Agreement-Key-Referenz und Decoder-Schlüssel idempotent. Die Go-GC-Einschränkung
oben gilt auch für ECDH- und AES-Zwischenzustände. Ein neu aufgebauter Receiver
darf später nicht unbemerkt alte Source-KIDs wiederverwenden: der Lifecycle-Adapter
muss neue Receiver-/Connection-Generationen mit frischen Quellenschlüsseln binden.

ECDH und authentisierte Metadaten beweisen für sich genommen nicht die Identität
des Absenders: jeder Besitzer des öffentlichen Announcements könnte einen neuen
Envelope für eigene Schlüssel erzeugen. Der Transportadapter muss deshalb vor
`Install` den tatsächlichen Absender an den aktuellen, serverautorisierten
Publisher-Peer und dessen Gerät binden. Ebenso muss der Browser das Announcement
dem autorisierten Packagergerät zuordnen. Ein frei erreichbarer Key-POST-Endpunkt
oder ein vom Aufrufer geliefertes `grantorSubjectRef` genügt ausdrücklich nicht.

## Noch anzuschließen

- Explizite Quellenannahme an den implementierten Source-Control-Broker
  anschließen; bisher gibt es nur dessen internen, erneut autorisierten Prepare.
- Sichtbarer Publisher-Consent und sofortiger unabhängiger Widerruf.
- Den nativen Signalparser an den separaten PeerConnection-Adapter anschließen,
  dann den implementierten zielgebundenen Key-Envelope transportieren und die
  quittierte Schlüsselaktivierung mit dem RTP-Receiver verbinden.
- Begrenztes Depacketizing, Zuordnung zum Audio-/Video-Compositor und Entfernen
  aller zuletzt decodierten Frames bei Widerruf, Source-Ende oder Handoff.

Die vorhandenen Zustandsbesitzer bleiben dabei erhalten: `RoomRegistry.publication`
liefert die aktuelle Track-/Quellenart-/Publication-Epoch-Zuordnung; die
Membership-Epoch gehört zum Signaling-Topologiezustand. Der Broadcast-Runtime
gehören Program-Epoch und Writer-Lease. Die spätere Consent-Anbindung muss diese
aktuellen Werte über kleine Ports zusammensetzen, nicht aus einer Quellenanfrage
oder einem Browser-JSON rekonstruieren. Ein Source-Handle muss die konkrete
Publikationsgeneration binden; Stop und Neustart derselben Kamera dürfen alten
Consent nicht reaktivieren. Die Quellenanfrage selbst bleibt Metadatum ohne
Medienautorität.

## Serverseitige Source-Authority

`TrustedBroadcastSourceGrants` verbindet die interne Resolution einer noch
gültigen Owner-Einladung mit einem separaten expliziten Publisher-Approve.
Der geschlossene [Approve-Vertrag](../contracts/trusted-decrypt/source-approval.v1.schema.json)
enthält nur Einladung, Raum, eigenes Gerät, konkrete Track-ID mit erwarteter
Publication-Epoch und begrenzte Wunschlaufzeit. Tenant, Source-ID, Zielgerät,
Programm-/Membership-Epochen und Writer-Fence stammen aus aktuellen servereigenen
Registries. Die einmalige Source-ID wird serverseitig erzeugt. Das bestehende
Consent-Domainmodell akzeptiert dazu nun auch den tatsächlichen Programmzustand
`live`; ein fremder Programmstatus wird nicht auf einen erlaubten Wert umgedeutet.

`approve(identity, input, actor)` verlangt zusätzlich das echte aktuelle
Publisher-Peer-Objekt aus dem authentisierten Signaling-Callback. Eine aus JSON
rekonstruierte Kopie, ein zweiter Peer desselben Kontos/Geräteprofils oder nur
OIDC plus öffentlicher Fingerprint genügt nicht, auch nicht beim Replay.
Ein späterer Adapter darf diesen Actor niemals durch Nachschlagen der vom
Aufrufer behaupteten IDs ersetzen; entweder stammt er direkt aus dem verbundenen
Socket oder es braucht einen separat geprüften frischen Gerätenachweis.

Die Authority wird im Signaling-Server aufgebaut und verwendet dessen echte
Membership-Epoch—bei fehlendem Topologiezustand gibt es keinen Ersatzwert 1.
Media-State- und Membership-Wechsel prüfen betroffene Berechtigungen sofort;
ein 500-ms-Maintenance-Lauf ergänzt den Ablaufcheck. Jede interne Packager-Abfrage
prüft erneut aktuelle Publikation, beide Teilnehmer-/Gerätebindungen, Writer und
bestätigten Packager-Room-Consent. Stop/Neustart derselben Track-ID, Leave/Rejoin,
Epochwechsel, Handoff und Rechteverlust widerrufen terminal. Programmänderungen
werden konservativ auch über die gebundene Program-Revision erkannt.

Ein ausschließlich interner, nicht als Wire-Token verwendbarer Generation-Handle des
Packager-Control-Registrys erkennt auch Rechteverlust mit anschließender
Wiederfreigabe zwischen zwei Prüfungen. Normale Capability-Erneuerung erhält ihn;
Reconnect, abgelaufene Capability und Wegfall des jeweiligen Room-Consents nicht.
Dieser Handle ist keine ausstellbare Netzwerkberechtigung.

Consent-Replays verlängern keine Laufzeit; Widerruf ist publisher- und
gerätegebunden und benötigt den Moderator nicht. Harte Metadatenbudgets sind
1024 Records, 80 Quellen pro Programm und vier pro Publisher/Programm; terminale
Records behalten bis zum Ende ihrer Aufbewahrungsfrist ihren Quotenplatz.
60 Approve-Aufrufe pro Principal/Minute und höchstens 2048 Rate-Buckets begrenzen
auch idempotente Wiederholungen. Diese Ressourcenbudgets begrenzen nicht die
Anzahl normaler Räume. Audit-Events sind weiterhin auf 512 begrenzt und enthalten
weder Medien, Track-IDs, Klartextidentität noch Schlüssel.

**Noch kein Endnutzer-Approve:** Die Authority ist bislang nur intern aufrufbar.
Die HTTP-/Angular-Quellenanfrage bleibt ohne Medienautorität und besitzt weiterhin
keinen Annahmeknopf. Ihre Zustandsüberführung bei Annahme, transportauthentisierte
Key-/ACK-Nachrichten über den Publisher-DataChannel sowie
aktives Löschen der Compositor-Frames fehlen noch. Source-Control-Prepare und
nativer Lease-Receiver sind inzwischen verbunden. Ein interner Consent mit
`status: active` bedeutet ausdrücklich kein aktives Medien- oder E2EE-Playback.

## Nativer Source-Lease und Receiver

Der getrennte [Source-Lease-Vertrag](../contracts/trusted-decrypt/source-lease.v1.schema.json)
bindet genau einen Consent an Publisher-Peer/Gerät, Track-/Publication-Epoch,
Assignment-ID, Writer-Lease-ID/Fence und VP8 beziehungsweise Opus. Ein Lease
gilt höchstens fünf Sekunden und nie länger als Consent oder lokales Assignment.
Er ist Metadatum vom authentisierten Control-Pfad, kein selbstauthentisierender
Bearer-Token. Der native Adapter `prepareTrustedSource` prüft zusätzlich seine
tatsächliche aus P-256 abgeleitete Gerätekennung, Control-Authentisierung,
lokalen Room-Consent und das konkrete laufende/degradierte Assignment-Objekt.

`SourceReceiver` besitzt den vorhandenen Key-Receiver. Gleiche Lease-Replays sind
idempotent; Renewal erlaubt ausschließlich die nächste Revision sowie verlängerte
Zeitgrenzen innerhalb desselben unveränderten Scopes. Agreement-Key, installierte
SFrame-Keys und Replay-Fenster werden dabei nicht ersetzt. Abgelaufene Leases
können nicht erneuert werden. Ein Consent darf beim nativen Adapter auch nach
Close nicht einfach unter einer anderen Lease-ID neu aufgebaut werden: maximal
512 Consent-Tombstones bleiben bis zum ursprünglichen Consent-Ablauf erhalten.
Maximal 80 Quellenreceiver können gleichzeitig existieren; das begrenzt diese
optionale Native-Ressource, nicht die Anzahl normaler Räume.

Synchrone Epochzeit-Prüfungen und ein eigener monotonic-clock Timer begrenzen
den Lease auch ohne Frames und trotz verzögerter Timer-Ausführung. Ein bereits
laufender alter Timer-Callback darf einen rechtzeitig erneuerten Lease nicht
schließen. Source-/Assignment-Stop, Parent-Failure, Thermal-Drain, Control-
Disconnect und Room-Consentverlust räumen die Receiver auf. Jede Verwendung
prüft die Parent-Policy neu; nach Decrypt erfolgt nochmals eine Prüfung, bevor
Bytes ausgegeben werden. Das ersetzt nicht das weiterhin fehlende atomare
Compositor-/Queue-Cleanup und ist keine Garantie über Go-GC-/Kernel-Kopien.

`AcceptKey` gibt erst nach erfolgreicher, erneut autorisierter Installation den
geschlossenen [Key-ACK](../contracts/trusted-decrypt/source-key-ack.v1.schema.json)
aus. Er bindet Source-Lease/Revision, Consent, Agreement, Envelope, KID und Ablauf.
`key-installed` behauptet keine dekodierbare Programmausgabe. Der native Adapter
macht diese Methode ausschließlich dem genau zugeordneten authentisierten
Publisher-DataChannel zugänglich; Frame-Keys bekommen keinen Node-Control-
Endpunkt. Das aktuelle Agent-Capability-Protokoll und die Annahme-UI werden durch
diesen internen Adapter noch nicht für Source-Ingress freigeschaltet.

## Verifikation

Die zusätzliche Source-Signal-Prüfung verbindet tatsächliche Publisher- und
signierte Packager-Control-WebSockets mit dem Broker: Offer und Answer werden
an genau die gebundenen Verbindungen weitergereicht, Replay und Widerruf nicht.
Ein stark escaptes, zu großes SDP wird vor der Weiterleitung abgewiesen, ohne
den Ziel-Packager zu trennen. Die SDP-Inhalte dieses Routingtests sind synthetisch;
er beweist keine erfolgreiche ICE-/DTLS-/RTP-Verbindung. Der separate native
Parser besitzt geschlossene Feld-, Duplikat-, Rollen- und Größenprüfungen samt
Fuzztest und wird vom Daemon an den getrennten Source-PeerConnection-Adapter
weitergereicht, der ohne eingerichteten Sink jede Medienannahme verweigert.

`TrustedBroadcastSourceControl` verbindet die echte Source-Authority mit der
aktuellen nativen Assignment-Registry und dem tatsächlich authentisierten
Packager-Socket. Der laufende WebSocket-Test weist signierte Geräteanmeldung,
Prepare, passenden Status, nachfolgenden Renewal und Stop beim Publisher-
Media-State-Widerruf nach. Die native Seite wird zusätzlich durch den echten
Control-Decoder und lokalen Dispatch getestet: gleicher Receiver/Agreement-Key
bei Renewal, terminaler Stop, unverändertes Parent-Programm bei verspätetem
Lease sowie Ablehnung von Zusatzfeldern, Duplikaten und falschen Scope-Daten.
Der WebSocket-Test simuliert den Status-Absender; er behauptet noch keinen
gemeinsamen Go-/Browser-Netzwerk- oder Compositor-Nachweis.

Der Lease-/Key-ACK-Zweig wird zusätzlich mit denselben beiden Browsern geprüft:
ein nativ ausgegebener Lease/Agreement-Key, der vorhandene Browser-Key-Envelope,
exakt gebundener ACK und je 401 entschlüsselte VP8-/Opus-Frames. Alle drei
nativen Receiver-Zweige sind getrennte synthetische Krypto-/Lifecycle-Nachweise,
noch keine Übertragung über DataChannel oder RTP. Go-Unit/Race/Vet und ein
begrenzter Source-Lease-Parser-Fuzzlauf ergänzen diese Prüfung.

Go-Tests prüfen den vorhandenen Suite-4-Vektor, kanonische uint64-Header,
Counter-Grenzen einschließlich 400, Manipulation, Umordnung, konkurrierende
Duplikate, Key-Reinstallation, Quoten, Ablauf und Cleanup. Der Node-Browsertest
`test/trusted-sframe-native.browser.test.js` lässt die tatsächlichen bestehenden
TypeScript-Verschlüsseler in Chromium und Firefox je 401 VP8- und 401
Opus-Testframes erzeugen; der Go-Decoder muss exakt dieselben synthetischen
Bytes zurückliefern und Duplikate ablehnen. Das belegt Krypto-/Envelope-Interop,
nicht echte Medien-Decodierung, RTP/NAT, Quellen-Consent oder Produktions-Ingress.
Zusätzlich liefert ein laufender nativer Testprozess zuerst sein echtes
ephemeres Public-Key-Announcement. Beide Browser erzeugen damit über den
bestehenden `sealTrustedDecryptKey`-Helper den Key-Envelope; erst nach nativer
Annahme müssen wiederum alle 401 VP8-/Opus-Frames exakt decodiert werden.
Key-Replay und terminaler Widerruf werden anschließend ebenfalls verlangt.
Dieser Ablauf verwendet eine explizite synthetische lokale Policy, keine
produktive oder durch JSON selbst erteilte Quellenberechtigung.

## Authentisierter Source-Control-Pfad

### Quellengebundene SDP/ICE-Weiterleitung

Der additive [Source-Signal-Vertrag](../contracts/trusted-decrypt/source-signal.v1.schema.json)
hat getrennte Senderrollen: `trusted-source-publisher-signal` für Offers/ICE und
`trusted-source-packager-signal` für Answers/ICE. Beide nennen ausschließlich
Source-Lease, Consent, Assignment/Fence und begrenzte Negotiation-/Signalfolgen;
der Aufrufer kann keinen Zielpeer hinzufügen. Der Broker prüft die konkrete
aktuelle Publisher-Peer-Objektidentität aus der RoomRegistry beziehungsweise den
wirklichen Packager-Socket, Gerätebindung, weiter bestehenden Consent und Writer.
Erst nach dem ersten `receiver-prepared`-ACK werden Signale zugelassen.

Der Server ergänzt das tatsächliche Gegenüber beim Weiterleiten als
`trusted-source-peer-signal` beziehungsweise `trusted-source-agent-signal`.
Pro Quellenverbindung sind höchstens 16 aufeinanderfolgende Negotiations erlaubt;
ein neues Offer folgt erst nach der vorherigen Antwort. Pro Seite beginnt jede
Generation mit SDP/Sequenz 1, danach folgen höchstens 128 geordnete ICE-Nachrichten.
Alte Epochen, doppelte oder übersprungene Folgenummern und ein zweites paralleles
Offer werden nicht weitergereicht. Leases werden weiterhin unabhängig erneuert;
ein ausstehender Renewal-ACK widerruft nicht den bereits bestätigten Receiver,
solange seine aktuelle Autorität und Laufzeit bestehen.

Grenzen: 16 KiB UTF-8-SDP, 4096 Candidate-Bytes, 31 KiB normalisierte
Sendernachricht inklusive JSON-Escaping, 32 KiB mit serverergänzten Referenzen,
64 Nachrichten pro Source in zehn Sekunden, 512 KiB über die Source-Laufzeit
und separat 512 Signale pro tatsächlichem Sender-Socket in zehn Sekunden.
Diese Budgets setzen weder ACK- noch Room-Limits außer Kraft. Ziel-Backpressure
oder Delivery-Verlust beendet nur die Quelle; Frame-Schlüssel und Key-Envelopes
sind in diesem Protokoll nicht zulässig.

**Kompatibilitätsgrenze, noch keine Medienfähigkeit:** Der Server reserviert für
diesen Signalpfad Stable-Agent-Version 0.9.0 oder neuer. Das derzeitige native
Binary bleibt bei 0.8.0 und erhält diese Nachrichten nicht. Sein Parser und
PeerConnection-/Key-DataChannel-/RTP-Adapter sind implementiert, jedoch ohne
produktiven Compositor-Sink nicht aktivierbar. Die Version wird erst nach
dem tatsächlichen vollständigen Anschluss erhöht; weder Annahme-UI noch eine fertige
Source-Medien-Capability wird aus einem erfolgreichen Metadaten-Routing abgeleitet.

### Separater nativer Quelltransport

`source_dispatch.go` prüft vor Erzeugung einer PeerConnection die aktuelle lokale
Source-/Consent-/Assignment-/Fence-/Publisher-Bindung erneut. Jede Quelle bekommt
eine eigene Verbindung, genau einen passenden Track mit der geleasten Publication-ID
und genau einen zuverlässigen, geordneten DataChannel mit Label und Protokoll
`trusted-source-keys-v1`. Falsche Medienarten, mehrere Tracks, ungeordnete oder
teilzuverlässige Kanäle schließen die Quelle. SDP- und ICE-Sequenzen bleiben an die
serverautorisierten Negotiation-Generationen gebunden. Die ICE-Konfiguration stammt
aus dem aktuellen Assignment beziehungsweise dem bestehenden Operator-Fallback.

Nur dieser DTLS/SCTP-Kanal trägt das ephemere öffentliche Key-Announcement und
die verschlüsselten Key-Envelopes. Der Server erhält weder Envelope noch Frame-Key.
Annahme liefert einen gebundenen `key-installed`-ACK, keinen Decode-/Output-Nachweis.
Key-Nachrichten sind auf 8 KiB, 120 Versuche pro Minute und 16 KiB Sendebacklog
begrenzt. Binärnachrichten, Key-Replay oder ungültige Bindung schließen die Quelle.

VP8 wird über RTP-Timestamp, Marker, Partitionsstart und umlaufende Sequenznummern
zusammengesetzt. Pro Quelle gibt es nur eine Ciphertext-Assembly: maximal 4 MiB,
4096 Fragmente, 64 Fragmente vor dem Start und 250 ms Wartezeit. Lücken,
widersprüchliche Fragmente und Übergröße ergeben keinen Teilframe. Opus wird als
ein vollständiger RTP-Payload verarbeitet; es wird nicht wie VP8 fragmentiert.
Zusätzlich begrenzt der Empfänger den Eingang auf 8 MiB Payload und 8192 Pakete
pro Ein-Sekunden-Fenster. Erst nach erfolgreicher SFrame-Prüfung und erneuter
Lease-Prüfung erhält der verpflichtende `trustedSourceSink` den Encoded-Klartext.
Unbekannte KIDs, Replay und Authentisierungsfehler haben keinen Klartext-Fallback.

Der Sink muss nichtblockierend und begrenzt arbeiten, geliehene Frames bei Bedarf
kopieren und beim Schließen seine Queues/Frames entfernen. Der Adapter überschreibt
seinen Klartext unmittelbar nach dem Aufruf. Der SourceReceiver meldet terminalen
Ablauf/Widerruf über `Done`; auch ohne neue Pakete schließen Verbindung, Kanal und
Sink. Die `*Now`-Operationen lesen die aktuelle Zeit innerhalb des Crypto-Mutex,
damit gleichzeitig ankommende RTP-, Key- und Renewal-Aufrufe keinen falschen
Clock-Rollback erzeugen. Echte Rücksprünge bleiben terminal.

Lokale Evidence: synthetische VP8-/Opus-SFrame-Payloads durch zwei echte Pion-PCs,
ECDH-Envelope über den tatsächlichen DataChannel, gebundener ACK und exakter
Klartextvergleich für Counter 0 bis 400. Bei Counter 350 werden zusätzlich Replay
und manipulierte Frames eingeschleust. Diese Payloads sind **keine decodierbaren
Testfilme**; damit sind weder Bild-/Tonwiedergabe noch Browser-Packetizer-Interop,
Compositor-Ausgabe, NAT oder Produktion nachgewiesen. Separate Tests prüfen
Kanal-/Scope-/Sequenzfehler, Lease-Erneuerung, untätigen Ablauf und Quell-Cleanup
ohne Abbruch des Parent-Programms. Browser-Sender, echter Decoder/Compositor,
Slate-Wechsel und die explizite Publisher-Annahme bleiben nächste Integrationsarbeit.

### Prepare, Renewal und Stop

Der additive [Control-Vertrag](../contracts/trusted-decrypt/source-control.v1.schema.json)
trennt `trusted-source-prepare`, `trusted-source-stop` und
`trusted-source-status`. Keines dieser Nachrichtenformate enthält Frame-
Schlüssel, Key-Envelopes, Agreement-Keys, Medien oder Transkripte.

`TrustedBroadcastSourceControl.prepare(consentId, socket)` ist weiterhin eine
interne Operation ohne öffentliches Approve-API. Sie löst den Consent gegen
die echte Control-Geräteidentität auf, verlangt einen aktuellen laufenden oder
degradierten gefenceten Writer und erzeugt eine serverseitige Source-Lease-ID.
Ein JSON-Consent oder behaupteter Packagername kann diese Auflösung nicht ersetzen.
Native Versionen vor **0.8.0** erhalten keine neuen Source-Nachrichten; 0.8.0
bezeichnet hier nur Control-Unterstützung, ausdrücklich keine vollständige
Trusted-RTP-/DataChannel-/Compositor-Capability. Bestehende Assignment-Versionen
und die öffentliche Quellenanfrage bleiben kompatibel.

Die ausgestellten Leases gelten maximal vier Sekunden. Der native Empfänger
akzeptiert höchstens fünf Sekunden und bis eine Sekunde Clock-Skew; diese
Reserve ist keine zusätzliche serverseitige Lease-Laufzeit. Der vorhandene
500-ms-Maintenance-Lauf überprüft den Scope; frühestens eine Sekunde nach der
Ausstellung und ausschließlich nach genau passendem `receiver-prepared`-ACK
wird die nächste Revision gesendet. Jede Erneuerung prüft erneut Consent,
Publisher-/Publikationsgeneration, Assignment, Fence und ursprünglichen Socket.
Ein alter ACK bestätigt keine neuere Revision. Wiederholter Prepare verlängert
nichts und sendet auch nicht automatisch erneut. Ablauf, Delivery-Verlust,
Reconnect, Widerruf und Parent-Verlust schließen terminal.

`receiver-prepared` bestätigt ausschließlich einen lokal autorisierten Receiver.
Es ist weder `key-installed` noch erfolgreiche Decryption, Decode oder Ausgabe.
Verspätete, wohlgeformte Quellen-Leases liefern nativ einen Quellenstatus `failed`,
ohne das laufende Parent-Programm abzubrechen. Falsche oder verspätete
Quellenstatusmeldungen werden nicht als Assignment-Fehler behandelt. Stop
berücksichtigt höchstens eine noch unbestätigte nächste Revision; falsche
Consent-/Assignment-/Fence-Bindungen schließen keinen anderen Receiver.

Harte Brokerbudgets: 1024 Records insgesamt, 80 je Packager; terminale Records
behalten bis Consent-Ablauf ihren Platz. Das sind optionale Ressourcenbudgets,
keine globale Room-Grenze. ACKs besitzen separat maximal 1024 Operationen je
Socket in zehn Sekunden, damit bis 80 Erneuerungen pro Sekunde nicht das
Heartbeat-/Assignment-Budget verbrauchen. Ausgehende Control-Pakete sind auf
8 KiB begrenzt, über 64 KiB Socket-Backlog wird die Quelle geschlossen; aktive
native Ablauf-Timer bleiben der Schutz bei nicht zustellbarem Stop. Vor einem
öffentlichen Annahmepfad müssen weiterhin Publisher-DataChannel, RTP und
Compositor samt atomarem Queue-/Frame-Cleanup integriert und real geprüft werden.

`test/trusted-broadcast-source-grants.test.js` verbindet echte Room-/Broadcast-
Registries mit signierter Packager-Geräteanmeldung und bestätigt zusätzlich
alle vier Quellenarten, Revocation, Handoff und transiente Rechteverluste.
Ein eigener laufender HTTP-/WebSocket-Server bezieht die Einladung über echtes
signiertes Test-OIDC und die Publication/Membership-Epochen über Signaling.
Sein WebSocket-Ticket verwendet eine explizite ephemere Session-Policy-Fixture;
dies ist kein zusätzlicher PKCE-/Geräteproof- oder produktiver Mediennachweis.
