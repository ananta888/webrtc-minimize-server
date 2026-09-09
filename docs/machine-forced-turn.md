# Ananta-Dialog über erzwungenes TURN

Der vorhandene Meet-Dialogtest kann zusätzlich über `turn-udp` und `turn-tcp`
laufen. Beide Varianten prüfen Chromium und Firefox als menschliche Gegenstelle;
der isolierte Maschinenclient läuft weiterhin in Chromium. Das ist keine Aussage
über einen nativen Ananta-Worker oder dessen GPU-/ASR-/LLM-Ausführung.

```bash
MACHINE_DIALOG_ICE_PATH=turn-udp node --test test/machine-dialog.browser.e2e.test.js
MACHINE_DIALOG_ICE_PATH=turn-tcp node --test test/machine-dialog.browser.e2e.test.js
```

Ohne diese Variable bleibt der bestehende Direct-Test unverändert. Unbekannte
Werte werden abgelehnt. Der Build muss vorher vorhanden sein; ein ausdrücklich
gewählter isolierter Build kann über `MEET_TEST_PUBLIC_DIR` eingebunden werden.
Voraussetzungen sind Linux mit Docker und installierten Playwright-Browsern sowie
die lokalen Images `coturn/coturn:4.17.0` und `webrtc-ci-local-webrtc:latest`.
Für den reinen TCP-Proxy genügt alternativ `MEET_TEST_PROXY_IMAGE=node:22-alpine`.
Die Fixture zieht selbst keine Images nach, sondern pinnt vorhandene Images auf
ihre unveränderliche Image-ID. Fehlende Voraussetzungen schlagen sichtbar fehl.
Der separate CI-Job stellt Browser, synthetischen Audio-Clock und Images bereit
und führt beide Transportvarianten aus; der reguläre Gesamtcheck behält Direct.

## Isolation und Aussage

Jeder Fall besitzt ein eigenes internes Docker-Netz, einen opaken TLS-Proxy und
einen authentisierten Coturn mit zufälligem temporärem REST-Secret. Keine Hostports,
Host-Capture-Geräte, produktiven Schlüssel oder offenen Internet-Relays werden
verwendet. Coturn darf nur seinen eigenen Relay-Endpunkt als Peer erreichen.
UDP-Relay-Ports sind auf 49160–49191, die Gesamtzahl der Allocations auf 16 und
die Prozessressourcen sowie Laufzeit begrenzt. TCP bezeichnet den Transport zum
TURN-Listener, nicht TURN/TLS oder einen TCP-Mediencodec. Der jeweils andere
Client-Listener ist aus. Cleanup entfernt genau die eigenen Container und das
eigene Netz, einschließlich fehlgeschlagener Setups.

Die Fixture lässt Docker zunächst einen freien privaten Adresspool wählen und
reserviert ihn vor dem Containerstart erneut als explizites internes Subnetz.
Dabei wird nur das eigene, noch leere UUID-Netz entfernt. Ein konkurrierend
belegter Pool oder eine abweichende IPAM-Rückmeldung beendet den Aufbau; es gibt
keinen Adressscan, kein Ausweichen auf Hostnetzwerke und keine geratenen IPs.
Das berücksichtigt die [statische-IP-Prüfung in Docker 28](https://github.com/moby/moby/blob/v28.0.4/api/types/network/endpoint.go#L105-L125).

Der private Browseradapter übernimmt ausschließlich die REST-Credentials aus
der **tatsächlich erfolgreichen, autorisierten Session-Antwort** desselben
Browsers. Er erzeugt keine zusätzliche Session oder HTTP-Anfrage und verändert
keinen Grant. Öffentliche Konfiguration, fremde Origins, unbekannte Credentials
oder abgelehnte Sessions reichen nicht. Die Testverbindung nutzt diese Server
von Anfang an mit `iceTransportPolicy=relay`, auch nach `setConfiguration`.
Das prüft den erzwungenen TURN-Medienpfad, **nicht** die normale verzögerte
Direct→Edge→Infrastruktur-Auswahl der Anwendung.

Nach einer begrenzten ICE-/DTLS-/SCTP-Aufbauphase gelten unverändert die
Audio-/Frame-/Lease- und Widerrufsbudgets. Eine maximal 1,5 Sekunden lange reine
Stats-Beobachtung wartet auf ein konsistentes ausgewähltes Paar; sie wiederholt
keine Freigabe oder Medienaktion. Auf **beiden** Gegenstellen müssen ausgewählte,
erfolgreiche Relay-Paare und steigende Bytezähler in beiden Richtungen vorliegen.
Gesammelte Kandidaten oder ein bloßes `connected` genügen nicht.
Zusätzlich werden echte entschlüsselte PCM-Samples, korrelierter Chat, gerenderte
wechselnde Bildschirmpixel, drei Renewals und der Entzug laufenden Audioempfangs
geprüft. Berichte enthalten nur feste Zustandswerte und Zähler, keine Credentials,
SDP, Kandidatenadressen oder Inhalte.

## Getrennt offene Fallback-Frage

Der erste Fixture-Ansatz erzwang Relay, ließ aber zunächst die leere Direct-Stufe
stehen; TURN wurde erst nach den normalen neun Sekunden zugeschaltet. Firefox
zeigte dabei geschlossenes SCTP trotz später verbundenem ICE/DTLS. Dieser
negative Nachweis bleibt erhalten. Er beweist weder einen funktionierenden
verzögerten Fallback noch pauschal einen Fehler des normalen Produktionspfads,
der anfänglich nicht auf Relay beschränkt ist. Die echte Stufenumschaltung bei
blockiertem Direct-Pfad benötigt weiterhin einen eigenen Nachweis, ebenso
öffentliche NAT-/TURN-TLS-Pfade, Blind-Agent, Live-Hub/Worker und Langzeitbetrieb.
Der Gesamttrack wird aufgrund dieses TURN-Teilgates nicht abgeschlossen.

## Lokale Verifikation

Am 9. September 2026 bestanden 19 gezielte Helper-/Negativprüfungen. Die finale
Dialogmatrix bestand über UDP in Chromium (17,116 s) und Firefox (19,062 s),
über TCP in Chromium (16,018 s) und Firefox (17,667 s). Jeder Fall prüfte
16.000 entschlüsselte PCM-Samples, korrelierten Chat, wechselnde Bildschirmpixel,
drei Lease-Erneuerungen und Widerruf bei laufendem Audioempfang. Beide Endpunkte
meldeten jeweils genau ein ausgewähltes Relay-Paar mit tatsächlich steigenden
Bytes in beiden Richtungen; kein Transformfehler wurde beobachtet. Alle eigenen
TURN-Container und Testnetze waren anschließend entfernt.

Diese Läufe verwenden den geprüften isolierten Browserbuild des Freigabefixes
`92f583f`. Gesamtcheck und neue CI-Stufe werden separat protokolliert. Der
Software-Rollout von `92f583f` ist davon unabhängig; er aktiviert keinen Hub-Trust
und enthält diese nachfolgende Testintegration noch nicht.

Der isolierte `npm run check` auf Basis von `92f583f` einschließlich dieser
Test-/CI-Erweiterung bestand anschließend mit Exit 0: 765 Frontendtests,
807 erfolgreiche Nodeprüfungen, null Fehler und zwei explizite Node-Skips
(Node 346,856 s). Build, Go-Unit/Vet und statische Gates bestanden. Die 14
externen Infrastruktur-Gates und der optionale Image-Scan blieben sichtbar
übersprungen. Die neue externe CI-Stufe wird erst nach dem Push separat geprüft.

## Erster externer CI-Lauf

CI `34287511029`, TURN-Job `102266395034`, scheiterte am 9. September
2026 bereits beim Erstellen des TLS-Proxy-Containers; beide Browser wurden
noch nicht gestartet, TCP wurde anschließend übersprungen. Der identische
Fixture-Aufbau mit `node:22-alpine` und Coturn startete lokal erfolgreich.
Die Ursache ist damit noch nicht bestimmt. Eine geschlossene Fehlerprojektion
ergänzt deshalb feste Docker-Operations-, Exit- und Ursachencodes. Sie gibt
keine ursprünglichen Fehler, Argumente, Secrets oder Netzwerkadressen aus und
ändert weder Containerlimits noch Transport-/Medienbudgets. Der Bridge behält
seinen bisherigen maschinenlesbaren Fehlercode. Drei isolierte Diagnose-Tests
und die 13 zugehörigen Proxy-/TURN-Checks bestanden; der externe Ursachenbefund
und die Gesamtregression stehen noch aus. Dies ist Diagnose, kein Fixnachweis.

Nachtrag: Die Diagnose-Revision `2237643` bestand den vollständigen CI-Gesamtcheck
mit 811 Nodeprüfungen, null Fehlern und zwei expliziten Skips; der zusätzliche
TURN-Job blieb vor dem Browserstart rot. Mit der expliziten Subnetzreservierung
in `b29fa60` bestand anschließend der TURN-Job `102272933695` in CI `34289593981`
vollständig: UDP und TCP jeweils mit Chromium und Firefox. Der lokale UDP-Lauf
bestand in 37,889 s, TCP in 37,626 s. Die Schutz- und Medienbudgets blieben
unverändert. Dies behebt den konkreten CI-Netzaufbau, nicht die getrennt offene
verzögerte ICE-Stufenumschaltung oder öffentliche NAT-/Hub-/Agent-Pfade.
