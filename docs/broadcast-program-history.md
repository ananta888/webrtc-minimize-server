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
Mit dem additiven v2-Vertrag kommen Quellenzustimmung, Quellenwiderruf mit
Quellenart/Entscheidungsgrund sowie agentenbestätigte Audio- und Layoutänderungen
mit ihrer jeweiligen lokalen Steuerrevision hinzu. Freigabe bedeutet keinen
Empfang; Widerruf protokolliert die Control-Plane-Entscheidung, nicht den Nachweis
einer Speicherlöschung auf einem anderen Rechner. Audio-/Layout-ACK ist ebenfalls
kein Beweis für gerenderte Ausgabe. Query, abgewiesene/stale Antworten und
duplizierte ACKs erzeugen keine erfolgreichen Aktionseinträge.
Heartbeats und idempotente Wiederholungen erzeugen keine zusätzlichen Einträge.
Eine Writer-Zuordnung ist **keine** Ausgabebestätigung. Erst der bestehende
Output-Ready-Pfad setzt den Zustand auf `live`; auch das beweist keinen Empfang
bei einem Zuschauer. Standbys erhalten durch Beobachtung oder Vormerkung keine
Medienschlüssel. Das Journal autorisiert keine Aktion und startet keinen Failover.

Der additive v3-Vertrag ergänzt Einladungen und abgewiesene Regiebefehle:
`source-requested` (Quellenart, Grund `own-source` oder `invited`) entsteht erst
nach Kontext-, Ziel- und Quotenprüfung mit gespeicherter Einladung;
`source-request-closed` (Grund `declined`, `cancelled` oder `invalidated`) nach
dem tatsächlichen Zustandswechsel der Einladung, Invalidierung in der bestehenden
Aktualitätsprüfung bei Programm-, Writer- oder Mitgliedschaftswechsel.
`scene-rejected`/`audio-rejected` entstehen an derselben Stelle wie die
bestätigten Änderungen, also erst nach der abschließenden Autoritäts- und
Versionsprüfung des Direktors; der feste Ablehnungscode ist durch den Typ
bestimmt und wird nicht gesondert übertragen. Abgewiesene, gedrosselte oder
nicht autorisierte Anfragen, idempotente Wiederholungen und reine Abfragen
erzeugen keine Einträge. Eine unbeantwortet abgelaufene Einladung wird bewusst
nicht journaliert: Der Einladungsdatensatz bleibt nach erteilter Zustimmung bis
zu seinem TTL unverändert bestehen, ein „abgelaufen“ nach Zustimmung wäre
irreführend. Der v2-Vertrag erhält diese Typen nicht.

Die Anzeige ist ausdrücklich **kein vollständiges Audit**: einzelne Quellen
und Einladungen werden nicht identifizierbar aufgezeichnet, Teilnehmer,
Anfragekennungen und Fehlerursachen fehlen; der Verlauf ist flüchtig und
prozesslokal. Die bestehenden Autorisierungs-
und Widerrufspfade bleiben unverändert. Beobachterfehler dürfen eine bereits
getroffene Sicherheitsentscheidung weder zurücknehmen noch deren Wirkung
verhindern. Ereignisse einer überholten Programmepoche werden nicht nachträglich
als aktuelle Aktion eingeordnet. Das Journal bleibt best-effort und `complete:false`.

## Zugriff und Aufbewahrung

`POST /api/broadcasts/:programId/native-program-history` akzeptiert ausschließlich
die geschlossenen v1-/v2-/v3-Verträge aus `contracts/native-packager/`. Der Browser
fordert ausdrücklich v3 an; ein v1-/v2-Request erhält unverändert nur die jeweils
bekannten Ereignistypen und Felder, gefiltert **vor** der 32er-Grenze. Er benötigt
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
und ein 15-Minuten-Abfragefenster. Abgelaufene Einträge werden bei Zugriffen und
in der bestehenden 500-ms-Runtime-Bereinigung entfernt (abhängig vom Event-Loop,
keine harte Echtzeit-Speicherlöschungszusage). Andere Programme können ältere eigene
Einträge verdrängen; es werden weder fremde Zähler noch globale Sequenznummern
ausgegeben. Einträge enthalten nur Ereignistyp, Zustand, Revision, Epoche,
Zeitpunkt und Standby-Anzahl; v2 zusätzlich nur Quellenart, festen Widerrufsgrund
oder Audio-/Szenenrevision, v3 zusätzlich feste Einladungs-/Schließgründe,
ansonsten `null`. Keine Namen, Medien, Untertiteltexte, Tokens,
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
