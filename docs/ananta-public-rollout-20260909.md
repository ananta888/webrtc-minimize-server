# Öffentliche Ananta-Softwareintegration: 9. September 2026

Ausgeliefert: `5a103382edab6e153c76bdf181dfec37d3c5fc91`.
CI `34380159740` ist in allen acht Jobs erfolgreich. Die vorausgehende
[isolierte Gesamtprüfung](machine-active-dialog-renewal.md) enthält den
gleichzeitigen Audio-/Chat-/Screen-Dialog mit drei aktiven Lease-Wechseln
in Chromium und Firefox. Diesen Gesamtcheck nicht mit der lokalen offenen
Broadcast-Arbeitskopie oder einer öffentlichen Hub-Abnahme gleichsetzen.

## Tatsächlicher Rollout

Vor Start waren der Mini-PC-Checkout sauber und die öffentliche Instanz leer
(null Räume, null Teilnehmer). Web-App, Native-Packager und HLS-Origin liefen
noch mit `92f583f`. Der normale `production-deploy.sh deploy` mit dem bestehenden
`bbb-edge`-Proxy-Netz bestand Build, Native-Preflight, Aktivierung und externen
Smoke mit Exit 0. Alle drei laufenden Image-Referenzen sind anschließend exakt
`5a10338`. Der gemeinsame Rücksprungsatz `image-set-v1` / `rollback.G61Ptl`
bewahrt die vorherigen drei Images. Operation-Lock und einmaliger
Preflightcontainer sind entfernt; keine Volumes wurden gelöscht.

Die Softwareänderung aktiviert weder Hub-Trust noch neue Quellenrechte.
`machine-deployment-config.mjs` bleibt `disabled disabled`. Das Ananta-Repository,
die Betreiberpolicy und der lokale Serving-Build wurden nicht geändert. Die
uncommittierten Broadcast-Encoderänderungen sind nicht Teil dieses Deployments.

## Unabhängige öffentliche Prüfungen

- Zweiter externer Smoke: Control Plane und Broadcast bereit; OIDC und SFrame
  weiterhin erforderlich, Raumgrenze 20, native Ausgabe aktiviert, WHIP aus.
- `GET /api/machine/integration`: HTTPS 200, JSON, `Cache-Control: no-store`,
  striktes `ananta.meet-integration.v1`-Schema erfolgreich geprüft. Alle acht
  Softwarefähigkeiten und der Lease-Vertrag vorhanden; Admission weiterhin aus.
- `/machine` in echten frischen Chromium- und Firefox-Kontexten: installierter
  Client-Probe, Secure Context und Encoded Transform vorhanden, alle acht
  angegebenen Ports implementiert. Null Capture-Aufrufe, WebSockets oder
  PeerConnections; kein Beitritt, keine Geräte- oder Quellenfreigabe.
- Öffentliches Release-Manifest bytegleich zum CI-Artefakt; alle fünf Downloads
  stimmen in Größe und SHA-256 mit dessen Einträgen überein. Das CI-Manifest
  wurde unabhängig gegen Repository, Workflow, Main-Ref, exakte Quellrevision
  und den Ausschluss selbst gehosteter Runner attestationsgeprüft.
- 15 gezielte lokale Integrations-/Lease-/Trust-Tests bestanden ohne Skip oder
  Fehler; Todo-Validierung: 28 Dokumente. Keine neue Vollprüfung der offenen
  Broadcast-Arbeitskopie wird daraus abgeleitet.

Der zuerst aufgerufene systemweite `gh` unterstützt `attestation` noch nicht.
Die anschließende erfolgreiche Prüfung verwendete das bereits vorhandene
isolierte `gh 2.100.0`; keine Systeminstallation wurde geändert.

## Jetzt im Browser und weiterhin erforderlich

Nach Anmeldung und Raumbeitritt:
**Analyse → Ananta · Freigaben meiner Quellen → Betreiberstatus**.
Die Übersicht unterscheidet implementierte Funktionen, globale Betreibergrenze
und notwendige eigene Quellenfreigaben. Die freigegebenen KI-Teilnehmer werden
erst nach einem tatsächlich autorisierten Hub-Beitritt angezeigt.

Für diesen Beitritt muss der Betreiber noch ein konkretes öffentliches
Ed25519-Hub-Trustprofil mit exaktem Issuer, Subject, Tenant, Projekt und
Capability-Obergrenze auswählen. Ananta benötigt unabhängig davon den
freigegebenen Projektauftrag und einen geeigneten Worker. Vorhandener SSH-Zugang
oder ein gemeinsames Benutzerkonto sind dafür kein Ersatz. Private Hub-Schlüssel
werden nicht nach Meet kopiert. Nach der Konfiguration folgen der vorhandene
Rollout-Preflight und eine separat vorautorisierte gemeinsame Live-Abnahme.

Die öffentliche Probe beweist Softwareverfügbarkeit, nicht ASR-/LLM-Verarbeitung,
eine produktive Hub-Verbindung, Medienlieferung oder die noch offene
Zweistundenabnahme. MDS-09 und der Gesamttrack bleiben deshalb offen.

Während des Dokumentations-Pushs ging `0c75dea` ein und wurde konfliktfrei
übernommen. Dieser Nachtrag hält den separaten Langzeitfehler auf festem
Ananta `d29d1780a` / Meet `c4ef486` fest: `screen_not_moving` bei Lease-Generation
36 nach rund 36 Minuten. Ursache und Behebung sind nicht nachgewiesen;
`5a10338` wird nicht als Fix dieses Fehlers ausgegeben. Die eingehende
Testhistorie bleibt vollständig erhalten; nur der eigene noch ungepushte
Dokumentationscommit wurde neu aufgesetzt. Die übrige getrackte Arbeitskopie
blieb dabei im Vergleich ihres binären Git-Diffs identisch.
