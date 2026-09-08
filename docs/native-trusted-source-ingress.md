# Native Trusted-Source-Ingress

## Aktueller Implementierungsstand

`native-broadcast-packager/internal/trustedsframe` ist der getrennte
Entschlüsselungsbaustein für eine später ausdrücklich consentierte einzelne
Quelle. Der ergänzte `Receiver` verbindet einen zielgebundenen ephemeren
P-256-Key-Envelope bereits mit genau einem Decoder, ist aber **noch nicht an
den nativen Netzwerk-Ingress angeschlossen**.
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
rekursiv aufrufen. Die produktive Implementierung dieses Ports steht noch aus.

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

- Servergeprüfte Quelle mit Peer-/Gerätebindung und Publication-Epoch sowie
  exaktem Room-/Program-/Writer-Lease-Scope.
- Sichtbarer Publisher-Consent und sofortiger unabhängiger Widerruf.
- Transport des implementierten zielgebundenen Key-Envelopes, quittierte
  Schlüsselaktivierung und getrennte Signaling-/RTP-Receiver für autorisierte Quellen.
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

## Verifikation

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
