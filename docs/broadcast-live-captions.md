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

Ergänzung vom 10. September 2026: Der lokale `LiveCaptionService` meldet
Quellenstop und dessen nächste Epoch jetzt über einen getrennten Stop-Port
an den nativen Broadcast-Runtimeadapter. Bisher hörte dieser ausschließlich
Textemissionen; deshalb konnte eine beendete Erkennung ihre letzten
Broadcast-Untertitel stehen lassen. Der Stop wird vor der bisherigen finalen
Raumtext-Emission gemeldet: Der interaktive Raum behält sein bestehendes
Abschlussverhalten, der Broadcast verwirft dieses alte Ergebnis bereits.

Der Adapter widerruft die konkrete Captionquelle, leert die Burn-in-Einblendung
und stellt einen epochgebundenen TextTrack-Widerruf in den vorhandenen
DataChannel. Bei Backpressure ersetzt dieser eine noch wartende Textnachricht.
Bereits gesendete beziehungsweise beim Zuschauer gepufferte Daten sind dadurch
nicht rückwirkend gelöscht. Mikrofon und Bildschirmton bleiben getrennte
Quellen. Ergebnisse unterhalb oder gleich der Stop-Epoch werden nicht erneut
autorisiert; erst ein bewusster Neustart mit höherer Epoch erlaubt neue Texte.
Ein verspäteter älterer Stop darf umgekehrt die neue Quelle nicht widerrufen.

Auch ein noch startender Audio-Graph erhält die Stop-Grenze. Eine später
zurückkehrende Graphverbindung wird geschlossen, ohne einen Recognizer zu
aktivieren. Fehler optionaler Stop-Abnehmer verhindern den lokalen Cleanup
nicht. Broadcast-Stop entfernt alle drei Registrierungen für Einstellungen,
Text und Quellenstop; verspätete Callbacks einer geschlossenen Session sind
wirkungslos. Der lokale Port enthält nur Quellart und Epoch, keinen Text,
Token oder neuen Netzwerkcontract. Es entstehen keine Capture-, Modelllade-
oder zusätzlichen Freigabeaktionen.

Verifikation: Die Runtime-Fixture reproduzierte zunächst `update` statt
`revoke` beim Quellenstop. Nach Anschluss bestehen sämtliche 1.384
Frontendtests in 15,430 s, einschließlich Quellenstop/Restart,
Sendepuffer-Widerruf, verspäteter Graphverbindung, Listener-Fehlerisolation
und Playergenerationen. Diese Prüfung nutzt synthetische Graph-, Medien-
und DataChannel-Ports; sie beweist weder reale Spracherkennung noch die
Widerrufslatenz eines öffentlichen Streams. Physische Sprach-, Netzwerk-
und Produktionsgates bleiben erforderlich.

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

TBP-032 wird weiter als `in_progress` bearbeitet; die native
Caption-Auslieferung ist implementiert, aber noch keine plattformübergreifende
Qualitätsgarantie.
