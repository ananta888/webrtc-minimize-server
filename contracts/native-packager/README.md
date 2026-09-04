# Native-Packager-Control

Diese v1-Verträge gehören ausschließlich zur freiwilligen Trusted-Broadcast-Packager-Rolle. Sie sind weder mit dem blinden `media-agent`-Protokoll noch mit Room-Membership gleichzusetzen.

Der Agent verbindet sich ausgehend über `/native-packager`, authentisiert eine nicht exportierte P-256-Geräteidentität und meldet eine geschlossene Capability. `consentedRoomIds` wird serverseitig stets mit den durch den Kontoinhaber gesetzten flüchtigen Raumfreigaben geschnitten. Ein Report erzeugt niemals selbst Autorität.

Die Verträge transportieren nur Control-Metadaten. Audio, Video, Bildschirm und Schlüssel dürfen nicht über diese WebSocket-Verbindung gesendet werden.
