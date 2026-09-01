# Media-Agent Contracts

Diese JSON-Schemas sind die kanonische, geschlossene Grenze zwischen Browser,
Signaling-Control-Plane und nativen Media-Agents. JSON transportiert nur
Autorisierung, kurzlebige Routen, Layer-Wünsche, Acknowledgements und Statistiken.
RTP/SFrame-Medien werden niemals als JSON übertragen und die Agents erhalten
keine SFrame-Schlüssel.

- `subscription-intent.v1`: individueller, browserseitiger Layer-Wunsch.
- `subscription-ack.v1`: an die konkrete monotone Subscription-Revision
  gebundene, erst nach installiertem Receiver/SFrame-Decryptor bestätigte
  Zustellung; bis dahin bleibt der direkte Mesh-Fallback aktiv.
- `agent-lease.v3`: serverautorisierte Membership-, Subscription- und
  Federation-Topologie samt exakten Link-Demands.
- `media-agent-route-state.v3`: die geschlossene Browser-Sicht auf Ingress,
  Egress, DAG und beidseitige Readiness.
- `publication-layer-state.v2`: vom Ingress-Agent beobachtete opaque RTP-Layer.
- `agent-subscription-state.v2` und `browser-subscription-state.v2`: vom
  Egress angewendete Layerwahl und das nach installiertem SFrame-Receiver an
  den Publisher weitergereichte, revisionsgebundene Ergebnis.
- `federation-signal.v1` und `federation-state.v1`: ausschließlich von der
  Control Plane autorisiertes SDP/ICE-Brokering und beidseitiger Linkzustand.
- `federation-control.v1`: strikt begrenzte Agent-Agent-Acks und Statistiken;
  daraus entsteht keine Membership oder Policy-Autorität.

Alle unbekannten Felder werden durch `additionalProperties: false` abgelehnt.
Leases sind zusätzlich an Membership-/Route-Epochen und Ablaufzeiten gebunden.
