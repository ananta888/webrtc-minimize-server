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
