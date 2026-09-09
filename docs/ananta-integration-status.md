# Ananta-Hub und Worker: Integration und Aktivierung

Stand: 9. September 2026. Implementierung, lokale Integration und öffentliche
Aktivierung sind unterschiedliche Zustände. Die öffentliche Meet-Instanz meldet
bei der aktuellen Prüfung `admissionEnabled: false`: Noch kein produktiver
KI-Beitritt. Der gesamte aktive Ananta-Track ist nicht abgeschlossen.

| Bereich | Vorhandener Meet-Pfad | Grenze |
| --- | --- | --- |
| Audioempfang | Eigener autorisierter Browser-Endpunkt, begrenztes PCM16/16-kHz-Mono, Quellen-/Epoch-Bindung und Stop bei Entzug | ASR und Modellauswahl gehören zum Worker; keine Audio-HTTP-Route im Signaling |
| Chat | Freigegebene neue DataChannel-Ereignisse, Cursor/ACK, begrenzte korrelierte Antworten und KI-Kennzeichnung | Kein pauschaler Zugriff auf Historie; Lesen und Senden sind getrennte Rechte |
| Eigener Bildschirm | Hub-sessiongebundene synthetische Quelle, begrenzte Frames, unabhängig von Avatar/Sprache; eigener optionaler Tonport | Kein menschlicher Desktop, Browserprofil oder automatischer Capture-Dialog |
| Sitzungen | Frische signierte Grants, P-256-Renewal, Generationen, feste Gesamtdauer und exakte alte Session-Retirement | Reconnect-Steuerung gehört zum Hub/Worker; alte Quellenfreigaben werden nicht übernommen |
| Angular | Analyse-Panel für Betreiberstatus, KI-Teilnehmer, eigene Quellen, Ablauf, Bestätigung und Widerruf | Eine Capability oder ein Remote-Track beweist keine aktive Modellverarbeitung |

Die lokale Chromium-/Firefox-Dialogprüfung verbindet Audioempfang, Chat, bewegte
Screen-Frames, drei Lease-Wechsel und Freigabeentzug unter required-SFrame.
Private verpackte Hub-/Worker-Prüfungen existieren zusätzlich. Sie sind keine
öffentliche Projektfreigabe und ersetzen nicht die verbleibende gemeinsame
Langzeit-/Reconnect-Abnahme. Der neue
[Page-Lifecycle](machine-page-join-lifecycle.md) verhindert insbesondere einen
offenen Beitritt nach Welcome-Timeout und das Beenden einer neuen Sitzung durch
eine verspätete alte Operation.
Der [Bildschirm-Endpoint](machine-screen-endpoint-cleanup.md) versucht außerdem
Bild- und Tonstopps unabhängig, damit ein einzelner Cleanupfehler den jeweils
anderen Stop nicht überspringt. Nach fehlgeschlagenem Cleanup startet er keine
Ersatzquelle.

Die inzwischen integrierte optionale [Quellen-Zeitüberwachung](machine-live-media-clock.md)
beobachtet Sprache, Avatar und agenteneigenen Bildschirm getrennt. Sie stoppt
veraltete oder zeitlich unplausible eigene Quellen, erweitert aber keine
Berechtigung oder Sitzung. Der Worker muss das Profil ausdrücklich aushandeln;
es ist weder ein Nachweis von Lippen-Synchronität noch von Empfang beim Publikum.

Die gebündelte Prüfung mit `28eff78` und dem neuen Quellenfreigabe-Workflow
bestand 1.012 Frontendtests und 975 Nodeprüfungen; drei Browserfälle scheiterten,
zwei Prüfungen wurden ausdrücklich übersprungen. Der gemeinsame Consent-/Chat-/
Audioempfang-/Screen-Dialog mit drei Erneuerungen bestand in Chromium und Firefox.
Offen sind die Chromium-Beobachtung unmittelbar vor Lease-Ablauf, eine fehlende
Avatar-Zeitzeile nach dem Screenstop unter Firefox sowie ein vorzeitig beendeter
separater Chromium-Sprachausgang. Die Ursache ist noch nicht belegt; dieser
Stand ist keine abgeschlossene Integrationsabnahme. Die externe
Infrastrukturstufe wurde nach den Fehlern nicht mehr ausgeführt.

Die anschließende gezielte Nachprüfung bestand alle sieben Fälle der drei
betroffenen Browserdateien in 64,989 Sekunden. Zwei konkrete Testschwachstellen
sind korrigiert: Die synthetische Sprachzufuhr wartet nach dem Öffnen nicht mehr
auf die Empfänger-UI; der Lease-Test liest einen geschlossenen Statuswert über
den bereits vorhandenen Host-Poller. Die ursprünglichen Laufzeitgrenzen bleiben
unverändert. Die fehlende Avatar-Zeitzeile trat nicht erneut auf und ist nicht
als kausal behoben einzustufen. Eine begrenzte Fehlerprojektion erhält künftig
Quellzustände und Fortschrittszähler, aber keine Inhalte oder rohen Fehlertexte.
Der frühere Gesamtcheck wird durch diesen Nachlauf nicht nachträglich grün;
die nächste Gesamtregression folgt gebündelt mit der weiteren Implementierung.

Der anschließende Stand `0a63b05` bestand den isolierten Gesamtcheck mit
1.078 Frontend- und 989 Node-/Browsertests, null Fehlern und zwei Node-Skips.
Die 14 externen Infrastrukturprüfungen blieben ausdrücklich übersprungen.
Neue interne Fehlerkategorien grenzen die sporadischen Quellenabbrüche ein;
eine kausale Behebung dieser Intermittenz ist damit weiterhin nicht behauptet.

Die aktuelle Lifecycle-Ergänzung sperrt einen Client nach unbestätigtem
Ressourcenstopp für weitere Beitritte. Ein neuer Grant oder ein späterer leerer
Cleanup-Aufruf hebt diese Sperre nicht auf. Die Maschinenansicht erklärt den
erforderlichen frischen Browserkontext; alle unabhängigen Stopps werden weiterhin
versucht. 26 fokussierte Lifecycle-/Renewalprüfungen bestehen. Der neue Gesamtcheck
bestand 1.085 Frontend- und 986 Nodeprüfungen, scheiterte aber an drei separaten
Avatar-/Quellenzeitfällen (zwei Node-Skips). Die kombinierten Dialoge bestanden
in beiden Browsern; die externe Infrastrukturstufe wurde nicht erreicht.
Im gezielten Nachlauf bestehen sechs von sieben Fällen, der Controller-Frische-
Abbruch bleibt reproduzierbar und ursächlich offen. Das ist keine vollständige
Integrationsabnahme und noch kein Deployment des Nachtrags.

## Im Browser

1. Dem Raum beitreten und **Analyse → Ananta · Freigaben meiner Quellen** öffnen.
2. Nach dem separat autorisierten Hub-Beitritt den KI-Teilnehmer auswählen.
3. Eigene bereits laufende Audio-/Bildquellen beziehungsweise neue Chatbeiträge
   auswählen und ausdrücklich freigeben. Die Serverbestätigung abwarten.
4. Bildschirm und Sprache des Agenten erscheinen als getrennte Publikationen
   in der bestehenden Live-Ansicht; Antworten sind im Chat als KI markiert.
5. Eigene Freigaben lassen sich im Analyse-Panel widerrufen. Verlängert der Hub
   seine Sitzung, verlängert das diese Quellenfreigaben nicht automatisch.

Das Öffnen dieser Ansicht startet keine Aufnahme und keinen Worker.

## Noch notwendig für öffentliche Teilnahme

- Ein vom Betreiber ausgewähltes Hub-Trustprofil: exakter Issuer, ausschließlich
  öffentlicher Ed25519-Schlüssel, Subject, Tenant, Projekt und Capability-Obergrenze.
- Ein in Ananta separat freigegebener Projektauftrag sowie ein geeigneter Worker.
- Zusammenpassende freigegebene Revisionen, Preflight und kontrollierter Rollout
  über die vorhandene [Maschinen-Deployment-Konfiguration](machine-production-compose.md).
- Aktuelle Membership und die jeweiligen Publisherfreigaben im Raum.

Das Profil wird weder aus einem gemeinsamen Login noch aus vorhandenen
SSH-Schlüsseln abgeleitet. Keine privaten Hub-Schlüssel nach Meet kopieren.
Das Ananta-Repository bleibt bei Meet-seitigen Änderungen unverändert.

Die alten `chatEvents`-/`audioSubscription`-/`screenPublication`-Booleans von
`/api/machine/capabilities` gehören zum unveränderten v1-MP4-Vertrag. Sie sind
keine vollständige Auflistung der neueren Browserports; dafür gibt es den
separaten lokalen [Client-Probe](machine-client-probe.md). Weder Probe noch
`admissionEnabled: true` beweisen einen verbundenen Hub oder laufenden Worker.
