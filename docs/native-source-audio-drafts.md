# Gebundene Audioentwürfe in der Regie

TBP-014/030, 10. September 2026. Implementierte UI-Steuerung, noch keine neue
Produktions- oder Echoabnahme. Native Audio-v1/v2/v3, Mixing, Codec, Consent,
Quellenleases und die fünfsekündige Gültigkeit einer Beobachtung bleiben
unverändert. Lokale Tests starten keine Audio- oder Browserprozesse.

Die Audioregie bindet ihren lokalen Entwurf an die aktuelle menschliche
Bedienersitzung, Sendung, Revision/Epoche und Audio-Capability. Pegel, Mute und
Strategie bleiben auch nach Ablauf der Beobachtung lokal bearbeitbar. Anwenden
benötigt jedoch eine frische Beobachtung, passende Revision und Quellen sowie
eine eigene ausdrückliche Bestätigung. Ein lokaler Entwurf ist keine Freigabe.

Eine erneute Abfrage derselben Revision behält Änderungen, solange die
ursprünglichen Einstellungen unverändert sind. Laufende Peak-/Ducking-/Limiter-
Messwerte zählen nicht als geänderte Einstellungen. Eine andere Audiorevision,
andere Einstellungen oder hinzugekommene/entfernte Quellen erzeugen bei einem
abweichenden Entwurf einen sichtbaren Konflikt. Auch ein Revisionsrückschritt
darf nicht automatisch neu gebunden werden. Bereits genau angewendete Werte
und unveränderte lokale Entwürfe können die frische Beobachtung übernehmen.

„Audioentwurf gegen aktuellen Zustand prüfen“ bindet den Entwurf erst nach
Bestätigung an die neue Revision, ohne ihn anzuwenden. Neu hinzugekommene
Eingänge bleiben bei einem solchen Teilentwurf unverändert. Nicht mehr
verfügbare Eingänge müssen vor Apply ausdrücklich aus dem Entwurf entfernt
werden. „Audioentwurf verwerfen“ lädt die bestätigten Einstellungen nach eigener
Bestätigung. Program-/Writer-/Capability-/Ownerwechsel übernehmen dagegen nur
den neu beobachteten Zustand, niemals alte Pegelabsichten in einen anderen
Scope. Ohne aktuelle Ownerbindung wird das Formular ausgeblendet.

Refresh und Apply rendern ihre Pending-Sperre synchron vor Rückkehr des lokalen
Klickhandlers. Auch die Zeit zwischen Controller-Antwort und Formularübernahme
bleibt gesperrt. Während einer Bestätigungsfrage erneut geänderte Werte, Owner
oder Beobachtungen verhindern Apply beziehungsweise Review. Ungültige, leere
oder außerhalb 0–100 liegende Pegel-Eingaben werden auf den tatsächlich
vorgemerkten Wert zurückgesetzt; sichtbare und gesendete Werte sollen nicht
auseinanderlaufen. Dies startet weder Monitoring noch Capture.

## Verifikation und Ladegrenzen

70 gezielte Frontendfälle bestanden in 1,090 Sekunden: bestehende
Audio-v1/v2/v3-/HTTP-/Controllerfälle, zwölf Audioentwurfsfälle, zwei tatsächlich
gerenderte Audio-/Szenenvorlagen sowie Label-/HTTP-Regressionen. Das gerenderte
Audioformular prüft Pending-Sperren bei Refresh und Apply, ungültige Zahlen,
Erhalt eines Entwurfs, Konfliktprüfung und Ownerverlust. TypeScript,
Angular-no-emit und Todo-Gate sind grün. Bestehende reale Native-Audio-
Browserpfade werden gebündelt in CI ausgeführt; deren neue Abnahme steht aus.

CI `34507390777` auf `a6e5ddd` scheiterte bereits am Produktionsbuild: Das
Startpaket lag 155 Bytes über dem unveränderten 1,6-MB-Maximum. Somit ist dieser
Lauf kein neuer Medienfehler und kein bestandener Browsernachweis. Das separate
Nachladen von Audio- und Szenenregie bei aktiver Sendung entlastet zwar die
Konfigurationsansicht, veränderte das Startpaket jedoch nicht: Ihr Elternpanel
war bereits nachgeladen. Die zusätzlichen geschlossenen Szene-/Label-HTTP-
Adapter wurden anschließend wie der vorhandene Audioadapter ausgelagert und
werden erst bei ihrer Operation geladen; Identitätszugriff und Fetch erfolgen
erst nach erneuter Abortprüfung. Auth-/Body-/Response-Grenzen bleiben erhalten.

Der echte Produktionsbuild mit Stats-JSON besteht danach in 9,377 Sekunden in
einem eigenen temporären Output. Die statische Einstiegskette aus Main,
Polyfills und Styles umfasst laut Stats-JSON 13 Dateien und 1.598.877 Bytes,
also nur 1.123 Bytes Abstand zum Fehlerbudget. Die Regiekomponenten und HTTP-Adapter sind
als eigene nachgeladene Einstiegspunkte nachgewiesen. Das 1,5-MB-Warnbudget
bleibt überschritten; weiterer Spielraum ist klein und keine abgeschlossene
Performanceabnahme. Das ausgelieferte Root-`dist` wurde weder gebaut noch
verändert. Bei fehlgeschlagenem Nachladen gibt es sichtbare Fehlertexte; der
bereits vorhandene Stop-Pfad bleibt außerhalb der Regie-Chunks erreichbar.
