# Broadcast-Zuschaueransicht und adaptive Qualität

Stand: 2026-09-04. TBP-031 besitzt eine getestete Angular-Ansicht, einen
geschlossenen Directory-/Playback-Client und eine lokale Qualitätsregel. Die
öffentliche Runtime-Composition-Root und reale Playback-Programme fehlen noch;
deshalb bleibt die Ansicht sichtbar, aber `[enabled]="false"`.

## Getrennte Verzeichnisse

Der Client lädt anonym ausschließlich `/api/broadcasts/public`. Dieser Pfad
darf nur aktive `public`-Einträge liefern. Erst nach OIDC-Anmeldung wird
`/api/broadcasts/mine` mit zwei getrennten Mengen geladen:

- ausdrücklich für das Subject freigegebene private/unlisted Programme,
- eigene Programme einschließlich beendeter oder derzeit nicht erreichbarer
  Zustände.

Private IDs werden nicht über den öffentlichen Pfad probiert. Bei einem
Playback-Aufruf werden 403 und 404 beide zu `broadcast_not_available`; dadurch
liefert die Oberfläche keine einfache private Enumeration. Zuschauer erhalten
keine Room-Membership, Peer-ID oder SFrame-Schlüssel und tauchen nicht in der
Teilnehmerliste auf.

## Playback und Deep Links

Ein Deep Link enthält nur `section=broadcast` und eine validierte opaque
`prg_…`-Programm-ID. Grants, Tokens, Resource-Refs und Manifestpfade bleiben aus
URL und History. Erst ein sichtbarer Klick ruft den Playback-Autorisierungsport
auf, tauscht dessen kurzlebigen Grant serverseitig gegen die bestehende
Secure-/HttpOnly-Cookie-Session und übergibt dem Player nur den relativen
Manifestpfad. 403/404, 410 und 503 werden als nicht verfügbar, beendet oder
offline abgebildet. Refresh startet weder Wiedergabe noch Capture automatisch.

## Qualitätswahl

Der Player bietet `Auto`, `Datensparen`, `Niedrig`, `Mittel`, `Hoch` sowie eine
exakte hls.js-Rendition. Eine exakte manuelle Rendition wird nicht vom
Auto-Regler überschrieben. `Datensparen` und `Niedrig` begrenzen auf 360p,
`Mittel` auf 540p.

Auto bewertet alle zwei Sekunden:

- hls.js-Bandbreitenschätzung, ersatzweise die Network-Information-Schätzung,
- vorgepufferten Zeitraum,
- decodierte und verworfene Frames,
- den browserseitigen Save-Data-Hinweis.

Zwei aufeinanderfolgende schlechte Samples erlauben eine stufenweise Senkung.
Eine Erhöhung benötigt drei gute Samples, mindestens sechs Sekunden Buffer,
ausreichende Bandbreitenreserve und zehn Sekunden Mindesthaltezeit. Im
Datenspar-/Low-Power-Kontext steigt Auto nicht über 540p. Das verhindert
häufiges Hin-und-Her-Schalten, ist aber keine QoS-Garantie.

## Offene Gates

- Control-Plane-Endpunkte und Projection-Store für Public/Mine/Playback,
- Ausgabe realer kurzlebiger Playback-Grants und vollständige Playerverdrahtung,
- policygesteuerte Besitzeranzeige und echte aggregierte Viewerzählung,
- Program-Ende/Revoke/Providerwechsel während aktiver Wiedergabe,
- Browser-/Mobiltests für ABR, Decoderlast, Save-Data, Untertitel, Fokus und
  Screenreader.
