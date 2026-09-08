# Ananta: Lesen und Antworten getrennt autorisieren

Der v2-Maschinengrant besitzt getrennte Rechte `chat.read` und `chat.send`.
Der Empfangspfad verlangte bislang trotzdem beide: Ein gültiger Nur-Lese-Agent
konnte seine Chat-Subscription nicht öffnen. Eine Queue-Regression reproduzierte
dies am 8. September 2026 mit `meet_chat_receive_denied` bereits beim Empfang.

Jetzt benötigt `chat.open/poll/ack` das aktuelle Leserecht und eine gültige eigene
Chatfreigabe des menschlichen Publishers. Ein reines Senderecht reicht weiterhin
nicht zum Empfang. Analyse zeigt diese Kombination unverändert als
„Leserecht möglich / Kein Senderecht“; sie ist nun tatsächlich benutzbar.
Es gibt weder automatische Freigabe noch Zugriff auf frühere Nachrichten.

`chat.reply` prüft zusätzlich das aktuelle Senderecht, bevor ein Antwortversuch
reserviert oder an den DataChannel übergeben wird. Die Prüfung verwendet die
aktuelle Autorität samt vollständiger Raum-/Task-/Sitzungsbindung. Ohne Senderecht
kommt `meet_chat_reply_denied`; die erlaubte Lese-Subscription bleibt offen.
Ein unbekannter Rechtewert wird nicht als Boolean interpretiert. Der eigentliche
Peer-Mesh-Sender prüft das Senderecht weiterhin unabhängig davon.

Lease-/Membership-/Policywechsel, Leserechtsentzug und Ablauf schließen dagegen
die Subscription und verwerfen ihre Puffer und Antwortkorrelationen. Nach einem
Renewal muss der berechtigte Controller ausdrücklich erneut öffnen. Die neue
Subscription spielt keine alte Historie ab. Ein Hub darf mit einem Renewal keine
zusätzlichen Rechte in die bestehende Sitzung einschleusen; der vorhandene
serverseitige Capability-/Scopevergleich bleibt unverändert.

Das ist eine Korrektur der Meet-seitigen Umsetzung bereits getrennter Rechte:
keine neue Grant-/Nachrichtenform, kein Ananta-Repository-Write und keine
produktive Hub-/Projektfreigabe. Bestehende Read-and-Reply-Clients bleiben
kompatibel. Ein Ananta-Dialogworkflow darf weiterhin selbst beide Rechte fordern,
wenn seine Aufgabe eine Antwort verlangt; Meet ergänzt sie niemals automatisch.

## Prüfungen

Queue-, Endpoint- und Angular-Serviceprüfungen decken Nur-Lesen, Sendesperre vor
und nach Zustellung, fehlende/abgelaufene Publisherfreigabe, Send-only, Entzug,
Renewal und unveränderte Scope-/Queue-/Replaygrenzen ab. Der zusätzliche reale
Chromium-/Firefox-Test verwendet synthetisch signierte Identitäten, echte
DataChannels, sichtbare Publisherfreigabe, einen Renewal und anschließenden
Widerruf. Er startet weder menschliche Capture-Geräte noch einen produktiven Hub.
Die bestehende Audio-/Chat-/Screen-/Drei-Renewal-Prüfung bleibt separat erhalten.
Aus dieser lokalen Prüfung folgt keine GPU-, TURN-, Langzeit- oder
Produktionsabnahme.

Am 8. September 2026 bestanden 19 Queue- und 16 Endpoint-/Serviceprüfungen,
45 kombinierte Admission-/Chat-/Receive-/Leasechecks und der Angular-Typcheck.
Die Nur-Lese-Browserprüfung bestand in Chromium (3,683 s) und Firefox (5,064 s).
Ihr erster Lauf scheiterte an fehlender Rücknavigation von Chat nach Analyse;
die Testnavigation wurde korrigiert, nicht die Widerrufslogik abgeschwächt.
Die bestehende vollständige Medienregression bestand ebenfalls in beiden
Browsern (12,687 / 14,287 s), jeweils mit 16.000 entschlüsselten PCM-Samples,
korrelierter Antwort, bewegten Bildschirmbildern und drei Renewals.

Der anschließende isolierte `npm run check` auf Basis `23f9517` endete mit
Exit 0: 721 Frontendtests, 787 erfolgreiche Nodeprüfungen, null Fehler und zwei
explizite Node-Skips (Node 347,383 s). Build, Go-Unit/Vet und statische Gates
bestanden; 14 externe Infrastruktur-Gates und der optionale Image-Scan blieben
ausdrücklich übersprungen. Im Prüfkandidaten lagen zusätzlich bereits vorhandene
Packager-v4-Vertragsänderungen; sie gehören nicht zum Ananta-Korrekturcommit.
Der laufend ausgelieferte lokale Build blieb unverändert. Der öffentliche
Server meldete weiterhin `admissionEnabled: false`. Commit, Remote-CI und
Deployment bleiben von diesen lokalen Ergebnissen getrennt.
