# Versionierte MoQ-Verträge

Diese vier geschlossenen v1-Verträge bilden nur die experimentelle
Control-/Metadaten-Grenze ab. Medienobjekte selbst bleiben binär und laufen
nicht durch den Node-Signaling-Server.

Der Projekt-Pin lautet MOQT `draft-ietf-moq-transport-20`, LOC
`draft-ietf-moq-loc-04` und WebTransport `RFC 9297`. Secure Objects
`draft-ietf-moq-secure-objects-01` ist lediglich reserviert und standardmäßig
deaktiviert. Ein älterer, aber bekannter Draft kann als Capability deklariert
werden, wird von der Negotiation jedoch als inkompatibel behandelt. Unbekannte
Drafts und Extensions werden bereits vom Schema abgewiesen.

| Vertrag | Grenze |
| --- | --- |
| `moq-capability` | Browser-, Gateway- oder Providerfähigkeit mit Ablauf |
| `moq-catalog` | höchstens 32 Tracks und 64 KiB JSON |
| `moq-object` | Metadaten für Gruppe/Objekt; Binärdaten höchstens 1 MiB |
| `moq-subscription` | eine program-/audiencegebundene, begrenzte Auswahl |

Namespaces werden ausschließlich als
`<tenantId>/<programId>/epoch/<programEpoch>` akzeptiert. Dadurch verleihen
ein Trackname, ein Catalog oder ein Provider niemals Zugriff auf ein anderes
Programm. Auswahl und Fallback erfolgen vor dem Medientransfer und behalten
dieselbe Tenant-/Program-/Audience-Bindung bei.
