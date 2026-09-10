# Native-Packager-Control

`capability.v2.schema.json` ergänzt den geschlossenen Report um das verpflichtende
Boolean `sourcePrograms`. Nur ein explizites `true` im authentisierten v2-Report
meldet den lokal aktivierten Quellenprogramm-/Signalingpfad; eine Buildversion
genügt nicht. Das äußere Capability-Control-Envelope bleibt v1. Der bisherige
v1-Report und dessen Schema bleiben unverändert und akzeptieren keine v2-Felder.
Default-aus sendet weiterhin v1. Ein Fähigkeitswechsel entwertet bestehende
Quellenhandles; Room-Consent und Publisherfreigabe bleiben separat erforderlich.
Siehe [Aushandlung und Grenzen](../../docs/native-source-control.md).

`assignment-prepare.v4.schema.json` beschreibt separat den implementierten
Trusted-Source-Programmauftrag: expliziter Modus, Tenant-/Membership-/Gerätebindung,
kein Legacy-Einzelpublisher. Parser, Dispatcher, Writer-Lifecycle und lokale
Ressourcenprüfung sind angeschlossen; die ausdrückliche lokale Quellenprogramm-
Aktivierung sowie aktuelle Raum- und Quellenfreigaben bleiben erforderlich.
V5 ergänzt die unabhängige AAC-Auswahl. Capability V5 meldet dafür Audio-Control
V3 und Audio-Encoding V1; V6 ergänzt Scene-Control V2. Der aktuelle aktivierte
Agent meldet V6, bei deaktiviertem Quellenprogramm weiterhin V1.

`source-program-start.v3.schema.json` ergänzt den menschlich autorisierten
HTTP-Start um eine geschlossene Video-Strategie und ausdrücklich nullable
Audio-Auswahl. Die native V4/V5-Zuordnung überträgt weiterhin die konkreten
Encoderwerte, nicht neue unbekannte Auswahlfelder. Auswahl, kumulative
Ressourcenprüfung und Übergabegrenzen stehen unter
[Video-Ausgabestrategien](../../docs/native-source-video-output.md).
Ein implementierter Vertrag ist keine öffentliche Betreiberfreigabe.

`assignment-prepare.v3` transportiert zusätzlich ausdrücklich zugewiesene
ICE-Server einschließlich kurzlebiger TURN-Credentials. Diese sind Infrastruktur-
Zugänge, keine OIDC-Tokens oder Decrypt-Schlüssel. Ältere Vertragsbeschreibungen
ohne ICE beziehen sich auf v1/v2.

`release.v1.schema.json` ist ein davon getrennter, öffentlicher Release-Contract:
fünf feste Artefakte, Hash/Größe, Revision und technische Buildversionen. Er
enthält keine Geräte-, Konto-, Raum- oder Updateautorität. Seine unveränderten
Bytes sind Gegenstand einer separat zu prüfenden GitHub-Attestation; ein gültiges
JSON oder eine HTTPS-Antwort ist selbst noch kein Signatur-, Aktualitäts- oder
Freigabenachweis. Siehe [Update-Hilfe](../../docs/native-packager.md).

Diese Verträge gehören ausschließlich zur freiwilligen Trusted-Broadcast-Packager-Rolle. Sie sind weder mit dem blinden `media-agent`-Protokoll noch mit Room-Membership gleichzusetzen. Challenge, Authentisierung, Status, Signaling und das äußere Capability-Envelope bleiben v1; die Report-Versionen sind oben getrennt beschrieben. `assignment-prepare.v2` ergänzt ausschließlich die vom Server gewählte Videoencoder- und Software-Fallback-Bindung; Agenten vor 0.6.0 erhalten weiterhin den geschlossenen v1-Auftrag mit `libx264`.

Der Agent verbindet sich ausgehend über `/native-packager`, authentisiert eine nicht exportierte P-256-Geräteidentität und meldet eine geschlossene Capability. `consentedRoomIds` wird serverseitig stets mit den durch den Kontoinhaber gesetzten flüchtigen Raumfreigaben geschnitten. Ein Report erzeugt niemals selbst Autorität.

Die Verträge transportieren nur Control-Metadaten. Audio, Video, Bildschirm und Schlüssel dürfen nicht über diese WebSocket-Verbindung gesendet werden.

`assignment-prepare` und `assignment-stop` sind kurzlebig, epoch- und lease-gefencet. Der Agent bestätigt Zustandswechsel mit `assignment-status`. Hardware wird nur nach einem lokalen, begrenzten Test-Encode gemeldet und muss zusätzlich sichtbar angefordert werden. Scheitert sie trotzdem, erlaubt v2 genau den gebundenen `libx264`-Fallback. V1/V2 enthalten keine ICE-Server; V3 und die Quellenprogrammaufträge können sie ausdrücklich zuweisen. Die Aufträge enthalten keine SDP-, OIDC-Token-, Medien- oder Decrypt-Schlüssel-Nutzlast. Ein `ready` bestätigt lokale Vorbereitung, nicht die tatsächliche Zuschauerwiedergabe.
