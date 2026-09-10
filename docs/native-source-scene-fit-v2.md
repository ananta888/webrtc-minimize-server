# Szenenanpassung pro Quelle: nativer v2-Baustein

Implementierungsstand: nativer Steuer- und Renderpfad vorhanden; explizite
Capability-Aushandlung, Node-Director/Broker und Angular-Auswahl folgen.
Dies ist noch keine öffentlich bedienbare oder deployte Funktion. TBP-015
bleibt offen; Zielauflösung/FPS, weitere Profile und die 60-Minuten-Abnahme
sind dadurch nicht erledigt.

## Vertrag und Wirkung

Die additive `source-program-scene`-Version 2 verlangt `sourceFits`: eine
vollständige Liste aus `contain` oder `cover`, positionsgleich zu
`sourceLeaseIds`, höchstens 20 Einträge. Fehlende, zusätzliche, unbekannte oder
nicht passend lange Listen werden abgewiesen. Auch eine leere Auswahl besitzt
eine explizite leere Liste. Query, State, Applied und Rejected verwenden
dieselbe angeforderte Version. Die fünf neuen JSON-Schemas und gemeinsamen
nativen Fixtures sind versioniert; gleiche Listenlängen werden zusätzlich
vom nativen Validator geprüft, nicht durch das allgemeine Schema allein.

Der Mixer besitzt eine eigene Kopie der Szenen-Fits. Er verändert weder die
Admission-Konfiguration eines Inputs noch dessen Consent, Frames, Zeitbasis,
Quelle, Decoder, Lease oder Puffergrenzen. Der Wechsel betrifft die tatsächliche
Pixelkomposition beim nächsten Render. `contain` erhält die vollständige Quelle
mit Slate-Rändern; `cover` füllt die Kachel durch den vorhandenen mittigen Crop.
Es gibt keine frei übergebenen Filter, Koordinaten, URLs oder Metadaten.

Das vorhandene v1 bleibt in seiner exakten Form gültig. Ein v1-Schreibauftrag
setzt wie bisher die ursprünglichen Input-Defaults; eine v1-Abfrage enthält
keine neuen Felder. Eine v2-Abfrage liefert die tatsächlich ausgewählten Fits,
auch für einen nach Widerruf als Slate verbleibenden Slot, ohne neue Rechte
aus dessen ID abzuleiten. Kein v2-Auftrag wird als v1 umgedeutet.

Native Commands behalten die authentisierte Control-Verbindung, den aktuellen
Source-Program-Owner, Revision-CAS, die maximal viersekündige Frist und die
maximal 32 historischen Command-Belege. Ein Replay mit geändertem Fit scheitert.
Ein erst nach Warten auf die Render-Sperre abgelaufener Auftrag verändert die
bestehende Szene nicht. Antworten bleiben historische Anwendungsbelege, keine
Bestätigung der Zustellung beim Publikum.

## Bisherige Verifikation und nächste Integration

Die fokussierten nativen Scene-/Mixer-Racetests bestehen, einschließlich der
unveränderten v1-Fixtures. Neue Tests prüfen echte RGBA-Pixel bei
Contain/Cover/v1-Rückkehr ohne erneute Bildzufuhr, unveränderte Input-Defaults,
kopierte Beobachtungen, fehlende/falsche Fits, Versionsgrenzen, geänderte Replays,
Ablauf am Render-Lock und Auswahlverbot nach realer Receiver-Revocation.
Die RGBA-Prüfung ist eine lokale synthetische Renderprüfung, kein Browser- oder
Netzwerk-Transcodingnachweis.

Auch der vollständige native Go-Racelauf besteht (48,750 s; internes
SFrame-Paket 2,193 s), ebenso Go Vet. Diese lokalen nativen Prüfungen ersetzen
weder den noch folgenden gemeinsamen Projektcheck noch eine UI-Abnahme.

Zehn Node-Schema-/v1-Vertragstests bestehen ohne Skip (0,397 s). Der bestehende
Node-v1-Adapter weist v2 weiterhin explizit ab; dessen Integration darf später
nur nach frischer Capability-Prüfung und mit passender Antwortversion erfolgen.
Es wird jetzt noch keine neue Agent-Capability beworben. Der gemeinsame
Projektcheck und reale Angular-/Native-Abnahme folgen nach dieser durchgängigen
Integration, nicht erneut nach jedem kleinen Baustein.
