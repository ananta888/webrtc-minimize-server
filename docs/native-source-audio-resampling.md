# Native Quellzeit und PCM-Resampling

Stand: 2026-09-08, interner Anschluss in TBP-030. Die produktive Source-Factory
bleibt aus. Dieser Baustein verbindet bereits echte Browserquellen, native
Opus-Decodierung und Sample-Konvertierung im Test; der vollständige
Programm-/Encoder-/Writer-Lifecycle und die öffentliche Quellenannahme fehlen
noch. Anantas Runtime oder Repository wird dafür nicht verändert.

## Warum die feste Clock nicht genügte

Im vorherigen Chromium-Stresstest betrug die Abweichung eines Audio-Sender-
Reports vom nominalen 48-kHz-Modell 112,2 ms über 5,15 Sekunden. Die tatsächlich
decodierten Licht-/Tonimpulse lagen bis zu 164,2 ms auseinander. Das war oberhalb
der unveränderten 150-ms-Abnahmegrenze und wurde nicht als Erfolg behandelt.
Das vorherige feste Clock-Profil und seine Fehlerhistorie bleiben in
[native-trusted-source-ingress.md](native-trusted-source-ingress.md) dokumentiert.

RTP-Takte und die Referenzzeit aus Sender Reports sind unterschiedliche
Koordinaten. Die Zuordnung muss gemessen werden, statt eine perfekte nominelle
Taktrate zu unterstellen. Die Idee einer begrenzten linearen Schätzung findet
sich auch im [libwebrtc-Estimator](https://raw.githubusercontent.com/mozilla/gecko-dev/master/third_party/libwebrtc/system_wrappers/source/rtp_to_ntp_estimator.cc).
Hier werden eigene, zentrierte Koordinaten und die vorhandenen lokalen
Source-/Publisher-Handles verwendet; es wird kein Vendor-SDK zur Policyinstanz.

## Getrennte Fähigkeiten

`NewAdaptiveAudioSource` ist ein ausdrücklicher Modus für 48-kHz-Audio. Seine
alte `Map`-Methode liefert absichtlich keine Zeit: Unveränderte PCM-Bytes dürfen
nicht bloß neue Zeitstempel bekommen. `AudioTiming` liefert einen Snapshot aus
Programmposition und gemessenem Verhältnis von Programm- zu Eingangssamples.
Video und vorhandene feste Testpfade behalten ihr bisheriges Mapping.

Der Schätzer hält maximal zwölf Messpunkte. Zwei fortschreitende Reports
werden mindestens benötigt. Die Regression arbeitet mit zentrierten, bereits
erweiterten RTP-Samples und lokalen Programmsamples, nicht mit absoluten NTP-
Werten in Gleitkommazahlen. Das Verhältnis ist auf 0,95–1,05 begrenzt. Das ist
ein explizites technisches Korrekturprofil, keine Aussage über die Genauigkeit
oder Vertrauenswürdigkeit einer Geräteuhr.

Ein neuer Report darf höchstens 100 ms vom bereits etablierten Modell
abweichen; auch das resultierende Fenster darf keine größere Restabweichung
enthalten. Ein abgewiesener Messpunkt verändert weder Fit noch letzten
gültigen Report oder dessen Frische. Begrenzte Quarantäne, zwei konsistente
Reports zur Erholung, die zwölfsekündigen Fristen und terminaler Abbruch bei
wiederholter Inkonsistenz bleiben bestehen. SSRC, Codec-Rate, echte
PeerConnection, Publisher-Handle und Source-Lifecycle behalten ihre bisherigen
Grenzen. Ähnliche Zeitwerte verleihen keine Membership oder Geräteidentität.

## Tatsächliche Sample-Konvertierung

`sourceAudioResampler` nimmt ausschließlich PCM16LE/48 kHz/Stereo entgegen.
Ein 128-Tap-Blackman-Sinc-Filter mit interpolierter Koeffiziententabelle
berechnet neue Samples an den benötigten Zwischenpositionen. Die feste
Grenzfrequenz beträgt 0,45 Zyklen je Eingangssample; sie ist auf den begrenzten
Korrekturbereich ausgelegt. Dieses Profil ist kein allgemeiner Konverter
beliebiger Abtastraten und kein pitch-erhaltender Time-Stretcher.

Der Programm-Ausgabezähler ist fortlaufend. Clock-Updates schreiben keine
bereits ausgegebenen Samplepositionen neu. Ein Phasenfehler wird über ein
Sekundenintervall nachgeführt, mit höchstens fünf Prozentpunkten Ratenänderung
je Eingangssekunde und weiterhin maximal 100 ms zulässigem Phasenfehler.
Unbekannte Zeit führt zum Verwerfen und Löschen unentscheidbarer PCM-Historie,
nicht zu einer Arrival-Time-Ersatzclock. Der Wiedereinstieg darf nicht vor den
bereits ausgegebenen Cursor zurückspringen.

Positive RTP-Lücken bleiben Lücken. Nur der endliche Filterrest vor der Lücke
wird mit rechtem Null-Padding ausgegeben; für die fehlende Zeit wird kein
riesiger PCM-Puffer angelegt. Ein späterer Programmtakt gibt dort Stille aus.
Rückwärts-/überlappende Eingaben, übergroße Lücken, ungültige Formate, NaN,
unzulässige Raten, verlorene Policy und Ausgabeausfall schließen die Quelle.

Feste Nutzpuffer je Resampler: 24.064 Bytes Eingangshistorie und 3.840 Bytes
Ausgabe. Die gemeinsame, unveränderliche Koeffiziententabelle belegt 263.168
Bytes; sie enthält keine Peer-Daten. Eingaben sind auf 5.760 Stereosamples
begrenzt, ein Handoff auf 960 Samples, ein Renderlauf auf 6.400 Ausgabesamples.
Im kontinuierlichen Betrieb bleiben höchstens 129 Eingangssamples erhalten.
64 Samples Filter-Vorausschau entsprechen etwa 1,33 ms bei 48 kHz; dies ist
keine Gesamtlatenzgarantie für Browser, Netz, Decoder oder Broadcast.

Policy wird vor Annahme und erneut vor jedem Handoff geprüft. PCM ist am
Output nur geliehen und wird danach gelöscht. Idempotenter Close wischt
Historie/Ausgabe und schließt genau den besitzenden Output-Handle. Der Decoder
bleibt verantwortlich für Close auch bei untätigem Widerruf. Der Resampler
besitzt keine Capture-, Netzwerk-, Key-, Dateipfad- oder Logging-Schnittstelle.
Die Puffergrenzen ersetzen weder Prozess-RSS-Limits noch CPU-Gesamtzulassung.

`sourceProgramAudioOutput` ist ein separater kleiner Port mit expliziter
48-kHz-Programmzeit. `sourceAudioMixer.AddProgram` stellt einen entsprechend
typisierten, generationgebundenen Handle bereit. Der alte RTP-Eingang behält
seine Pflicht zur Zeitabbildung; es gibt keine vorgetäuschte Identitätsabbildung
und keine stille Änderung seines Vertrags. Beide Ports teilen die bestehenden
Source-/Bytebudgets, Pegel, Überlappungsgrenzen und Widerrufsregeln des Mixers.

## Nachweise und offene Grenzen

Unit-Tests prüfen Samplezahlen und 700-/1100-Hz-Wellenformen bei vier
Korrekturraten, die Unterdrückung eines 23-kHz-Testtons, feste Historienbudgets,
DTX-Lücken, unbekannte Zeit, Replay, NaN, Policy-/Writer-Verlust, konkurrierenden
Close und null zusätzliche Heapallokationen im stabilen Write-Pfad. Ein Test
verbindet den Resampler mit dem tatsächlichen Programmaudio-Port des Mixers und
prüft, dass ein Source-Widerruf den Parent nicht schließt. Ein separater Test
führt 60 simulierte Sekunden mit wechselnder, aus Reports geschätzter Drift
durch die echte Sample-Konvertierung; die maximale Phasenabweichung betrug
6,237 ms. Das ist ein deterministischer Simulationstest, kein physischer
60-Sekunden-Latenznachweis oder vollständiger Frequenzgangnachweis.

Die reale Browserfixture leitet SFrame-Audio durch Opus-Decoder und Resampler
in die vorhandene Programmtime-Probe. Video durchläuft weiterhin den echten
VP8-Decoder. Der erste Lauf bestand in beiden Browsern; danach bestanden sechs
Verbindungen je Browser mit maximal 46,8 ms in Chromium und 66,2 ms in Firefox.
Mindestens sechs eindeutige Impulspaare, mehr als 400 authentisierte Frames je
Quelle, die 150-ms-Grenze, explizite synthetische Zustimmung und Cleanup bleiben
Pflicht. Gesperrte Clocks bilden getrennte Messfenster; lückenlose Ausgabe wird
damit nicht behauptet. Race-/Vet und der gemeinsame Gesamtcheck werden im Todo
mit ihrem jeweiligen konkreten Stand geführt, nicht aus Einzeltests abgeleitet.

Noch erforderlich sind insbesondere die produktive Publisher-Clock-Zuordnung,
Lazy-Decoder mit kontrollierter Keyframe-Anforderung, Gesamtprozesszulassung,
gemeinsamer Programmtakt, gefenceter Encoder-/Writer-Anschluss und öffentliche
Approve-/Renewal-Workflows. Erst deren durchgängige Abnahme erlaubt eine
Freischaltung. Dieser interne Baustein erhält weder fremde Medienrechte noch
Schlüssel ohne den bestehenden expliziten Source-Consent.
