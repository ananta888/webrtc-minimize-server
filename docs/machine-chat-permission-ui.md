# Ananta im Raumchat und in der Freigabeansicht

Live-Seitenleiste und Chatansicht verwenden dieselbe kleine, reine
Nachrichtendarstellung. Nur das aus aktueller Membership abgeleitete
`machine === true` kennzeichnet einen Beitrag als **KI-Nachricht**. Ein frei
gewählter Name wie „Ananta (KI)“, Textinhalt oder Antwortbezug erzeugt dieses
Badge nicht. Systemmeldungen erhalten es ebenfalls nicht.

**Antwort** zeigt einen vom Absender angegebenen Nachrichtenbezug. Die Anzeige
bestätigt weder dessen inhaltliche Richtigkeit noch LLM-Verarbeitung oder eine
menschliche Identität. Sie fügt keine neue Korrelation, Historie oder Autorität
hinzu. Chattext bleibt Angular-Interpolation, kein HTML/Markdown oder aktiver
Inhalt. Die bisherige begrenzte Historie gehört weiter dem Peer-Mesh-Service.
Ein Ansichtswechsel startet weder Capture noch neue PeerConnections.

Unter **Analyse → Ananta · Freigaben meiner Quellen** erklären feste Meldungen
unter anderem fehlende Hub-Rechte, inaktive Quellen, veraltete Auswahl,
Revisionskonflikte und geänderte Raumteilnahme. Ein ACK-Timeout wird ausdrücklich
als unbestätigte Aktion angezeigt: Die Änderung könnte bereits angekommen sein.
Es gibt weder behaupteten Rollback noch automatischen Retry oder Consent.

Nur bekannte, fest zugeordnete Fehlercodes erscheinen optional unter
**Technische Diagnose**. Die native `details`-/`summary`-Bedienung funktioniert
per Tastatur. Unbekannte Fehlerdetails werden nicht gespiegelt. Die Anzeige
verändert keine Serverpolicy, Membership, SFrame-Schlüssel oder laufende Quelle.

## Bedienung und Integrationsgrenzen

1. Einem Raum beitreten und **Analyse → Ananta · Freigaben meiner Quellen**
   öffnen. Der Betreiberstatus zeigt nur die Maschinenaufnahme, nicht die
   Erreichbarkeit eines Hubs oder die Bereitschaft eines Workers.
2. Sobald ein vom Hub autorisierter KI-Teilnehmer beigetreten ist, **Für diese
   KI einstellen** wählen. Nur eigene laufende Quellen und neue Chatbeiträge
   auswählen und die Freigabe ausdrücklich senden. Eine bloße Hub-Fähigkeit
   erteilt kein Empfangsrecht.
3. Die Serverbestätigung und deren Gültigkeit prüfen. KI-Antworten erscheinen
   sowohl in **Chat** als auch im Raumchat unter **Live** mit Kennzeichnung.
   Der agenteneigene Bildschirm ist eine unabhängige Publikation; seine
   Verfügbarkeit wird in Analyse getrennt von erlaubten Fähigkeiten angezeigt.
4. **Meine Freigaben widerrufen** beendet die eigenen Empfangsrechte. Eine
   Sitzungsverlängerung des Workers verlängert diese Freigaben nicht automatisch.

Das Panel installiert oder startet keinen Hub/Worker. Dessen Task- und
Projektpolicy bleibt in Ananta. Meet bietet die getrennten Empfangs-, Chat-,
Quellen- und [Sitzungsports](ananta-machine-session-lease.md); die
[bestätigte Ablösung einer alten Sitzung](machine-session-retirement.md)
ist kein automatischer Wiedereintritt und überträgt keine alten Freigaben.
Die öffentliche Aktivierung benötigt weiterhin die
[explizite Betreiberkonfiguration](machine-production-compose.md).

## Prüfungen

Die gezielten Tests prüfen unter anderem Namen ohne Identitätsautorität,
Antwortmetadaten, unveränderten Text, feste Fehlermeldungen, unbekannte Eingaben,
unsichere Diagnosewerte und die gemeinsame Darstellung in beiden Ansichten.
Die erweiterte echte Chromium-/Firefox-Dialogfixture prüft KI-/Antwort-Badges,
HTML-ähnlichen Text ohne Elementerzeugung, Chat/Live/Chat-Navigation ohne
Capture-/PeerConnection-Zuwachs und Tastaturbedienung der Diagnoseanzeige.
Sie behält den gemeinsamen Nachweis von 16.000 entschlüsselten PCM-Samples,
bewegtem agenteneigenem Bildschirm, drei Renewals und Rechteentzug bei.

Diese Darstellung ist keine öffentliche Maschinenfreischaltung. Der separate
Betreiberstatus und die Publisherfreigaben behalten ihre bisherigen Grenzen.
Offene Avatar-/Langzeitbefunde werden nicht durch einen grünen UI-Test geschlossen.

### Lokale Evidence vom 9. September 2026

Die 60 gezielten Frontendprüfungen bestanden. Der echte Dialog und die
Betreiberstatus-Ansicht bestanden in Chromium und Firefox: vier Fälle,
37,002 Sekunden, kein Skip. Jeder Dialog prüfte 16.000 PCM-Samples, bewegte
Bildschirmbilder, drei Renewals und Rechteentzug bei aktivem required-SFrame.
Die 18 separat ausgeführten Lease-/Retirement-/HTTP-Prüfungen bestanden
ebenfalls, einschließlich unveränderter Taskbindung und verspäteter alter
Retirement-Aufrufe. Das sind lokale synthetische Identitäten, keine öffentliche
Hub-Aktivierung.

Der erste isolierte UI-Gesamtcheck auf Basis `f714942` bestand 905 Frontend-
und 897 Nodeprüfungen, scheiterte aber an zwei Browserfällen (zwei weitere
Node-Skips, 424,253 Sekunden). Die Ablaufprüfung las den Zustand nach Ablauf
der Lease; der Mehrpublisherfall startete erneut vor bestätigter lokaler
Ablösung des alten Avatars. Ein gezielter unveränderter Wiederholungslauf
bestand alle vier Fälle in 43,486 Sekunden; das macht den ersten Lauf nicht
grün und beweist keinen behobenen Medienfehler.

Die Testbeobachtung wurde deshalb getrennt angepasst: Zustand und Messzeit
stammen im Ablaufvorfenster aus demselben Browsercallback. Im kontrollierten
Dreiteilnehmerfall muss der verbleibende Client seinen Zwei-Teilnehmer-Stand
und einen beendeten Avatar melden, bevor der einmalige Neustart versucht wird.
Die erste Version dieses Testhelfers nahm falsche Statusfelder an; die echten
Browserprüfungen deckten dies auf. Der korrigierte Helfer verwendet die reale
Teilnehmerzahl und die Avatarzustände `closed`/`failed`, keine erfundene
Peer-Liste oder `open`-Boolean. Keine Laufzeit-, Ablauf- oder Stopgrenze wurde
gelockert; die Avatar-`status()`-Abfrage nutzt die vorhandene Gültigkeitsprüfung,
ohne expliziten Close oder wiederholte Open-Aufrufe.

Die korrigierte Ablaufprüfung bestand in Chromium (18,601 s) und Firefox
(17,733 s). Nach Korrektur der Statusform bestanden die zwei Beobachtertests
und beide Mehrpublisher-Browserfälle zusammen in 12,328 Sekunden; die
Browserfälle benötigten 4,497 beziehungsweise 6,856 Sekunden.

Die separate GitHub-CI `34320122878` für den vorherigen Stand `0d3d1ea`
scheiterte am Compose-Auswahltest: erwartet war `disabled disabled`, die
Standardausgabe blieb leer. Die Ursache ist damit nicht nachgewiesen; es wurde
weder eine Timeoutgrenze angehoben noch eine Produktionsprüfung umgangen.
Der authentisierte TURN-Dialogjob dieses Laufs bestand, Docker-Build und
Keycloak-/TURN-Folgejob wurden übersprungen. Der Lauf ist kein Release-PASS.

Der nachfolgende gemeinsame Check auf `0d3d1ea` mit UI und korrigierten
Beobachtern endete mit Exit 0: **905 Frontendtests, 917 Nodeprüfungen,
null Fehler, zwei Node-Skips**; Node-Laufzeit 446,149 Sekunden. Build,
Typprüfung, Go-Unit/Vet und statische Gates bestanden. Die 14 externen
Infrastruktur-Gates und der optionale Image-Scan blieben sichtbar übersprungen.
Die 13 geänderten Frontend-/Testdateien waren abschließend bytegleich zum
isolierten Prüfkandidaten; Dokumentation und Todo-Evidence wurden anschließend
ergänzt. Der lokale Serving-Build blieb unverändert. Das schließt die lokale
Chat-/Darstellungsabnahme, nicht die öffentliche Hub-Freigabe, Langzeitmatrix
oder den gesamten Ananta-Track ab.
