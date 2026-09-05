# Angular-Broadcast-Cockpit

Stand: 2026-09-05. Das bestehende Broadcast-Menü ist als sicherer Preflight
sichtbar. Es wählt bis zu vier bereits lokal gestartete Originalquellen,
Publikum, Program-Audio, Layout, Qualitätsprofil, Untertitel, Delivery und
Packager und zeigt Upload-/CPU-Schätzung sowie die Trust-Grenze.

Der ausgelieferte Produktionspilot ist **ein ausdrücklich für den aktuellen
Raum consentierter, kontogebundener Native-Packager → privater Origin
LL-HLS**. Mehrere eigene Packager werden einzeln angezeigt und auswählbar;
Erreichbarkeit allein erteilt keinem Gerät Zugriff. Der Browser-WHIP-
MediaMTX-Pfad, CDN und MoQ bleiben capability-gesteuert deaktiviert.
Blind-Media-Agenten werden nicht als Trusted Packager angeboten.

Der Sendestart verbindet Program-Control-Plane, nicht exportierbare
P-256-Geräteidentität, kurzlebige aktions-/pfad-/epochgebundene Grants,
quellengenauen Trusted-Decrypt-Consent und den ausgewählten Adapter. Der
Native-Pfad ist in der öffentlichen Runtime aktiviert; der Browser-WHIP-Pfad
bleibt bei `broadcast.whip.enabled=false` gesperrt.

## Workflow-Grundlage

`BroadcastCockpitWorkflow` verlangt zwei getrennte lokale Aktionen: zuerst
eine Anfrage, dann innerhalb von zwei Minuten die Bestätigung. Die Bestätigung
nennt Publikum, Quellen, konkreten Packager und dass der Broadcast nicht die
Raum-SFrame-E2EE-Eigenschaft besitzt. Restore, Panelöffnung, Deep Link oder
Remotesignal rufen den Action-Port nicht auf.

Änderungen an Visibility, Delivery oder Packager während einer Sendung laufen
über denselben Bestätigungstyp und markieren die erwartete Unterbrechung. Die
Program-State-Anzeige kennt dauerhaft:

```text
idle → starting → running ↔ degraded/reconnecting/handing_over
                         → stopping → stopped
                         → failed
```

`stopped` bleibt mit Grund sichtbar, bis ein neuer expliziter Start beginnt.
Während jedes aktiven Zustands liegt eine sticky Statusleiste mit deutschem,
per `aria-live` angekündigtem Zustand und nativ fokussierbarem Stop-Button
außerhalb der zuklappbaren Startzusammenfassung. Der sichtbare Kill-Switch
bricht auch einen noch laufenden Start ab und versucht
unabhängig voneinander WHIP-Stop, serverseitigen Grant-Revoke und lokales
Source-Cleanup. Ein normaler Raum-Leave wartet darauf. Zusätzlich bindet die
Control Plane das Programm an den konkret attestierten Publisher-Browser und
stoppt es bei dessen Signaling-Abgang fail-closed; Gateway-Idle-Timeout und ein
späterer operatorseitiger Stream-Kill bleiben davon getrennte Schutzschichten.

## Noch offene Produktionsgrenze

Der Native-Pilot wurde in Produktion mit privatem Owner-Playback, bewusstem
Wechsel auf Public, anonymem Viewer ohne Room-Membership sowie sofortigem
Manifest-Widerruf nach Stop geprüft. MediaMTX ist kein Bestandteil dieses
öffentlich aktivierten Pfads und bleibt hinter seinem getrennten Feature-Flag.
Noch offen sind ein echter Refresh-/Reconnect-/Handoff-Lauf während aktiver
Ausgabe sowie ein physischer Tastatur-/Screenreader-Test. Der automatisierte
Produktionsgate prüft beim nächsten isolierten Lauf zusätzlich, dass der
Kill-Switch außerhalb einklappbarer Bereiche liegt, korrekt beschriftet und
tastaturfokussierbar ist.
