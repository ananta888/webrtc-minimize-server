# Native Ressourcenbudgets pro Tenant und Betreiberkonto

Die tatsächliche Native-Assignment-Registry prüft nun drei gleichzeitige
Planungsgrenzen: Deployment, Tenant und Principal innerhalb dieses Tenants.
Jede Grenze enthält CPU-Einheiten, MiB Speicher, Encoderplätze, GPU-Plätze
und Zielbitrate des Packager-Ausgangs. Alle drei müssen erfüllt sein.

Für jeden vorhandenen globalen Schlüssel sind zwei additive Einstellungen
verfügbar:

| Globaler Schlüssel | Scope-Suffixe |
| --- | --- |
| `BROADCAST_NATIVE_CPU_UNITS` | `_PER_TENANT`, `_PER_PRINCIPAL` |
| `BROADCAST_NATIVE_MEMORY_MIB` | `_PER_TENANT`, `_PER_PRINCIPAL` |
| `BROADCAST_NATIVE_ENCODER_SLOTS` | `_PER_TENANT`, `_PER_PRINCIPAL` |
| `BROADCAST_NATIVE_GPU_SLOTS` | `_PER_TENANT`, `_PER_PRINCIPAL` |
| `BROADCAST_NATIVE_EGRESS_BITS_PER_SECOND` | `_PER_TENANT`, `_PER_PRINCIPAL` |

Beispiel: `BROADCAST_NATIVE_ENCODER_SLOTS_PER_TENANT=12` und
`BROADCAST_NATIVE_ENCODER_SLOTS_PER_PRINCIPAL=3`. Ohne expliziten Scope-Wert
wird der jeweilige aktuell konfigurierte globale Wert übernommen, nicht ein
zweiter, möglicherweise kleinerer Standard. Compose bildet dieselbe Vererbung
ab. Null verweigert positiven Bedarf; leere/ungültige Werte brechen den Start
ab. Die UI meldet weiterhin nur die allgemeine temporäre Nichtverfügbarkeit,
keine fremden Belegungszahlen oder Konten.

Tenant-Zuordnung stammt aus der kontrollierten Packager-Capability, der Owner
aus dem authentisierten Aufrufer und der Ownership-Prüfung des Control-Ports.
Der Client kann keine Budget-Scope zum Umgehen der Grenzen auswählen. Die
Ressourcenberechnung bleibt identisch: tatsächlich gewählte Renditions,
vollständiger Software-Fallback und begrenzter Overhead auf der Zielbitrate.

Admit ist nur eine Vorprüfung. Beide Prepare-Grenzen prüfen erneut dieselbe
aktuelle Registry, auch nach reentrantem ICE-/Credential-Aufruf. Es gibt kein
zusätzliches Belegungsregister. Aktive, vorbereitende und stoppende Assignments
sowie fehlgeschlagene Assignments mit noch gültiger Lease zählen weiter.
Erst bestätigter Stop beziehungsweise das Ende der fehlgeschlagenen Lease
gibt diese Ressourcen frei.

Eine berechtigte serielle Übergabevorprüfung darf ausschließlich den exakt
geprüften Vorgänger aus allen drei Summen herausrechnen. Die tatsächliche
Nachfolger-Zuweisung darf ihn nicht überspringen und bleibt an Stop-ACK,
aktuelle Freigaben und verfügbare Ressourcen gebunden. Neue Program-/Resource-
IDs oder ein anderer Packager umgehen die Owner-/Tenant-Summe nicht.

Globale Metriken bleiben unverändert, aggregiert und frei von Principal-/Tenant-
Labels. Diese Budgets sind keine Betriebssystem-Isolation, keine gemessenen
CPU-/RAM-Werte und weder Viewer-Download noch Providerkosten. Separate
Hostkapazität, Kostenbudget, UI-Vorschau und CDN-/Fallback-Lastnachweise bleiben
offen. Room-Kapazität und Human-Medienpfade werden nicht verändert.

## Gezielte Prüfungen

Reine Node-Tests prüfen alle fünf Ressourcen auf allen drei Ebenen, echte
Compose-Auswertung der Defaults/Nullwerte, ungültige Eingaben, unveränderliche
Konfiguration, tatsächliche Assignment-Zuweisung, getrennte Konten/Tenants,
Belegung nach Disconnect und reentrante Commit-Rennen. Die Handoff-Fixture
prüft Legacy- und Trusted-Source-Übergabe mit jeweils begrenztem Deployment-,
Tenant- und Principalbudget. Es werden keine Browser, Encoder oder produktiven
Dienste dafür gestartet. Die ersten neuen Fixture-Fehler betrafen fehlende
synthetische ICE-Konfiguration sowie ein zusätzlich greifendes GPU-Budget;
die Fixtures wurden korrigiert, nicht die Produktionsgrenzen aufgeweicht.
Gemeinsame Integrations-/Lastabnahme bleibt für den gebündelten Stand offen.
