# Runbook: Broadcast-Verfügbarkeit

Bei `BROADCAST_AVAILABILITY_SLO` oder `BROADCAST_ABORT_SLO` zuerst
Control-Plane-, Packager-, Gateway- und Origin-Zustand trennen. Der Broadcast
darf degradiert oder beendet werden, ohne Signaling, TURN oder SFrame-Raum zu
stoppen. Stale Writer vor Recovery immer fencen.
