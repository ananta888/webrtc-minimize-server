# Ananta-Freigaben bei fehlgeschlagenem Nachladen

MDS-14 ergänzt die Bedienung bei einem fehlgeschlagenen Panel-Import. Anlass
ist die klassifizierte CI-Störung mit `ERR_NETWORK_CHANGED` und `NG0750`.
Die Ursache des Netzwerkwechsels wird dadurch nicht behoben oder erklärt.

Die Raumseite zeigt beim Laden einen Status und bei einem Fehler eine feste
Fehleransicht. Sie behauptet weder eine leere KI-Membership noch einen erfolgten
Widerruf: Bestehende Freigaben sind durch das fehlende Panel nicht automatisch
beendet. Der Nutzer kann über die vorhandene Leave-Aktion den Raum verlassen
oder bewusst die Seite neu laden. Die Sitzung endet dabei; erneuter Beitritt
ist eine getrennte lokale Aktion. Es gibt keinen automatischen Retry, Reload,
Capture, Beitritt oder neuen Grant.

Der separat geladene Betreiberstatus besitzt ebenfalls Lade-/Fehlertext.
Sein Ausfall sperrt nicht die bereits vorhandene Quellenbedienung. Der
Aufnahmestatus wird dann ausdrücklich als unbekannt bezeichnet.

Die Umsetzung nutzt Angulars vorgesehene `@loading`-/`@error`-Blöcke.
Die Fehleransicht hängt damit nicht vom gerade fehlgeschlagenen Komponentenchunk
ab. [Angular: Deferred loading](https://angular.dev/guide/templates/defer),
[NG0750](https://angular.dev/errors/NG0750).

## Prüfumfang

Der private Browsertest ermittelt das tatsächliche Produktionschunk über eine
eindeutige Komponentenmarkierung und hält bzw. verweigert dessen Request.
Chromium und Firefox prüfen sichtbare Lade-/Fehlerzustände, Tastaturbedienung,
unveränderte Capture-/PeerConnection-Zähler während des Fehlers, explizites
Leave und Reload sowie erneuten Beitritt mit anschließend normal geladenem
Panel. Ein getrennt gescheiterter Betreiberstatus darf echte serverbestätigte
Chatfreigabe und deren Widerruf nicht verhindern. Die synthetischen Identitäten
und Quellen erteilen keine Produktionsrechte.

Der erste Vier-Fälle-Lauf bestand in 13,418 s. 39 Serviceprüfungen,
Typprüfung und der isolierte Produktionsbuild bestanden ebenfalls; das
1,60-MB-Hardlimit blieb unverändert. Der Nachtrag mit realem Mikrofon-Cleanup
und die gemeinsame Dialogregression bestanden zusammen: sechs echte
Chromium-/Firefox-Fälle in 42,826 s, null Fehler oder Skips. Das explizit
gestartete synthetische Mikrofon ist nach der Leave-Aktion tatsächlich beendet.
Die zwei normalen Dialoge prüfen weiterhin Audioempfang, Chat, Bildschirm,
drei Renewals und wirksamen Freigabeentzug unter erforderlichem SFrame.
Der gemeinsame isolierte Projektcheck auf `8455530` ist inzwischen beendet:
1.286 Frontendtests und 1.247 Node-/Browsertests bestanden, darunter alle vier
Ladefehler-Fälle und die beiden vollständigen Ananta-Dialoge. Zwei native
Broadcast-Fälle scheiterten, vier Tests wurden übersprungen. Deshalb bleibt
die gemeinsame Abnahme offen; der Gesamtcheck ist nicht grün. CI `34468539328`
ist ebenfalls fehlgeschlagen und betrifft ausschließlich den vorherigen Stand
`e9e8699`; die konkreten Befunde stehen im [Integrationsstatus](ananta-integration-status.md).
Keine Änderung am Ananta-Repository, Serving-Build oder öffentlichen Hub-Trust.
