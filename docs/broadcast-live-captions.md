# Consentierte Live-Untertitel im Broadcast

Stand: 2026-09-04. TBP-032 ist für den nativen Broadcast-Pfad durchgängig
verdrahtet. Die ausstehenden physischen Browser-, Sprach- und Langzeitgates
verhindern weiterhin eine uneingeschränkte Produktreife-Behauptung.

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
autorisierten Publisher-Browser. Finalisierte WebVTT-Fenster laufen über den
assignment-, Programmepoch- und Fencing-gebundenen, geordneten
`broadcast-captions-v1`-DataChannel direkt zum gewählten nativen Packager.
Der Node-Server und Blind-Agenten besitzen keinen Eingang für Captiontext. Die
versionierten Control-Plane-Contracts enthalten weiterhin nur Sprache,
Format, Zustand und opaque Referenzen, niemals Text.

Partial-Ergebnisse existieren nur als flüchtige lokale/Burn-in-Anzeige. Erst
ein finalisiertes Ergebnis wird normalisiert, von Steuer- und Bidi-Zeichen
bereinigt, auf 500 Zeichen und drei Zeilen begrenzt und in ein WebVTT-
Livefenster aufgenommen. Ein Segment enthält höchstens 32 Cues und 64 KiB.
Es wird weder in Local Storage noch in einer Transkriptdatenbank abgelegt und
darf nicht in allgemeine Logs oder Metriken gelangen.

Der Agent akzeptiert höchstens einen Caption-DataChannel, 70 KiB pro Nachricht,
64 KiB WebVTT und exakt geschlossene Update-/Revoke-Felder. Falsche Assignment-
oder Epochwerte, unbekannte Felder, Binärnachrichten, alte Sequenzen und
ungültige WebVTT-Payloads werden verworfen. Die aktuelle Live-Datei wird mit
Modus `0600` atomar ausschließlich im gefenceten `res_`-Output ersetzt und bei
Widerruf oder Programmende entfernt.

Private WebVTT-Ressourcen verwenden denselben `/broadcast/play/res_…`-Pfad
und damit dieselbe kurzlebige Secure-/HttpOnly-Playback-Session wie Manifest,
Parts und Segmente. Es gibt keine separate öffentliche Caption-URL. Diese
Servergrenze wird bei jeder Caption-Abfrage erneut geprüft. Der Player pollt
nur bei im Directory angebotenen Untertiteln alle zwei Sekunden genau
`captions_live.vtt` im bestehenden Same-Site-Cookie-Scope, akzeptiert höchstens
64 KiB `text/vtt`, hängt daraus einen lokalen Blob-TextTrack ein und widerruft
Blob, Fetch und Timer beim Stop. Query-Tokens und fremde Origins sind verboten.

## Synchronisation und Widerruf

Die Cue-Zeit wird aus Capture-Zeit, Programmbeginn und dem einstellbaren Delay
gebildet. Caption-Eingänge sind an Source-ID und Source-Epoch gebunden;
veraltete, doppelte oder außerhalb des standardmäßigen 3.000-ms-
Synchronitätsbudgets eintreffende Revisionen werden verworfen.

Ein Neustart derselben Vosk-Quelle erhöht ihre lokale Source-Epoch, widerruft
die vorherige Autorisierung und beginnt eine leere Generation. Pause/Resume,
Handoff, Player-Resync und Widerruf beginnen ebenfalls
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
bis 8.000 ms. Burn-in aktualisiert den isolierten Canvas-Compositor unmittelbar
und wendet den gewählten Stil sowie die Position an. Der Viewer kann
ausgelieferte Caption-/Subtitle-Tracks über ein
eigenes, mit `aria-pressed` ausgezeichnetes Bedienelement ein- und ausschalten.

## Offene Real-Gates

- Cookie-geschütztes Playback in
  Safari, Chromium, Firefox und mobilen Browsern,
- reale Mikrofon- und Bildschirmtonläufe in mindestens zwei Sprachen mit WER,
  End-to-caption-Delay, A/V-Sync, CPU, RAM und Mobile-Degradation,
- Tastatur-, Kontrast-, Screenreader- und 60-Minuten-Handoff-/Resync-Test.

Bis diese Gates grün sind, bleibt TBP-032 `partial`; die native
Caption-Auslieferung ist implementiert, aber noch keine plattformübergreifende
Qualitätsgarantie.
