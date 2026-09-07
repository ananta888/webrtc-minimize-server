# Native Trusted-Source-Ingress

## Aktueller Implementierungsstand

`native-broadcast-packager/internal/trustedsframe` ist der getrennte
Entschlüsselungsbaustein für eine später ausdrücklich consentierte einzelne
Quelle. Er ist **noch nicht an den nativen Netzwerk-Ingress angeschlossen**.
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

## Noch anzuschließen

- Servergeprüfte Quelle mit Peer-/Gerätebindung und Publication-Epoch sowie
  exaktem Room-/Program-/Writer-Lease-Scope.
- Sichtbarer Publisher-Consent und sofortiger unabhängiger Widerruf.
- Zielgebundener ephemerer Key-Envelope, quittierte Schlüsselaktivierung und
  getrennte Signaling-/RTP-Receiver für autorisierte Quellen.
- Begrenztes Depacketizing, Zuordnung zum Audio-/Video-Compositor und Entfernen
  aller zuletzt decodierten Frames bei Widerruf, Source-Ende oder Handoff.

## Verifikation

Go-Tests prüfen den vorhandenen Suite-4-Vektor, kanonische uint64-Header,
Counter-Grenzen einschließlich 400, Manipulation, Umordnung, konkurrierende
Duplikate, Key-Reinstallation, Quoten, Ablauf und Cleanup. Der Node-Browsertest
`test/trusted-sframe-native.browser.test.js` lässt die tatsächlichen bestehenden
TypeScript-Verschlüsseler in Chromium und Firefox je 401 VP8- und 401
Opus-Testframes erzeugen; der Go-Decoder muss exakt dieselben synthetischen
Bytes zurückliefern und Duplikate ablehnen. Das belegt Krypto-/Envelope-Interop,
nicht echte Medien-Decodierung, RTP/NAT, Quellen-Consent oder Produktions-Ingress.
