# Native-Packager-Control

Diese Verträge gehören ausschließlich zur freiwilligen Trusted-Broadcast-Packager-Rolle. Sie sind weder mit dem blinden `media-agent`-Protokoll noch mit Room-Membership gleichzusetzen. Challenge, Authentisierung, Capability, Status und Signaling bleiben v1. `assignment-prepare.v2` ergänzt ausschließlich die vom Server gewählte Videoencoder- und Software-Fallback-Bindung; Agenten vor 0.6.0 erhalten weiterhin den geschlossenen v1-Auftrag mit `libx264`.

Der Agent verbindet sich ausgehend über `/native-packager`, authentisiert eine nicht exportierte P-256-Geräteidentität und meldet eine geschlossene Capability. `consentedRoomIds` wird serverseitig stets mit den durch den Kontoinhaber gesetzten flüchtigen Raumfreigaben geschnitten. Ein Report erzeugt niemals selbst Autorität.

Die Verträge transportieren nur Control-Metadaten. Audio, Video, Bildschirm und Schlüssel dürfen nicht über diese WebSocket-Verbindung gesendet werden.

`assignment-prepare` und `assignment-stop` sind kurzlebig, epoch- und lease-gefencet. Der Agent bestätigt Zustandswechsel mit `assignment-status`. Hardware wird nur nach einem lokalen, begrenzten Test-Encode gemeldet und muss zusätzlich sichtbar angefordert werden. Scheitert sie trotzdem, erlaubt v2 genau den gebundenen `libx264`-Fallback. Diese Steuerverträge enthalten weder SDP/ICE noch OIDC-Tokens, Medienbytes oder Decrypt-Schlüssel; ein `ready` bestätigt daher nur die lokale Capability- und Ressourcenprüfung, noch keinen laufenden Medienpfad.
