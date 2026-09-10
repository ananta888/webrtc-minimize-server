# Pixelbudget für die gesamte native Ausgabe

`maximumPixelsPerSecond` begrenzt die Summe der Encoder-Renditions, nicht
jede Variante einzeln. Der native Source-Program-Pfad prüft diese Summe
bereits in `source_program_local.go` und `source_assignment_owner.go`.
Die Node-Zulassung verwendete dagegen bislang einen Einzelvergleich pro
Variante und konnte damit einen Auftrag erzeugen, den der Agent ablehnen muss.

Die Zulassung verbraucht das Budget jetzt einmal pro ausgewählter Variante,
in der bestehenden Reihenfolge low → medium → high. Passt die nächste Stufe
nicht mehr, endet die Auswahl; reicht das Budget nicht für low, wird abgelehnt.
Die anderen Grenzen für gewünschte Anzahl, CPU-/Uploadklasse, Consent,
Gesundheit, Audioformat und Software-Fallback bleiben unverändert.

Beim bestehenden Profil benötigen low und medium zusammen 15.897.600 Pixel/s;
die vollständige Dreier-Leiter benötigt 43.545.600 Pixel/s. Ein Budget von
27.648.000 Pixel/s erlaubt somit zwei Varianten, nicht alle drei. Diese Zahl
beweist weder CPU-Verfügbarkeit noch eine bestimmte Bildqualität. Lokale
Agent-Prüfungen, Speicher- und Encoderreservierungen bleiben zusätzlich nötig.

Die neue Regression scheiterte vor der Korrektur. Danach bestanden 44 gezielte
Policy-, Assignment-, Control-, Handoff- und Supervisorprüfungen (1,852 s).
Sie prüfen insbesondere exakte Summengrenzen, jeweils ein Pixel/s darunter,
Ablehnung unter low, volle drei Varianten bei ausreichendem Budget und
unveränderte Audio-/Scope-Felder. Die tatsächliche Assignment-Nachricht enthält
nur die zugelassene Leiter. Kein Produktionsbudget wurde angehoben.

Das ist eine Voraussetzung für den weiteren Ausbau auswählbarer
Video-Ausgabeprofile, nicht dessen Abschluss. Deren Native-/HTTP-/UI-Vertrag
und die gemeinsame Projektabnahme bleiben im aktiven TBP-020-Track offen.
