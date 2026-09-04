# Consentierte Live-Untertitel im Broadcast

Stand: 2026-09-04. TBP-032 ist browserseitig umgesetzt, aber noch nicht an
einen realen Broadcast-Programmlauf und das MediaMTX-Gateway angeschlossen.
Die öffentliche Runtime bleibt deshalb deaktiviert.

## Vier getrennte Entscheidungen

Der Broadcast-Preflight zeigt vier unabhängige Schalter:

- nur lokale Einblendung,
- Teilen im interaktiven SFrame-Raum,
- Broadcast als ausblendbarer WebVTT-TextTrack,
- Einbrennen in das Broadcast-Programmbild.

Bei einer neuen Sitzung sind alle vier Ziele aus. Die lokale Vosk-Erkennung,
das Laden eines Modells und jede Textfreigabe bleiben sichtbare
Benutzeraktionen. Das Öffnen des Preflight startet weder Capture, Erkennung
noch Modell-Download. Auch das bisherige Teilen mit dem Raum ist für neue
Browserprofile jetzt default-aus und muss vor dem Start der Erkennung gewählt
werden.

## Vertrauens- und Datengrenze

`BrowserBroadcastCaptionPackager` läuft ausschließlich im ausdrücklich
autorisierten Browser beziehungsweise späteren Trusted-Packager. Der Node-
Server und Blind-Agenten besitzen keinen Eingang für Captiontext. Die
versionierten Control-Plane-Contracts enthalten weiterhin nur Sprache,
Format, Zustand und opaque Referenzen, niemals Text.

Partial-Ergebnisse existieren nur als flüchtige lokale/Burn-in-Anzeige. Erst
ein finalisiertes Ergebnis wird normalisiert, von Steuer- und Bidi-Zeichen
bereinigt, auf 500 Zeichen und drei Zeilen begrenzt und in ein WebVTT-
Livefenster aufgenommen. Ein Segment enthält höchstens 32 Cues und 64 KiB.
Es wird weder in Local Storage noch in einer Transkriptdatenbank abgelegt und
darf nicht in allgemeine Logs oder Metriken gelangen.

Private WebVTT-Ressourcen verwenden denselben `/broadcast/play/res_…`-Pfad
und damit dieselbe kurzlebige Secure-/HttpOnly-Playback-Session wie Manifest,
Parts und Segmente. Es gibt keine separate öffentliche Caption-URL. Diese
Servergrenze existiert bereits in der privaten Delivery-Policy; ihre reale
Gateway-/Browser-Verifikation bleibt mit TBP-022 offen.

## Synchronisation und Widerruf

Die Cue-Zeit wird aus Capture-Zeit, Programmbeginn und dem einstellbaren Delay
gebildet. Caption-Eingänge sind an Source-ID und Source-Epoch gebunden;
veraltete, doppelte oder außerhalb des standardmäßigen 3.000-ms-
Synchronitätsbudgets eintreffende Revisionen werden verworfen.

Source-Wechsel, Pause/Resume, Handoff, Player-Resync und Widerruf beginnen
eine neue Discontinuity-Generation. Dabei werden Partialtext, Cue-Fenster und
Revisionsledger geleert. Ein Late Join erhält nur das begrenzte 30-Sekunden-
Livefenster. Nach Source-Widerruf akzeptiert der Packager die alte Epoch nicht
mehr und weist den Player an, seinen bisherigen TextTrack zu entfernen.

## Einstellbare Darstellung

Der Preflight bietet den fest gepinnten 13-Modell-Vosk-Katalog und lädt ein
Modell erst per Button. Sprache, optionales Sprecherlabel, Delay von 0 bis
2.000 ms in der UI, Zeilenlänge 20 bis 80 Zeichen, vertikale Position und die
Stile hoher Kontrast, dezent oder groß sind einstellbar. Das zugrunde liegende
Policy-Objekt begrenzt Delay auf 5.000 ms und das Synchronitätsbudget auf 1.000
bis 8.000 ms. Der Viewer kann ausgelieferte Caption-/Subtitle-Tracks über ein
eigenes, mit `aria-pressed` ausgezeichnetes Bedienelement ein- und ausschalten.

## Offene Real-Gates

- Verdrahtung finaler Vosk-Ergebnisse mit dem laufenden Trusted-Compositor und
  WHIP-/LL-HLS-Packager,
- echte WebVTT-Publikation über MediaMTX sowie Cookie-geschütztes Playback in
  Safari, Chromium, Firefox und mobilen Browsern,
- reale Mikrofon- und Bildschirmtonläufe in mindestens zwei Sprachen mit WER,
  End-to-caption-Delay, A/V-Sync, CPU, RAM und Mobile-Degradation,
- Tastatur-, Kontrast-, Screenreader- und 60-Minuten-Handoff-/Resync-Test.

Bis diese Gates grün sind, ist TBP-032 `partial` und die UI behauptet keine
aktive öffentliche Caption-Auslieferung.
