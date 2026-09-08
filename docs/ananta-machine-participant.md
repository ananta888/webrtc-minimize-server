# Additiver Ananta-Maschinenclient

## Aktueller Dialogpfad (v2)

Der ursprüngliche MP4-Einstieg weiter unten ist nicht mehr der gesamte
Funktionsumfang. Der isolierte `/machine`-Client stellt inzwischen getrennte,
autorisierungsgebundene Ports bereit:

| Funktion | Meet-Port / Grenze |
|---|---|
| Audio empfangen | `.audio`: ausschließlich aktuell freigegebene fremde Mikrofon-/Bildschirmtonpublikationen; begrenzte PCM-Chunks mit ACK, kein Klartext-Audio am Signaling-Server |
| Chat lesen und antworten | `.chat`: freigegebene neue Beiträge, begrenzter Cursor/ACK, korrelierte Antworten und getrennte Lese-/Senderechte |
| Agenteneigener Bildschirm | `.screen`: gebundene synthetische Bildquelle; `.screenAudio` als separat erlaubter und stoppbarer Ton; kein menschliches Desktop-Capture |
| Avatar und Sprache | `.avatar` und `.speech`: unabhängige synthetische Quellen; `.media` für begrenzte MP4-Clips |
| Sitzungsverlängerung | `.renew`: frischer Hub-Grant, serverseitige Rechteprüfung, gleiche Session mit neuer Lease-Generation; maximal zwei Stunden Gesamtzeit |
| Fähigkeiten erkennen | `.probe()`: installierte Ports und lokale Browser-Eignung, keine Autorisierung oder Laufzeitbestätigung |
| Menschliche Kontrolle | Analyse → Ananta: [Betreiberstatus](machine-admission-status.md), [eigene Quellenfreigaben](machine-consent-editor.md) und getrennte Remote-Track-Anzeige |

Der [Rollout-Leitfaden](machine-rollout.md) beschreibt Aufrufe, Grenzen und
separate Stops; [Sitzungs-Leases](ananta-machine-session-lease.md) beschreiben
Renewal und Fencing. Die Meet-seitige Chromium-/Firefox-Dialogfixture prüft
Audio, Chat, bewegte Bildschirmpixel und drei Renewals gemeinsam. Das ersetzt
weder eine aktuelle Hub-/Worker-/Netzwerkabnahme noch produktiven Trust.
Die Implementierung ist kein pauschales Recht zum Zuhören: Betreiber-Trust,
Ananta-Projektauftrag und aktuelle Freigaben betroffener Publisher bleiben
getrennte Voraussetzungen. Änderungen im Ananta-Repository gehören nicht zu
diesem Meet-Implementierungsauftrag.

## Ursprünglicher kompatibler MP4-Einstieg (v1)

Standardmäßig ist die Maschinenaufnahme deaktiviert. Human-OIDC, P-256-
Gerätebeweis und menschlicher Capture-Klick bleiben unverändert.

Ein Betreiber kann einen dedizierten Ed25519-Hub-Schlüssel über
`MACHINE_HUB_PUBLIC_KEY_FILE` und einen exakten HTTPS-Issuer über
`MACHINE_HUB_ISSUER` vertrauen. Private Signierschlüssel gehören ausschließlich
zum Hub. Human-, Service- und Worker-Bearer-Tokens werden dadurch nicht gültig.

Der Hub signiert einen JWT mit Typ `ananta-meet-machine+jwt`, Audience
`ananta-meet-machine-v1` und exakt den Feldern `iss`, `aud`, `sub`, `iat`,
`exp`, `jti`, `roomId`, `taskId`, `tenantId`, `projectId`. Erstaufnahme innerhalb
60 Sekunden, Sitzungsdauer höchstens 600 Sekunden. Der Join ist ausschließlich
`mode=room`, mit Namen **Ananta (KI)** und frischem normalem Gerätebeweis an
`POST /api/machine/sessions` zulässig. Der Server gibt ein einmaliges
origin-gebundenes WebSocket-Ticket aus und beendet die Verbindung bei Ablauf.
Replay-Schutz und Membership sind wie der übrige Room-State instanzlokal;
HA oder Restart-übergreifende Session-Fortsetzung werden nicht zugesichert.

Der dedizierte Browserpfad `/machine` stellt `window.anantaMachine` für einen
isolierten automatisierten Controller bereit: `join(roomId, grant)`,
`publish(text, mp4Base64)`, `status()`, `leave()`. Kein PostMessage-Listener,
kein Token in URLs/Storage und keine menschliche Capture-API. Die Quelle ist
ein begrenzter generierter MP4-Clip, Kamera-/Audio-Tracks laufen über das
vorhandene Mesh mit **required SFrame**. Bildschirm-, Relay- und Packager-
Kontrollaktionen werden dem Maschinenprincipal nicht gewährt. Die Anwendung
bezeichnet den Teilnehmer sichtbar als KI; `camera`/`microphone` bleiben nur
die rückwärtskompatiblen technischen Quellnamen.

Der Ananta-Worker übernimmt pro Hub-Auftrag Erzeugung, Join, Chat-/Audio-/
Videopublikation und Leave. Er prüft während der Publikation seine aktuelle
Hub-Lease. Kein Dauerzuhören, keine automatische Reaktion auf fremde Chats,
keine Aufzeichnung und keine Erweiterung der Room-Rolle sind Teil dieses Slice.
Fehlende Gegenstelle, E2EE-Capability, Freigabe oder Codec-Unterstützung führt
zu einem begrenzten Fehler.

Verifikation: `test/machine-admission.test.js` prüft synthetische Grants,
falsche Scope-/Zeit-/Key-Bindungen, Human-Auth, Gerät und echten WebSocket-
Ablauf. `test/machine.browser.e2e.test.js` verwendet zwei isolierte Browser
mit getrennten Rollen: eine kryptografisch geprüfte synthetische menschliche
Identität empfängt von einem v1-Maschinenpublisher. Der Maschinenbrowser verweigert
menschliche Capture-APIs. Ein ausdrücklich synthetischer lokaler MP4-Clip prüft
Chatempfang, dekodierte Videoframes, Audiosamples und SFrame. Aktivieren über
`MACHINE_E2E_VIDEO`; ohne Datei wird dieser Mediengate sichtbar übersprungen.
Ein CPU-generierter Testclip ist hierfür zulässig, beweist aber keine GPU-Inferenz
oder Ausführung von Anantas Modellprofil. Der separate v2-Dialogtest steht in
`test/machine-dialog.browser.e2e.test.js` und benötigt keinen MP4-Clip.

Die laufende öffentliche Instanz wurde nicht automatisch neu deployed oder
mit einem Testschlüssel freigeschaltet. Lokaler Erfolg ersetzt keinen
öffentlichen TURN-/Multi-Host-/Produktionsnachweis. Der Ananta-Haupttrack
`todo.meet-autonomous-agent-persona-media.json` bleibt für weitergehende
Persona-, Browserstream- und Dialogfähigkeiten offen.
