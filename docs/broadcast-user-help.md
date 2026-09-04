# Nutzerhilfe: Raum und Broadcast

Der normale Raum bleibt ein interaktives WebRTC-Meet für höchstens 20 Teilnehmer. Kamera, Mikrofon, Bildschirm und optionaler Bildschirmton werden erst nach deinem sichtbaren Klick gestartet und können getrennt beendet werden. Raum-E2EE schützt unterstützte direkte beziehungsweise blinde Relay-Pfade; ein Trusted Broadcast ist ein anderer Ausgabepfad und darf nicht mit Raum-E2EE verwechselt werden.

## Own Source und Trusted Program

- **Own Source** sendet nur bereits von dir aktivierte Kamera-, Mikrofon- oder Bildschirmtracks. Vor dem Start siehst du Quelle, Publikum, Uploadschätzung, Codec und die Trust-Grenze. Das Öffnen des Broadcast-Panels startet keine Aufnahme.
- **Trusted Program** setzt mehrere ausdrücklich freigegebene Quellen zu einer Sendung zusammen. Der gewählte Packager kann diese Quellen im Klartext verarbeiten. Er braucht daher gesonderten Consent und kann beim eigenen Gerät CPU, Akku und Upload beanspruchen.
- Ein normaler Zuschauer wird dadurch nicht zum Raumteilnehmer und erhält weder Mikrofon-, Kamera- noch Moderationsrechte.

`private` erlaubt nur ausdrücklich autorisierte Zuschauer, `unlisted` ist nur über den kontrollierten Link auffindbar, und `public` darf im öffentlichen Verzeichnis erscheinen. Eine Sichtbarkeitsänderung widerruft alte Viewer-Grants und erzeugt eine neue Broadcast-Epoche. Der Raum selbst bleibt davon getrennt.

Untertitel stammen nur aus einer lokal gestarteten Quelle. Du entscheidest getrennt, ob sie nur bei dir sichtbar, im Raum geteilt oder in das Trusted Program übernommen werden. Ohne einen eigenen späteren Retention-Track werden weder Aufnahme noch Transcript gespeichert.

LL-HLS spart gegenüber einem großen Peer-Mesh Upload am Sender, fügt aber typischerweise mehrere Sekunden Verzögerung hinzu und verbraucht bei jedem Zuschauer ungefähr die gewählte Rendition plus Protokolloverhead. Automatische Qualität kann bei schwacher Verbindung herunterschalten; der Zuschauer kann zusätzlich eine sparsame Stufe wählen. Bildschirmtext benötigt oft eine höhere Auflösung als Kameravideo.

Mit **Broadcast stoppen** werden Publication, kurzlebige Grants, Writer-Leases, lokale Klone, AudioNodes und Gateway-Muxer beendet. Bei einem Fehler zeigt die Oberfläche entweder Wiederaufnahme mit Player-Neustart oder einen sichtbaren Stop; sie darf nicht unbemerkt auf einen weniger sicheren Pfad wechseln.

Aktueller Produktionsstand: Das interaktive Meet ist aktiv, der Broadcast-Zweig ist serverseitig deaktiviert. Chromium und Firefox sind lokal geprüft; Safari, iOS/Android, WAN/CDN und die mehrstündige Belastung fehlen noch. Daher gibt es noch keine öffentliche Broadcast-Freigabe und keine zugesagte maximale Zuschauerzahl.
