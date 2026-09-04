# Runbook: Broadcast-Kapazität

Bei `BROADCAST_RESOURCE_PRESSURE` oder `BROADCAST_QUOTA_PRESSURE` keine neue
Admission ohne freie Lease zulassen. Zuerst hohe Renditions reduzieren, dann
degradieren und zuletzt kontrolliert stoppen. Room-Limits und TURN-Ausgabe
bleiben getrennt; keine globale Raumgrenze einführen.
