# Explizite Quellenfreigabe in Angular

Unter **Broadcast → Quellenanfragen öffnen** kann ein angefragter Publisher
**Eigene Quelle prüfen** wählen. Das lädt nur seine aktuellen serverseitigen
Publikations-IDs und Epochen. Der Client gleicht sie mit genau den laufenden
eigenen Tracks unter stabiler Room-Membership ab. Ohne passende laufende Quelle
gibt es keinen Freigabeknopf. Das Panel startet keine Aufnahme.

Vor dem ausdrücklichen Freigabeklick erscheinen Ziel-Packager, Programm,
Quellart und die Vertrauensgrenze: Der Trusted Packager darf diese Quelle
entschlüsseln und zum Broadcast-Publikum ausgeben. Der interaktive Raum bleibt
ein getrennter Pfad. Eine Anfrage ist keine Freigabe; die serverseitige
Consent-Antwort ist wiederum noch keine Receiver-Bereitschaft oder Schlüssel-ACK.

Der Root-Service verbindet die vorhandene authentisierte Raumverbindung und
den bestehenden `TrustedSourcePublisher`. Pro Quelle muss der bestätigte
Consent exakt zu Anfrage, Tenant, Subject, Raum und Epoche passen. Erst ein
passender, vom Receiver bestätigter Source-Lease startet den separaten
Publisher. Dieser gibt den Sender weiterhin erst nach seinem eigenen
verschlüsselten Key-Exchange und Key-ACK frei. Schlüssel bleiben im DataChannel,
nicht im Signaling. Ein Lease allein aktiviert keine Quelle ohne vorherige
lokale Zustimmung.

## Lebensdauer und Grenzen

- Höchstens vier aktive eigene Quellen und 16 kurzlebige Einträge einschließlich
  Stop-Markierungen; eine eigene Publikation wird hier nicht mehrfach freigegeben.
- Vorprüfung und Approval-Antwort sind auf fünf Sekunden begrenzt; eine
  vorbereitete lokale Auswahl gilt höchstens 30 Sekunden und nie länger als die Anfrage.
- Sichtbare Consent-Dauer: maximal 1, 5 oder 10 Minuten. Der Server kann sie
  durch Writer- und Consent-Leases weiter verkürzen. Keine automatische
  Verlängerung der Nutzerzustimmung.
- Source-Leases werden ausschließlich nach neuer serverseitiger
  Receiver-Bestätigung weitergereicht. Der bestehende Publisher prüft exakt
  aufeinanderfolgende Revisionen; alte ACKs verlängern nichts.
- Beim asynchronen Senderstart höchstens 32 frühe Signale/64 KiB und vier
  vorübergehend ausstehende Lease-Revisionen. Ausgehende Source-Control-Nachrichten
  sind auf 32 KiB und zusammen mit dem aktuellen Socket-Rückstau auf 64 KiB begrenzt.
- Eigene Quelle endet, Identität/Gerät/Membership wechselt oder Lease läuft ab:
  nur der Broadcastsender wird gestoppt, niemals der geliehene Raumtrack.
- Ein Panelwechsel beendet keine aktive Freigabe. Dafür gibt es den sichtbaren
  Sofort-Stop. Verspätete Bestätigungen können eine gestoppte Quelle nicht starten;
  ein noch zuordenbarer später Consent wird bestmöglich widerrufen.

`Sender aktiv` bezeichnet den bestätigten Senderzustand, nicht HLS-Wiedergabe
beim Publikum. Unbekannte Felder und unpassende Kontrollnachrichten geben keine
zusätzlichen Rechte; fehlerhafte Source-Control-Nachrichten beenden lokal aktive
Quellen konservativ. Es gibt keinen Legacy-/Klartext-Fallback.

## Architektur und Prüfgrenzen

Der Einladungsvertrag ist aus dem HTTP-Service extrahiert und bleibt über dessen
bisherige Exporte kompatibel. Reine Parser/Workflow, Angular-Komposition,
Signaling-Transport und Medienpublisher sind getrennt. Der Root-Service
verwendet ausschließlich die bereits autorisierten ICE-Server der Raumsitzung.

55 fokussierte Tests bestanden: Parser, öffentliche Identitätsreferenzen,
explizite Auswahl, Quell-/Identitywechsel, verspätete ACKs, frühe SDP-/Lease-
Nachrichten, Overflow, Stop und die echte Service-Komposition mit Factory-Port.
Die bestehende Chromium-/Firefox-Native-Fixture verwendet jetzt ebenfalls den
wirklichen Workflow vor dem SFrame-Publisher: beide Browser liefern mindestens
401 authentifizierte VP8-/Opus-Frames und, mit verfügbarem FFmpeg, mindestens
350 tatsächlich dekodierte Ausgaben. Beide Fälle bestanden (70,801 s gesamt).
Die Policy-Antworten dieser Medienfixture sind ausdrücklich synthetisch; das
ist kein durchgehender öffentlicher HTTP/OIDC/UI/Native/HLS-Nachweis.

Der kombinierte Check nach Übernahme von `28eff78` umfasst auch den finalen
Stopparser: 1.012 Frontendtests sowie 975 Nodeprüfungen bestanden, drei
Ananta-Browserfälle scheiterten und zwei Prüfungen wurden explizit übersprungen
(Node: 429,727 s). Build, Typen, Go und statische Gates bestanden; die externe
Infrastrukturstufe wurde wegen der Fehler nicht erreicht. Die tatsächliche
Angular-Tastaturprüfung fragt eigene Publikationen ab und zeigt ohne laufenden
Track keinen Freigabeknopf; kein Capture. Beide nativen Source-Workflow-Fälle
bestanden erneut. Der Gesamtcheck bleibt fehlgeschlagen, nicht releasefähig
allein aufgrund dieser Teilnachweise.

Für den öffentlichen Einstieg braucht es bereits einen v4-Quellen-Writer.
Der bisherige Legacy-Programmstart in Angular wird dadurch nicht umgedeutet;
seine Anfrage allein kann keine v4-Source-Freigabe erzeugen. Der gesonderte
[v4-Start-Workflow](native-source-program-start.md#angular-einstieg) ist nun
unter „Mehrquellen-Sendung öffnen“ angeschlossen und liefert nach passender
Outputbestätigung den Programmref für diese Anfrageoberfläche. Layoutsteuerung,
Recovery, vollständige Handoff-/Standby-UI und die
gemeinsame öffentliche HLS-Abnahme bleiben in TBP-030 offen.
Kein Produktionsschalter wurde aktiviert.

## Eigene Controller-Quellen

Der zusätzliche geschlossene Request `create-own` enthält Programmrevision,
Programmepoch, gewünschte Quellenart, Raum, Gerätefingerprint und den expliziten
Benutzertrigger. Eine `targetPeerId` ist hier verboten; der Server setzt Owner und
Publisher auf dieselbe aktuell authentisierte menschliche Mitgliedschaft.
Der bisherige `create`-Befehl bleibt für Selbstanfragen gesperrt.

Die Antwort bleibt eine v1-Metadatenanfrage mit `authority: none`. Ihr bestehendes
JSON-Schema erlaubte bereits gleiche Peer-IDs; der Browser akzeptiert jetzt
diesen Fall, sofern er selbst beteiligt ist. Die Anfrage erteilt keine Schlüssel,
weist keinen Media-Agent zu und ersetzt weder Query noch ausdrücklichen Approve.
Alte Clients können diese neue Eigenquellenfunktion nicht bedienen.

Die UI braucht dafür keine entfernte Teilnehmerauswahl. Sie bestätigt zunächst
nur das Vormerken und kennzeichnet die Zeile als „Meine eigene Quelle“. Erst
die vorhandene Quellenprüfung und getrennte Entschlüsselungsbestätigung führen
zum aktuellen Publisher-Lease, Receiver-ACK und SFrame-Key-ACK. Dieselben
Vier-Quellen-, TTL-, Quota-, Scopewechsel- und Sofortwiderrufsgrenzen gelten;
ein Broadcast-Stopp beendet nicht den ursprünglichen Raumtrack.

59 gezielte Frontendtests sowie die neuen Server-, echten signierten HTTP- und
v4-Grantprüfungen bestehen. Der Vier-Quellen-Test verwendet die tatsächliche
serverseitige Publikationsepoch jeder Quelle, nicht pauschal Epoch 1.
Die erweiterte Angular-Tastaturprüfung nutzt weiter ausdrücklich simulierte
native HTTP-Antworten; sie ist kein Encoder-/HLS-Ende-zu-Ende-Nachweis.
Die gebaute Tastaturprüfung bestand in 3,753 Sekunden: Vormerken ohne entfernte
Auswahl, Abbrechen ohne Request, exaktes `create-own` ohne Ziel-ID, sichtbare
Eigenquellenzeile und kein automatisches Query/Approve. Null Capture und keine
zusätzliche PeerConnection. Gemeinsam bestanden 43 Node-/HTTP-/Grant-/UI-Fälle
in 10,521 Sekunden.

Die anschließende isolierte Gesamtregression an `e7d39e3` endete mit Exit 1:
1.095 Frontendtests und 1.011 Node-/Browsertests bestanden, zwei schlugen fehl,
zwei wurden ausdrücklich übersprungen (Node: 470,322 Sekunden). Eigenquellen-,
HTTP-, Grant- und Tastaturtests sowie beide nativen 401-Frame-Publisherfälle
bestanden; Build, Typen, Go und statische Gates ebenfalls. Die Fehler betreffen
einen SFrame-Start und die unabhängige Audiofortsetzung im Maschinen-Avatartest;
die [Diagnose](machine-live-media-clock.md#integrated-own-source-batch) bleibt
offen. Die externe Infrastrukturstufe wurde nicht erreicht. Der nachträglich
integrierte Commit `962f678` verändert nur Dokumentation/Todos; `129afa1` besitzt
identische Runtime-/Testdateien. Kein Deployment oder Opt-in und kein grüner
Release-Nachweis. TBP-030 bleibt mit seinem übrigen Umfang offen.
