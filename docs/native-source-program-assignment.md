# Trusted-Source-Programm: Assignment v4

`assignment-prepare.v4.schema.json` ist ein neuer geschlossener Vertrag für die
vorbereitete Mehrquellen-Pipeline. Er ist **noch nicht im produktiven Dispatcher
aktiviert**. Nativer Parser, Scope-Projektion und interner Auftragsowner existieren;
der Server emittiert weiterhin v1/v2/v3 und Agent-Version 0.8.0 bleibt unverändert.
Das Schema oder sein erfolgreiches Parsen erlaubt weder Teilnahme noch Decrypt.

## Explizite Bindung statt abgeleiteter Autorität

Der v4-Auftrag besitzt genau 14 Felder. Er übernimmt Assignment, Raum, Programm,
Programmepoche, Writer-Lease/Fence, Output-Resource, Encodingprofil, ICE-Liste
und Ablauf. `inputMode` muss `trusted-sframe-v1` sein. Statt des alten einzelnen
`publisherPeerId` enthält er einen geschlossenen `sourceContext`:

| Feld | Bedeutung |
|---|---|
| `schema` | exakt `ananta.trusted-source-program-context.v1` |
| `tenantId` | vom autorisierten Server zugewiesener pseudonymer Tenant |
| `roomEpoch` | aktuelle Membership-Epoche des zugewiesenen Programms |
| `granteeDeviceRef` | konkretes P-256-Packagergerät, nicht nur sein Anzeigename |
| `frameEnvelope` | ausschließlich `codec-prefix-v1` |

Diese Werte dürfen nicht aus der ersten angebotenen Quellen-Lease entstehen.
Der spätere Serveradapter muss sie aus verifizierter Program-/Owner-/Membership-
Policy projizieren; der native Adapter muss sie mit seiner authentisierten
aktuellen Assignment-Instanz und lokalen Geräteidentität abgleichen. Jede Quelle
benötigt weiterhin ihre eigene aktuelle Receiver-Lease und Publisherfreigabe.
`scopeForDevice` prüft Form, Ablauf und exaktes Gerät und liefert diese Bindung
für die interne Programm-Generation; es ist selbst kein Autorisierungsnachweis.

## Grenzen

Alle Epochen, Fences und Millisekundenzeiten liegen im sicheren JSON-Integer-
Bereich. Der native Parser akzeptiert höchstens 64 KiB und nur einen JSON-Wert.
Der Ablauf muss bei Prüfung in der Zukunft und höchstens 120 Sekunden entfernt
liegen. Die JSON-Schema-Formprüfung ersetzt diesen dynamischen Zeitvergleich nicht.

Profile und Renditions bleiben begrenzt. Jede ID `low`/`medium`/`high` darf nur
einmal vorkommen; Dimensionen müssen gerade sein. Erlaubte Encodernamen sind
kein Hardware- oder Ressourcenfreigabenachweis. Die tatsächliche lokale
Zulassung, verfügbaren Fähigkeiten und Prozess-/Speicherbudgets bleiben separat.

`iceServers` ist eine ausdrücklich vorhandene Liste mit 0–24 Einträgen.
Eine leere Liste erlaubt direkte Host-Kandidaten ohne Infrastruktur, nicht einen
anderen Autorisierungspfad. `null` und fehlende Liste sind ungültig. Ein Eintrag
ist entweder STUN-only ohne Credential-Felder oder TURN-only mit dem vollständigen
Password-Credential-Satz. Gemischte URL-Gruppen und leere zusätzliche Credential-
Felder sind verboten. Der bestehende v3-Parser wird dadurch nicht verändert.
V4-URIs bestehen ausschließlich aus sichtbarem ASCII (Zeichen 0x21–0x7e).
Leerzeichen, Steuerzeichen und unkodierte Unicode-Hostnamen sind ausgeschlossen;
internationale Namen müssen bereits als ASCII-Hostname kodiert sein. Native
Credential-Längen bleiben zusätzlich auf 512 UTF-8-Bytes begrenzt; übliche
Coturn-REST-Credentials sind ASCII. Keine Credentials werden protokolliert.
Unbekannte Felder sind auf jeder Objektebene geschlossen; Medien und Frame-
Schlüssel gehören weiterhin nicht in diese Control-Nachricht.

Ein eigener vorgeschalteter Formparser prüft die genaue Schreibweise jedes
Pflichtfelds sowie doppelte Schlüssel auf allen bekannten Objektebenen. Er
prüft außerdem gültige UTF-8-Eingabebytes und genau einen JSON-Wert. Das normale
Go-Struct-Decoding allein genügt dafür nicht: Der erste Regressionstest nahm
acht Varianten mit Großschreibung oder doppelten Schlüsseln fälschlich an.
Ein einzeln escaped kodierter, nach JSON-Decoding identischer Feldname bleibt
gültig; ein zweites solches Feld wird als Duplikat verworfen. Die nachfolgende
typisierte Prüfung ersetzt diese Formprüfung nicht und erteilt keine Autorität.

## Verifikation und nächster Anschluss

Go und JSON Schema verwenden dieselbe eingebettete synthetische Fixture.
Tests prüfen gültige Bindung, fremdes Gerät, Ablauf, Pflicht-/Fremdfelder,
Integer-/Renditiongrenzen, ICE-Modi und Legacy-Isolation. Eine echte v4-Nachricht
muss im bisherigen Dispatcher weiterhin abgewiesen werden: kein stiller Start
einer Legacy-PeerConnection und kein automatisches Upgrade bestehender Aufträge.
Die strengere Parser-Race-Matrix bestand dreimal samt Vet; Schema-Negativfälle
prüfen ebenfalls Großschreibung, URI-Steuerzeichen und abschließende Zeilenenden.

Der isolierte Gesamtcheck auf Basis `e8bcd7f` mit diesem v4-Baustein bestand am
8. September 2026 terminal mit Exit 0: 757 Frontendtests und 791 erfolgreiche
Node-/Browserprüfungen, null Fehler, zwei explizite Node-Skips (350,151 s).
Build, Go-Unit/Vet und statische Gates bestanden. Die nicht aktivierten externen
Infrastruktur-Gates sowie der optionale Image-Scan blieben sichtbar übersprungen.
Die anschließend bis `68db657` übernommenen Änderungen betreffen ausschließlich
Tests/Planung; der neue Same-Persona-Isolationstest bestand separat in Chromium
und Firefox gegen denselben isolierten Build. Der lokale Serving-Build blieb
unverändert. Das ist weder eine v4-Runtimefreischaltung noch Produktionsabnahme.

## Interner Auftragsowner

`prepareSourceProgramAssignment` reserviert eine konkrete lokale Assignment-
Instanz und baut ihre echte Programm-Generation außerhalb der Registry-Locks.
Ausführbare Datei, Ausgabepfad und Allokationsbudgets stammen ausschließlich
aus lokaler Konfiguration, nicht aus dem Auftrag. Encoder, Renditionzahl und
Ausgabepixelrate werden zusätzlich gegen die lokale Capability geprüft.
Ein 20-ms-Policy-Watchdog gilt bereits während der Konstruktion. Stop, Ablauf,
Disconnect, fehlender Raumconsent und verspätete Konstruktor-Ergebnisse können
die Generation nicht wiederbeleben. Kurzzeitiger Raumconsentverlust setzt beim
Sync sofort eine terminale Fence, auch wenn derselbe Raum danach wiederkommt.

Quellen werden dem **Auftragsobjekt**, nicht allein seiner Wire-ID zugeordnet.
Der Regressionstest hat zunächst nachgewiesen, dass die alte globale Bereinigung
eine schon vorbereitete Nachfolgerquelle beendet. Auftragsbezogenes Cleanup
entfernt jetzt nur eigene Quellen; deren Consent-Tombstones bleiben erhalten.
Stop quittiert erst nach Konstruktor-/Decoder-/Encoder-Reaping und nach einer
eventuell bereits laufenden Ready-Antwort. Keine Registry-Sperre wird dabei
über Codec-Warten oder Status-I/O gehalten. Höchstens 512 v4-Assignment-
Tombstones verhindern erneuten Aufbau gestoppter IDs bis zum letzten erneuerten
Lease-Ablauf. Dieser instanzlokale Schutz überlebt keinen Prozessneustart.

Nur ein tatsächlich gebauter v4-Owner erlaubt Quellenbootstrap in `ready` oder
`starting`, mit exakt passendem Tenant und Membership-Epoch. Legacy bleibt auf
`running`/`degraded` beschränkt. Quellen-Sinks gehen direkt an die zugeordnete
Generation; eine explizit leere v4-ICE-Liste erbt keine lokalen STUN-Defaults.
Writer-Renewal hält dieselbe Generation, verkürzt keinen Lease und hebt keinen
Widerruf auf. Zusätzlich zur absoluten Ablaufzeit gilt eine monotone lokale
Deadline; identische Renewals setzen sie nicht zurück, ein abgelaufener Owner
kann auch bei noch zukünftiger Wanduhr-Ablaufzeit nicht verlängert werden.
`ready` meldet nur die lokale Generation: Slate ist kein Beweis
für zugestimmte, empfangene oder decodierte Quellen.

Die gezielte Race-/Lifecycle-Matrix bestand dreimal plus Go-Vet. Der neue echte
Assignment-zu-HLS-Test bestand auf FFmpeg 6.1.1 in 7,63 s: getrennte VP8-/Opus-
Receiver im vorbereiteten Auftrag, beide bewegten Renditions, decodiertes
700-Hz-Audio, sechs Quellen- und drei Writer-Renewals sowie terminaler
Widerruf mit vollständigem Reaping. Eingaben und Senderreports sind synthetisch
und bereits entschlüsselt; dies behauptet keine RTP-/SFrame-Gesamtabnahme.

Der abschließende isolierte `npm run check` einschließlich monotoner Frist und
Renewal-Replaytest bestand mit Exit 0: 757 Frontendtests, 794 Node-Erfolge,
null Fehler, zwei explizite Node-Skips (353,280 s). Build, Go-Unit/Vet und
statische Gates bestanden; 14 externe Infrastruktur-Gates und der optionale
Image-Scan blieben sichtbar übersprungen. Die Runtime-/Testdateien wurden
bytegenau mit dem geprüften Snapshot verglichen. Der lokale Serving-Build
blieb unverändert. Das separate Deployment `b72c779` enthält den Parser,
aber noch nicht diesen Owner.

## Idempotente Prepare-Wiederholungen

Ein wiederholtes v4-Prepare verwendet denselben lebenden Owner, Encoder und
Receiver. Alle unveränderlichen Wirefelder und effektiven lokalen Ressourcen-
parameter müssen identisch sein. Als Ablauf wird nur der noch gültige
Originalwert oder der bereits durch `assignment-renew` autorisierte aktuelle
Wert angenommen: Der Server erzeugt Wiederholungsbefehle aus seinem aktuellen
Record. Prepare verschiebt weder die absolute noch die monotone Frist. Andere
Ablaufwerte oder geänderte Budgets erfordern einen neuen expliziten Auftrag.
Gestoppte, widerrufene oder fehlgeschlagene Aufträge werden nicht wiederaufgebaut.

Höchstens acht Retry-Aufrufe sind gleichzeitig zugelassen. Das Warten auf die
ursprüngliche Konstruktion endet nach fünf Sekunden oder sofort bei Widerruf;
ein Retry-Timeout allein beendet den ursprünglichen Auftrag nicht. Anschließende
Statusausgaben nutzen den vorhandenen Control-Writer mit seinem getrennten
zehnsekündigen Socket-Schreiblimit. Status-I/O und Konstruktorwarten halten keine
Registry-Sperren. Retry und nichtterminale v4-Zustandswechsel sind gemeinsam
serialisiert; zurückgemeldet werden aktueller Zustand und tatsächlicher Grund,
nicht pauschal erneut `ready`/`CAPABILITY_READY`. Stop kann nicht von einer
verspäteten Retry-Antwort überholt werden. Diese v4-Serialisierung verändert
die Legacy-Zustandsregeln nicht.

Zwei zuerst fehlgeschlagene Regressionen belegen die ursprünglichen Lücken:
identisches Prepare wurde abgewiesen, ebenso eine Wiederholung mit dem bereits
autorisierten Renewal-Ablauf. Nach Korrektur bestanden die fokussierte
Race-/Lifecycle-Matrix dreimal (37,182 s) und Vet. Die echte bereits
entschlüsselte VP8-/Opus-zu-HLS-Fixture bestand in 7,70 s mit beiden bewegten
Renditions und Audio, drei Writer-Renewals und drei Prepare-Wiederholungen
(Original- und aktueller Ablauf), ohne neuen Encoder oder Friständerung.
Wartekapazität, echter Fünfsekunden-Timeout, Scope-/Budgetkonflikte, Widerruf
und Statusreihenfolge sind getrennt getestet. Der gemeinsame Abschlusscheck
und die spätere öffentliche Control-Anbindung bleiben separate Nachweise.

Der abschließende isolierte Gesamtcheck dieser Erweiterung auf Basis `219e4ef`
bestand mit Exit 0: 757 Frontendtests, 794 Node-Erfolge, null Fehler und zwei
explizite Node-Skips (361,648 s). Die erweiterte echte Assignment-/HLS-Fixture
bestand erneut in 7,632 s. Go-Unit/Vet, Build und statische Gates waren grün;
14 externe Infrastruktur-Gates und der optionale Image-Scan blieben sichtbar
übersprungen. Die geänderten Runtime-/Testdateien entsprechen bytegenau dem
geprüften Snapshot; der lokale Serving-Build blieb unverändert. Das separate
Software-Deployment `219e4ef` enthält den vorherigen Owner, noch nicht diese
Retry-Erweiterung, und aktiviert weiterhin keine öffentliche v4-Freigabe.

Noch erforderlich: produktiver Budget-/Capability-Adapter und v4-Control-
Dispatcher/Emitter, Generationswechsel mit
Discontinuity, öffentlicher Approve-/Renew-Pfad sowie gemeinsame SFrame-/
Mehrpublisherabnahme. Der interne Owner allein schaltet keine Nutzerfreigabe,
Maschinenaufnahme oder neue Agent-Version frei.
