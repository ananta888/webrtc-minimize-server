# Öffentlicher Software-Rollout: 10. September 2026

Ausgeliefert ist `cb2e6e76300787459852212a69c32ebafb66282a`.
[CI 34461411187](https://github.com/ananta888/webrtc-minimize-server/actions/runs/34461411187)
ist in allen acht Jobs erfolgreich, einschließlich des großen Projektchecks,
Ananta-Dialog über authentisiertes TURN, Live-Keycloak/TURN und Docker.
Die uncommittete TLS-Testdiagnose ist ausdrücklich nicht Teil dieses Releases.

## Rollout und unabhängige Prüfung

Der Mini-PC-Checkout war sauber; seine eigenen früheren Commits bleiben im
Fast-forward von `5602ccf` enthalten. Unmittelbar vor dem normalen Deployment
war die Instanz gesund und leer. Auch während des Builds wurden null Räume
und Teilnehmer beobachtet. Der bestehende Drei-Image-Runner bestand Build,
Native-Preflight, Aktivierung und externen Smoke mit Exit 0.

- Web-App, Native-Packager und HLS-Origin laufen jeweils mit exakt `cb2e6e7`.
- Ein unabhängiger externer Smoke bestätigt Control Plane und Broadcast bereit,
  OIDC/SFrame erforderlich, Native-Ausgabe aktiv und WHIP aus.
- `image-set-v1` / `rollback.NTtRuv` bewahrt den vorherigen Drei-Image-Satz.
  Operation-Lock und einmalige Prüfcontainer sind entfernt.
- Der vor/nach dem Deployment intern verglichene SHA-256 der bestehenden
  Agent-Geräteidentität ist unverändert. Keine Identitätsvolumes wurden gelöscht.
- Öffentliches Release-Manifest bytegleich zum CI-Artefakt; alle fünf Downloads
  stimmen in Größe und SHA-256 überein. Das Manifest wurde unabhängig gegen
  Repository, Workflow, Main-Ref, exakte Revision und ausschließlich
  GitHub-gehostete Runner attestationsgeprüft.
- Die systemweite GitHub-CLI unterstützt diese Attestationsprüfung nicht.
  Die offizielle CLI 2.100.0 wurde nach SHA-256-Abgleich mit der veröffentlichten
  Release-Metadaten-Prüfsumme nur temporär verwendet; keine Systeminstallation.
- `GET /api/machine/integration` besteht das strikte JSON-Schema, antwortet mit
  `no-store` und meldet acht Softwarefähigkeiten, weiterhin Admission aus.
- Frische öffentliche Chromium-/Firefox-Kontexte bestätigen Secure Context,
  Encoded Transform und alle acht Client-Ports. Null Capture-Aufrufe,
  PeerConnections und WebSockets; kein Beitritt oder Schlüsselaufbau.

## Für die tatsächliche Hub-Teilnahme weiterhin notwendig

Die sechs gewünschten Grundfunktionen sind Meet-seitig integriert und als
Software ausgeliefert: Audioempfang, Chat, eigene Bildschirmquelle,
Sitzungserneuerung, Berechtigungen und Angular-Steuerung.
Die Übersicht liegt unter **Analyse → Ananta · Freigaben meiner Quellen**.

`machine-deployment-config.mjs` bleibt `disabled disabled` und die öffentliche
Admission bleibt `false`. Es wurde kein Hub-Trustprofil ausgewählt und kein
Ananta-Projektauftrag freigegeben. SSH-Zugriff ersetzt diese Auswahl nicht.
Hub-Trust, Ananta-Repository, Caddy/BBB und der lokale Serving-Build blieben
unverändert. Der Rollout ist keine produktive Hub-/Modell-/Medienabnahme und
kein Nachweis, dass der frühere Langzeitstillstand behoben ist.

Die separate Arbeitskopie mit der neuen TLS-Testdiagnose wird in einem festen
isolierten Checkout geprüft. Deren Ergebnis bleibt getrennt vom grünen
Release-CI-Nachweis; siehe [TLS-Diagnose](machine-tls-readiness.md).
