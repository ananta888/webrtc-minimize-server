# Broadcast-Failover und Disaster-Recovery

Stand: 2026-09-06. Diese Beschreibung gilt für den optionalen Trusted-Broadcast-Zweig. Das interaktive WebRTC-Meet und seine SFrame-Verbindungen bleiben davon unabhängig.

Die folgenden Übernahmeregeln beschreiben den implementierten und getesteten
Domain-Koordinator, nicht bereits eine durchgehend angeschlossene produktive
Same-Program-Übergabe. Der produktive Native-Pfad prüft derzeit Writer-Leases
und Readiness-ACKs; native OS-Ausgabesperren verhindern konkurrierende
kooperative Writer derselben Ressource. Die native Owner-Übergabe-API ist nun
mit echter Stop-ACK-Barriere und neuer Ausgabe-Ressource innerhalb derselben
Sendung verbunden; Details und lokale Nachweise stehen in
[Moderations-Workflows](broadcast-moderation-workflows.md). Die
Angular-/Player-Umschaltung, automatische Recovery und tatsächliche
Mehr-Packager-Medienausgabe bleiben in TBP-030 offen. Stop und Neuanlage einer
Sendung sind kein Nachweis für diese Fähigkeit.

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

Das ist ein deterministischer Domain-/Chaos-Nachweis.

## Chaos auf dem realen nativen Pfad (11. September)

`test/native-source-chaos.browser.test.js` ergänzt den Domain-Nachweis um echte
Prozesse: gebauter Native-Packager mit FFmpeg-Encoder, gebauter HLS-Origin,
Control Plane, Angular-Regie und ein hls.js-Zuschauer. Drei definierte Phasen,
ohne gelockerte Frist, Fence oder Wiederholung:

1. **Packager-Absturz (SIGKILL) während einer consentierten Ausgabe.** Die
   Control Plane setzt die Zuordnung beim Socket-Ende auf `failed`/
   `CONTROL_DISCONNECTED` (12 ms), stoppt das Programm (`ended`) und die Regie
   zeigt den Ausfall nach 821 ms. Der verwaiste Encoder endet von selbst über
   das Pipe-Ende (29 ms, per `/proc`-cwd des Stage-Verzeichnisses geprüft,
   ohne Prozessnamen oder Argumente zu behalten). Der Zuschauer bleibt nicht
   „spielend“: Lifecycle `ended`, Medienzeit steht. Kein Writer bleibt aktiv.
2. **Rückkehr derselben Packager-Identität.** Authentifizierung und
   Capability nach 220 ms; der Start beansprucht nur das eigene tote
   Ausgabeverzeichnis (`cleanOutputRoot`, hier bereits beim ersten Blick
   entfernt). Ein neues Programm mit neuer Programm-ID, Zuordnung und
   Ressource publiziert genau einmal; es existiert genau ein `res_`-Verzeichnis.
3. **Origin-Absturz (SIGKILL) bei laufendem zweiten Programm.** Der Writer
   behält seine gefencte Zuordnung (Origin-Verlust ist kein Writer-Verlust).
   Ein neuer Zuschauer meldet ohne Origin keine Wiedergabe (`recovering`);
   nach Neustart derselben Origin-Adresse spielt ein frischer Zuschauer nach
   307 ms. Danach bleibt genau eine laufende Zuordnung; Stop entfernt die
   Ausgabe, beide Prozesse laufen sauber weiter.

Der Test ist Linux-gebunden (Prozess-Containment, lokales FFmpeg) und misst
auf einem Host; die Zahlen sind Beobachtungen dieses Laufs, keine Budgets.
Nicht gezeigt: der MediaMTX-/WHIP-Gateway-Pfad, ein verteilter Lease-Store,
Host-/Netzpartition zwischen Rechnern, automatische Übernahme durch einen
Standby ohne Regieaktion sowie gemessene Unterbrechung an mehreren realen
Playern. Diese benötigen weiterhin den aktivierten Gateway- und Deploymentpfad.
Solange diese Gates fehlen, bleibt Broadcast standardmäßig deaktiviert und der Todo-Track nur teilweise abgeschlossen.
