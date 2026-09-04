# Angular-Broadcast-Cockpit

Stand: 2026-09-04. Das bestehende Broadcast-Menü ist als sicherer Preflight
sichtbar. Es wählt bis zu vier bereits lokal gestartete Originalquellen,
Publikum, Program-Audio, Layout, Qualitätsprofil, Untertitel, Delivery und
Packager und zeigt Upload-/CPU-Schätzung sowie die Trust-Grenze.

Der einzig auswählbare Pilot ist derzeit **dieser Browser als Own-Source-
Packager → Origin LL-HLS**. CDN, nativer Packager und MoQ sind sichtbar, aber
deaktiviert. Blind-Media-Agenten werden nicht als Trusted Packager angeboten.
Der Sendestart selbst bleibt sichtbar gesperrt, solange Program-Control-Plane,
Grant-Ausgabe und Runtime-Gateway nicht vollständig verdrahtet sind. Das ist
eine Sicherheitsgrenze und kein UI-Platzhalter, der umgangen werden darf.

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
Ein Kill-Switch ruft unabhängig voneinander Publication-Stop, Grant-Revoke und
lokales Source-Cleanup auf. Auch wenn ein Schritt fehlschlägt, werden die
anderen versucht; ein Teilfehler endet sichtbar in `failed` und kann nicht als
erfolgreicher Stop erscheinen.

## Noch offene Runtime-Grenze

Der Workflow besitzt bewusst nur einen kleinen Action-Port. Seine produktive
Implementierung muss die bestehende Broadcast-State-Machine, kurzlebige Grants,
WHIP/Native-Packager und Preview-Forks verbinden. Vorher bleibt der Startbutton
deaktiviert. Ebenfalls offen sind reale Refresh-/Reconnect-/Handoff-Gates,
serverseitige Kill-Switch-Verifikation und ein barrierefreier Tastatur-/Screen-
Reader-Test im ausgelieferten Cockpit.
