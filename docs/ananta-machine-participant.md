# Additiver Ananta-Maschinenclient

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
mit verweigerten menschlichen Capture-APIs und ein ausdrücklich synthetisches
lokales GPU-Demo-MP4 aus Ananta. Es prüft Chatempfang, dekodierte Videoframes,
empfangene Audiosamples und SFrame. Aktivieren über `MACHINE_E2E_VIDEO`;
ohne Datei wird dieser Hardware-Integrationsgate sichtbar übersprungen.

Die laufende öffentliche Instanz wurde nicht automatisch neu deployed oder
mit einem Testschlüssel freigeschaltet. Lokaler Erfolg ersetzt keinen
öffentlichen TURN-/Multi-Host-/Produktionsnachweis. Der Ananta-Haupttrack
`todo.meet-autonomous-agent-persona-media.json` bleibt für weitergehende
Persona-, Browserstream- und Dialogfähigkeiten offen.
