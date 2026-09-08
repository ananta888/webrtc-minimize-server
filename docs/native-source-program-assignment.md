# Trusted-Source-Programm: Assignment v4

`assignment-prepare.v4.schema.json` ist ein neuer geschlossener Vertrag für die
vorbereitete Mehrquellen-Pipeline. Er ist **noch nicht im produktiven Dispatcher
aktiviert**. Ein eigener nativer Parser und eine Scope-Projektion existieren;
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

Der nächste Runtimeadapter muss die Programm-Generation außerhalb der Registry-
Locks erstellen, sie exklusiv an das aktuelle Assignment hängen und Stop,
Renewal, lokale Room-Freigabe, Disconnect und spätes Konstruktorende fencen.
Insbesondere darf Quellenzulassung im ausdrücklich zugewiesenen v4-Startpfad
nicht schon eine laufende Medienausgabe verlangen: Quellen sind erst nötig,
um diese Ausgabe überhaupt zu erzeugen. Diese Ausnahme darf den Legacy-Pfad
nicht erweitern. Ein HLS-Slate allein darf nicht als Empfang einer freigegebenen
Quelle gemeldet werden. Generationswechsel/Discontinuity, öffentlicher
Approve-/Renew-Pfad und gemeinsame SFrame-/Mehrpublisherabnahme bleiben notwendig.
