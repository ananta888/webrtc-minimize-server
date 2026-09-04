# Broadcast-Failover und Disaster-Recovery

Stand: 2026-09-04. Diese Beschreibung gilt für den optionalen Trusted-Broadcast-Zweig. Das interaktive WebRTC-Meet und seine SFrame-Verbindungen bleiben davon unabhängig.

## Writer-Modell

`BroadcastFailoverCoordinator` verwaltet je Tenant/Program und Rolle höchstens einen aktiven Writer:

- `packager-writer` erhält nach erfolgreicher Auswahl eine kurzlebige Berechtigung für Quellen und Decrypt-Verarbeitung.
- `gateway-writer` erhält ausschließlich seine Gateway-Writer-Berechtigung.
- Jede Übernahme erhöht die monotone Fencing-Revision. Lease-ID, Holder, Revision und Ablauf müssen bei jedem Writer-Kommando exakt übereinstimmen.
- Ein Heartbeat verlängert eine Lease nur bei gesundem Holder und Mehrheitsquorum. Ein falscher oder alter Fence wird abgewiesen.
- Nach Ablauf beginnt eine feste Grace Period; danach gewinnt der gesunde, quorumfähige Kandidat mit höchster Priorität. Gleichstände werden stabil nach pseudonymem Holder- und Device-Ref aufgelöst.

Standbys sind freiwillig und bleiben `access: none`. Erreichbarkeit genügt nicht. Eine Übernahme setzt einen noch gültigen `approved`- oder `preauthorized`-Consent voraus. Erst die Promotion erzeugt die rollenbezogene Zugriffsfreigabe. Ein alter Writer verliert mit der höheren Fencing-Revision sofort jede Autorität.

## Ausfälle und sichtbares Verhalten

Geschlossene Health-Signale unterscheiden Writer/Packager, Browserquelle, Gateway, Host, Netzwerk und Provider. Ein sicher übernehmbarer Fehler erzeugt:

1. Fence und Cleanup des alten Writer-Pfads,
2. eine neue Lease mit höherer Fencing-Revision,
3. eine HLS-Discontinuity,
4. einen kontrollierten Player-Neustart.

Eine verlorene Browserquelle, ein fehlender autorisierter Standby oder das überschrittene Recovery-Zeitbudget führt stattdessen zu einem sichtbaren Stop. Es gibt keinen ungeprüften Fallback und keine parallele Publikation.

Standardbudgets sind 15 Sekunden Lease-TTL, 5 Sekunden Grace Period und 30 Sekunden Recovery-Fenster. Deploymentprofile dürfen innerhalb der im Code geprüften Grenzen engere Werte wählen.

## Wiederherstellbarer Zustand

Der Snapshot enthält nur Scope/Epochen, pseudonyme Holder-/Device-Referenzen, Fences, Zeitmarken, Fehlerklassen und eine auf 256 Einträge begrenzte idempotente Outbox. Er enthält insbesondere keine:

- Audio-, Video- oder Bildschirmdaten,
- SFrame- oder Decrypt-Schlüssel,
- Caption-Texte oder Transcripts,
- SDP-, ICE-, Token-, Raumcode- oder IP-Inhalte.

Snapshots werden beim Restore geschlossen validiert. Unbekannte Felder, falsche Scopes, ungültige Rollen, überhöhte Fences und verbotener Recovery-State werden fail-closed abgewiesen. Kandidaten und ihre Zugriffsfreigaben werden bewusst nicht persistiert; sie müssen nach einem Control-Plane-Neustart frisch registriert und autorisiert werden.

## Verifikation und verbleibende Betriebsgrenze

`test/broadcast-failover-coordinator.test.js` simuliert Packager- und Gateway-Abbruch nach Lease-Ablauf, Grace Period und anschließender Übernahme. Der Test belegt den höheren Fence, abgewiesene alte Writer, genau einen Writer je Rolle, zwei Cleanup-/Takeover-Ereignisse und eine Unterbrechung innerhalb des Recovery-Budgets. Zusätzlich werden alle sechs Fehlerklassen, Quorum, Consent, sichtbarer Stop und metadata-only Restore geprüft.

Das ist ein deterministischer Domain-/Chaos-Nachweis. Eine produktive Prozesssteuerung, ein verteilter Lease-Store, reale Gateway-/Host-Kills und gemessene HLS-Player-Unterbrechungen benötigen weiterhin den aktivierten Native-Packager-, Gateway- und Deploymentpfad. Solange diese Gates fehlen, bleibt Broadcast standardmäßig deaktiviert und der Todo-Track nur teilweise abgeschlossen.
