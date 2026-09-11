# Bestätigter nativer Programmverlauf

Der Mehrquellen-Editor unter **Broadcast** bietet nach einem eigenen Programmstart
„Bestätigten Programmverlauf anzeigen“. Öffnen lädt nur den UI-Code; erst
„Verlauf aktuell laden“ fragt Metadaten ab. Das letzte eigene Programm bleibt
auch nach Stop in derselben Raumsitzung abfragbar. Ein neuer Programmstart,
Raum-/Membership-Generationswechsel, Identitätsverlust oder Service-Ende entfernt
diese lokale Referenz. Es gibt keine dauerhafte Browserablage.

## Was die Anzeige belegt

Die Runtime erzeugt Einträge unmittelbar nach ihren tatsächlich übernommenen
Zustandsänderungen: Registrierung, Programmzustand, Standby-Vormerkung,
Handoff-Beginn, Nachfolger-Writer-Zuordnung und Ende einer gestoppten Übergabe.
Heartbeats und idempotente Wiederholungen erzeugen keine zusätzlichen Einträge.
Eine Writer-Zuordnung ist **keine** Ausgabebestätigung. Erst der bestehende
Output-Ready-Pfad setzt den Zustand auf `live`; auch das beweist keinen Empfang
bei einem Zuschauer. Standbys erhalten durch Beobachtung oder Vormerkung keine
Medienschlüssel. Das Journal autorisiert keine Aktion und startet keinen Failover.

Die Anzeige ist ausdrücklich **kein vollständiges Audit**: Quellenfreigaben,
Quellenwiderrufe, Audio- und Szenensteuerung sind darin noch nicht enthalten.
Ihre bestehenden Autorisierungs- und Widerrufspfade bleiben unverändert.

## Zugriff und Aufbewahrung

`POST /api/broadcasts/:programId/native-program-history` akzeptiert ausschließlich
den geschlossenen v1-Vertrag aus `contracts/native-packager/`. Er benötigt
verifiziertes menschliches OIDC, aktuelle Creator-Membership und die exakte
ursprüngliche Publisher-Peer-/Geräte-/Tenant-/Owner-Bindung. Ein Raumcode,
Agentenstatus oder gleicher Kontoname allein genügt nicht. Auch nach Stop wird
diese Bindung erneut geprüft. Maschinen und andere Publisher erhalten keinen Zugriff.

Origin, Content-Type, Methode, query-freie URL und höchstens 512 Request-Bytes
werden geprüft. Der Abruf ist auf zwölf Versuche je aktueller Membership pro
Minute begrenzt. Antworten sind `no-store`, höchstens fünf Sekunden gültig und
zusätzlich durch das Tokenablaufdatum begrenzt. Dies ist eine reine aktuelle
Leseprojektion, kein CAS-Schreibbefehl: Nach Stop/Handoff darf die Antwort eine
neuere Revision/Epoche als der zuletzt im Browser bekannte Stand enthalten.
Keine Reservierungen, Credentials, Medien oder neuen Rechte werden ausgegeben.

Es gibt höchstens 256 Einträge insgesamt im Prozess, höchstens 32 pro Antwort
und höchstens 15 Minuten Aufbewahrung. Andere Programme können ältere eigene
Einträge verdrängen; es werden weder fremde Zähler noch globale Sequenznummern
ausgegeben. Einträge enthalten nur Ereignistyp, Zustand, Revision, Epoche,
Zeitpunkt und Standby-Anzahl. Keine Namen, Medien, Untertiteltexte, Tokens,
Quellen- oder Agenten-IDs. Neustart/Close löscht alles; ein Uhrenrücksprung leert
das Journal und lässt es bis zum bisherigen Zeitstand nicht verfügbar sein.

Der Browser prüft den geschlossenen, maximal 16-KiB großen Antwortvertrag und
löscht veraltete Anzeigen. Die Frist läuft monoton ab **Anfragestart**, nicht ab
Antwortempfang. Identitäts-/Programmwechsel, ungültige Uhr, Abbruch, überholte
Antwort und Destroy können keine alte Anzeige reaktivieren. Es gibt keine
automatischen Abfragen oder Capture-Aufrufe.

## Verifikation und verbleibende Grenzen

Gezielte Tests koppeln das Journal an echte Runtime-/Handoff-Übergänge und den
HTTP-Handler mit signierten ephemeren Testidentitäten; Ring, TTL, Isolation,
Raten, Stop, Schema und Lebenszyklen sind separat geprüft. Angular-Parser und
gerendertes Template werden ohne Medien geprüft. Der Keyboard-Browserfall nutzt
die echte gebaute Angular-App und eine ausdrücklich synthetische native
HTTP-Antwort; er ist kein nativer Encoder-/HLS- oder Produktionsnachweis.

Die vollständigen Moderations-/Auditabläufe und die gemeinsame Produktionsabnahme
bleiben in TBP-030 offen. Diese Funktion allein schließt den Track nicht ab.
