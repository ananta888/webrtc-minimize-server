# Runbook: Broadcast-Failover

Bei `BROADCAST_FAILOVER_SLOW` Lease-TTL, letzten Heartbeat, Fence und
Gatewaystatus prüfen. Ein Nachfolger darf erst nach höherer Fence-Revision
publizieren. Ohne sichere Übernahme kontrolliert stoppen; niemals zwei Writer
parallel freigeben.
