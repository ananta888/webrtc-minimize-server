# Ananta-Anbindung: Software, Betreibergrenze und Quellenfreigaben

`GET /api/machine/integration` ist eine additive, öffentliche, rein lesende
Schnittstelle mit dem geschlossenen Vertrag `ananta.meet-integration.v1`.
Sie enthält nur feste Funktionsnamen, die globale Capability-Obergrenze,
den bisherigen Admission-Status, zustimmungspflichtige Empfangsarten und die
implementierte Lease-Version. Keine Schlüssel, Issuer, Projekte, Teilnehmer,
Grants, Inhalte oder Verbindungsdaten werden ausgegeben.

Die Angular-Ansicht **Analyse → Ananta · Freigaben meiner Quellen → Betreiberstatus**
zeigt damit Audio-/Bildempfang, Chatlesen und -antworten, agenteneigenen Bildschirm
mit separat autorisiertem Ton, Sprache, Avatar und Sitzungserneuerung zusammen.
Die Funktionsübersicht ist auch bei ausgeschalteter Maschinenaufnahme sichtbar.

„Implementiert“ beschreibt die Meet-Schnittstelle, nicht Browserunterstützung,
erfolgreiche SFrame-Aushandlung oder laufende Worker-Verarbeitung. „Enthalten“
bezieht sich ausschließlich auf `MACHINE_ALLOWED_CAPABILITIES`: Es beweist weder
passenden Hub-Trust noch eine Projekt-, Task-, Raum- oder Publisherfreigabe.
Insbesondere kann ein Trustprofil enger sein oder keinen aktuell gültigen
Schlüssel enthalten. Die bestehende Admission-Anzeige wird dadurch nicht zu
einem vollständigen Readiness-Nachweis umgedeutet.

Empfang eigener Audio-/Bildquellen und neuer Chatbeiträge benötigt weiterhin die
explizite Freigabe im darunterliegenden Editor. Chatantworten benötigen einen
berechtigten Eingang und Korrelation. Synthetische Quellen sind nur innerhalb
der aktuellen Hub-/Worker-Sitzung erlaubt. Erneuerung erweitert weder Rechte
noch persönliche Quellenfreigaben. Reconnect-Steuerung bleibt beim Hub/Worker.

Der alte `/api/machine/capabilities`-Vertrag und `window.anantaMachine.capabilities()`
bleiben unverändert. Der lokale `probe()` bleibt die getrennte Browserprüfung.
Ein alter Server ohne neuen Vertrag erzeugt „nicht verlässlich abrufbar“, keinen
optimistischen Legacy-Fallback. Die Ansicht startet keine Aufnahme, Maschine,
Verbindung oder Policyänderung.

Der einmalige Abruf beim Öffnen sowie manuelle Aktualisierung verwenden keine
Credentials, folgen keinen Redirects und sind auf fünf Sekunden und 2 KiB
begrenzt. Alle Felder, Versionen und Capability-Listen werden geprüft; unbekannte,
doppelte oder ungeordnete Capability-Einträge sind ungültig. Fehler, Neubeginn,
Destroy und Ablauf nach 30 Sekunden entfernen die angezeigte Funktionsaufnahme.
Es gibt kein Hintergrundpolling. Die Tabelle ist horizontal scrollbar und per
Tastatur erreichbar; sie hängt nicht allein von Farbsignalen ab.

## Verifikation

19 Frontend- und zehn Node-/HTTP-/Trusttests bestanden. Sie prüfen echte
Serverprojektionen, striktes JSON-Schema, unveränderliche Kopien, eingeschränkte
und leere Obergrenzen, fehlenden Trust, unveränderten Legacy-Vertrag, null neue
Membership und die bestehenden Drei-Renewal-/Replay-Grenzen. Der erste
Schema-Lauf scheiterte an einer fehlenden expliziten Array-Typangabe im
`then`-Zweig; diese wurde korrigiert, ohne den strikten Validator abzuschalten.
Der isolierte Gesamtcheck auf `edc117f` plus dieser Ergänzung bestand mit
Exit 0: 1.192 Frontendtests und 1.091 Node-/Browserprüfungen, null Fehler,
vier ausdrücklich übersprungene Nodefälle (535,673 Sekunden Node-Lauf).
Build, Typprüfung, Go-Unit/Vet und statische Gates bestanden; 14 externe
Infrastruktur-Gates sowie der optionale Image-Scan blieben ausdrücklich
übersprungen. Der bestehende Serving-Build blieb bytegleich.

Die aktualisierten Chromium-/Firefox-UI-Fälle prüfen den realen TLS-Endpunkt,
alle neun Funktionszeilen, Tastaturfokus, eingeschränkte Obergrenzen und das
Entfernen veralteter positiver Anzeigen nach Fehlern. Aufnahme-, Verbindungs-
und Teilnehmerzahlen bleiben unverändert. Beide kombinierten Dialoge bestanden
mit jeweils 16.000 entschlüsselten PCM-Samples, Chatantwort, bewegten eigenen
Screen-Frames, drei Lease-Erneuerungen und Freigabeentzug; SFrame aktiv,
keine Transformfehler. Das ist keine öffentliche Hub-/Worker-Aktivierung
oder Zweistundenabnahme. Der inzwischen eingegangene reine Testdiagnostik-Commit
`c4ef486` war nicht Bestandteil dieses festen Gesamtprüfstands.

Dieser Upstream-Commit wurde danach unverändert und ohne Konflikt übernommen.
31 gezielte Docker-/TLS-/STUN-/TURN-/Integration-HTTP-Tests bestanden in
0,521 Sekunden; beide Bridge-Syntaxprüfungen und das Todo-Gate ebenfalls.
Es gab keine zusätzlichen Runtimeänderungen durch diese Zusammenführung.
