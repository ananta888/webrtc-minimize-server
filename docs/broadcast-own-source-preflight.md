# Own-Source-Broadcast-Preflight

Stand: 2026-09-04, Implementierungsstufe `TBP-010`.

Die Angular-Anwendung besitzt jetzt einen sichtbaren Bereich `Broadcast` für
die lokale Vorbereitung eigener Quellen. Der Bereich sendet noch keine Medien
an einen Gateway und startet keinen öffentlichen Stream. Der getrennte
[RFC-9725-WHIP-Transport](browser-whip-publisher.md) ist inzwischen vorhanden,
aber noch nicht an diesen UI-Start und eine öffentliche Grant-HTTP-Grenze
angeschlossen.

## Bewusster Ablauf

1. Der Nutzer tritt einem Raum bei und startet Mikrofon, Kamera oder Bildschirm
   über die bestehenden sichtbaren Live-Buttons. Bildschirmton bleibt das
   vorhandene getrennte Opt-in der Bildschirmfreigabe.
2. Erst danach listet der Broadcast-Bereich diese **eigenen aktiven
   Originaltracks** auf. Remote-Tracks des Mesh sind für diesen Port nicht
   erreichbar.
3. Checkboxen wählen Quellen nur lokal aus. Sie rufen weder `getUserMedia` noch
   `getDisplayMedia` auf und erstellen noch keinen Track-Klon.
4. Erst der sichtbare Klick `Vorschau bewusst vorbereiten` erzeugt für jede
   gewählte Quelle einen getrennten `MediaStreamTrack.clone()`.
5. `Vorschau stoppen`, ein Quellenende, Sessionwechsel, Leave, Logout,
   `pagehide`, Komponenten-Destroy oder App-Destroy beendet die Klone und
   Audio-Meter. Der Originaltrack und damit die Raumfreigabe laufen weiter,
   sofern der Nutzer nicht deren eigenen Live-Button stoppt.

Deep Links, restaurierter Storage, Panel-Öffnung, Visibility-Wechsel und
Remotesignale besitzen keinen Startpfad. Der User-Intent wird zusätzlich als
`user-action` geprüft. Spätere serverseitige Broadcast-Grants bleiben trotzdem
die Autoritätsgrenze; ein UI-String ist kein Security-Token.

## Besitz und SFrame-Grenze

`MediaPublicationService` bleibt Eigentümer der lokalen Capture-Tracks. Es
führt eine rein lokale, flüchtige Zuordnung zufälliger Source-IDs zu genau
diesen Originaltracks sowie eine monotone Publication-Revision. Beim
Hinzufügen, Entfernen oder separaten Stoppen von Bildschirmton wird die
Revision aktualisiert. Ein Fork muss Source-ID und aktuelle Revision treffen.

Der Fork erfolgt am Originaltrack, bevor dieser über `RTCRtpSender` in den
SFrame-Raumpfad gelangt. SFrame selbst wird nicht abgeschaltet und kein
Raumsender wird ersetzt. Der Broadcast-Klon ist aber bewusst Klartext am
lokalen Capture-/Composition-Endpunkt; ein späterer Trusted-Packager und sein
Gateway können freigegebene Programminhalte verarbeiten. Deshalb zeigt die UI
vor jeder späteren Publikation ausdrücklich `nicht SFrame-E2EE`.

## Preflight-Inhalt

Die Ansicht zeigt vor einem späteren Start:

- jede konkret ausgewählte eigene Quelle und eine lokale Video- oder
  Audiopegel-Vorschau,
- das getrennte Zielpublikum `private`, `unlisted` oder `public`,
- ob finalisierte lokale Vosk-Captions eingeplant werden sollen,
- den ehrlichen Codecstatus: Preview-Codec vorhanden, WHIP-/Ausgabe-Codec noch
  nicht ausgehandelt,
- eine begrenzte Upload-Schätzung aus tatsächlich angewendeter Auflösung, FPS
  und Quelltyp,
- die Trust-Grenze zwischen interaktivem SFrame-Raum und entschlüsseltem
  Broadcast-Abzweig.

Die Schätzung ist eine Planungsgröße, keine QoS-Zusage. Reale Senderstats,
Codecwahl und Adaption folgen mit WHIP und Sendersteuerung in `TBP-011` und
`TBP-012`.

## Ressourcen

Audiopegel verwenden pro Audio-Preview einen getrennten `AudioContext`,
`MediaStreamAudioSourceNode`, `AnalyserNode` und einen begrenzten
Animation-Frame-Loop. Cleanup trennt die Nodes, beendet den Loop und schließt
den Kontext idempotent. Diese Implementierungsstufe erzeugt bewusst noch
keinen Worker. Spätere Composition-/Encoder-Worker müssen denselben
Session-/Destroy-Cleanup erfüllen und dürfen nicht aus restauriertem UI-State
starten.

## Verifikation

Unit- und UI-Contracttests decken Source-Besitz, falsche Revision, Remote-Source,
Abort, getrennten Clone-Stop, Bildschirmton, AudioNode-Cleanup, Sessionreset,
fehlenden Storage-Autostart und sämtliche Preflight-Hinweise ab. Reale
Playwright-Gates in Chromium und Firefox prüfen zusätzlich:

- Deep-Link-/Panel-Öffnung ohne Capture,
- Source-Auswahl und Preview ohne zusätzliche Browserberechtigung,
- einen vom Raumtrack verschiedenen Video-Klon,
- Stop des Preview-Klons bei weiter laufendem Original- und SFrame-Raumpfad.

Die Komponentenregeln werden als externes, im Produktions-Build referenziertes
Stylesheet ausgeliefert. Sie sind auf `app-broadcast-preflight` begrenzt und
benötigen weder Inline-Styles noch eine Lockerung der produktiven CSP. Ein
lokaler Produktionsserver-Gate prüft in Chromium und Firefox den externen
Stylesheet-Link, das zweispaltige Grid, Panel-Padding und eine leere
Browser-Fehlerkonsole.
