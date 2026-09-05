# Angular-Broadcast-Cockpit

Stand: 2026-09-04. Das bestehende Broadcast-Menü ist als sicherer Preflight
sichtbar. Es wählt bis zu vier bereits lokal gestartete Originalquellen,
Publikum, Program-Audio, Layout, Qualitätsprofil, Untertitel, Delivery und
Packager und zeigt Upload-/CPU-Schätzung sowie die Trust-Grenze.

Der einzig auswählbare Pilot ist derzeit **dieser Browser als Own-Source-
Packager → Origin LL-HLS**. CDN, nativer Packager und MoQ sind sichtbar, aber
deaktiviert. Blind-Media-Agenten werden nicht als Trusted Packager angeboten.
Der Sendestart ist inzwischen mit Program-Control-Plane, gerätegebundener
Einmal-Challenge, kurzlebigem Publisher-Grant und dem Browser-WHIP-Adapter
verdrahtet. Er bleibt dennoch solange technisch gesperrt, wie
`broadcast.whip.enabled` in der validierten öffentlichen Runtime `false` ist.
Das Produktionsprofil aktiviert ihn erst bei vollständiger OIDC-, Gateway-,
Resource-Base- und P-256-Signing-Konfiguration.

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

Der Browserpfad verbindet State-Machine, OIDC, nicht exportierbare
P-256-Geräteidentität, Preview-Forks, Composition und WHIP. Nicht abgeschlossen
sind der native Packager, operatorseitiger MediaMTX-Stream-Kill, echte
Visibility-Rekonfiguration am Gateway, Refresh-/Reconnect-/Handoff-Gates sowie
ein barrierefreier Tastatur-/Screen-Reader-Test im ausgelieferten Cockpit. Bis
diese externen Gates bestanden sind, bleibt der Schalter in der
Produktionsumgebung aus.
