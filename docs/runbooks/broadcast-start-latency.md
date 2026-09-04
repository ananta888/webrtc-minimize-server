# Runbook: Broadcast-Startlatenz

Bei `BROADCAST_START_SLO` zuerst WHIP-Handshake, ICE-Erreichbarkeit,
Packager-CPU und Encoderwarteschlange anhand ausschließlich inhaltsfreier
Metriken prüfen. Keine Tokens, SDP/ICE oder Programmnamen erfassen. Neue Starts
bei Queue-Druck begrenzen; das bestehende Meet nicht neu starten.
