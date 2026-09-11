# Native Kapazitätsvorschau vor dem Broadcast-Start

In der Mehrquellen-Sendung stehen vor dem Start die Auswahl des Packagers und
der Audio-/Video-Ausgabe sowie „Packager-Kapazität prüfen“ zur Verfügung. Erst
dieser Klick löst eine Abfrage aus. Das Öffnen des Panels startet weder eine
Abfrage noch Capture, eine Sendung oder eine Medienfreigabe.

Die Antwort zeigt die von der aktuellen Native-Admission tatsächlich ausgewählte
Low-first-Ladder: Auflösung, FPS, Video- und AAC-Audiorate, Kanäle, Encoder und
Ressourcenbedarf. Packager-Fähigkeiten können die gewünschte Zahl der Stufen
reduzieren. Der Egress-Planwert summiert alle Ausgabestufen einschließlich 15 %
Puffer; er ist **nicht** der Traffic aller Zuschauer. CPU-Planeinheiten, MiB und
Encoder-/GPU-Slots stammen aus derselben Budgetberechnung wie die echte
Assignment-Zulassung, nicht aus einer Messung freier Hardware.

Die native Ressourcenprüfung berücksichtigt die momentan belegten Budgets der
Instanz, des verifizierten Tenants und des Kontos. Sie reserviert nichts.
Zusätzlich muss das instanzlokale [Encoder-Minuten-Budget](native-encoder-time-budgets.md)
eine initiale 60-Sekunden-Lease der gewählten Stufen erlauben. Auch diese reine
Vorprüfung verbraucht keine Minuten; fremde Verbrauchswerte werden nicht gezeigt.
Die kombinierte v2-Vorschau prüft zusätzlich, ob die Instanz-, Gateway-, Tenant-
und Kontolimits einen weiteren Programmstart zulassen. Grundlage sind die
tatsächlichen aktiven Programme und ausstehenden Publisher-Starttransaktionen,
nicht ein separater Reservierungszähler. Entwürfe und terminal gestoppte
Programme belegen dabei keinen aktiven Slot. Ein laufender und zugleich noch
registrierter Start desselben Programms zählt nur einmal; der neue Start zählt
immer zusätzlich. Die Prüfung erfolgt vor und nach der nativen Admission,
damit ein zwischenzeitlicher anderer Start kein veraltetes Ergebnis erzeugt.

Viewer-Kapazität, verfügbare Leitung, CDN-Last, Providerpreis
und Kostenfreigabe sind dadurch nicht bestätigt. Kosten bleiben ausdrücklich
„nicht berechenbar“. Bei einem späteren Start werden die dann gültigen
Zulassungen unabhängig erneut geprüft. Die Vorschau ist ein Hinweis, kein
Startticket und keine verpflichtende Freigabe, die sich wiederverwenden ließe.

## Vertrag und Autorisierung

`POST /api/broadcasts/native-capacity-preview` verwendet die vorhandene OIDC-
HTTP-Authentisierung, Origin-Prüfung und 16-KiB-Bodygrenze. Zusätzlich gilt ein
eigenes Limit von zwölf Versuchen pro verifiziertem Konto in 60 Sekunden; die
Rate-Zähler halten nur HMAC-abgeleitete Schlüssel. Kein Detail zu fremden
Belegungen oder Identitäten wird ausgegeben. Fehlende Berechtigung und Quoten
bleiben Ablehnungen, keine erfolgreichen Nullkosten-Vorschauen.

Der geschlossene Request-Vertrag `capacity-preview-request.v2.schema.json`
verlangt `previewVersion: 2` unabhängig von den bestehenden Ausgabe-
Auswahlgenerationen `requestVersion` 1 (Standard), 2 (Audio), 3 (Video
plus explizit nullable Audio). Er enthält keinen Tenant, Principal, Program-ID,
Lease, Titel oder Medieninhalt. Die Fingerprint-Zuordnung wird gegen eine aktuell
authentisierte menschliche Creator-Membership dieses Raums geprüft. Besitz,
Onlinezustand, aktuelle native Quellengeneration und Raumconsent des Packagers
kommen aus der Control Plane, nicht aus den Request-Feldern.

Der Antwortvertrag `capacity-preview.v2.schema.json` bestätigt Programmslots
explizit mit `programSlots: "available"`, nicht mit einer Anzahl, internen
Limits oder einer Reservierung. Ohne bestätigenden internen Runtime-Port oder
bei erschöpften Slots endet die Abfrage allgemein mit HTTP 429
`broadcast_temporarily_unavailable`. Authentisierung und Creator-/Geräteprüfung
erfolgen vor der Slotabfrage; Client-Scopefelder bleiben verboten.

Alte Requests ohne `previewVersion` bleiben über den unveränderten v1-Vertrag
unterstützt und bestätigen weiterhin nur native Ressourcen. Der neue
Angular-HTTP-Pfad fordert v2 und akzeptiert keine v1-Antwort als kombinierte
Prüfung. Die Anzeige kennzeichnet ältere Beobachtungen ausdrücklich, falls
eine solche über einen anderen bestehenden Adapter geliefert wird.

Der Runtime-Parser
prüft zusätzlich zur Schemaform die geordnete Ladder, die Reduktionsangabe,
Ressourcenarithmetik und maximal fünf Sekunden Beobachtungsdauer. Interne feste
Preview-IDs dienen nur dem Wiederverwenden der reinen Admission. Sie werden
weder registriert noch ausgegeben; es entstehen keine Programme, Assignments,
Writer-Leases, ICE-Credentials, Schlüssel oder Agentenkommandos.

## Frische und Lebenszyklus

Die UI zählt maximal fünf Sekunden monoton ab **Abfragebeginn**, nicht erst ab
Antwortempfang. Übertragungszeit verlängert die Frische nicht. Epoch-, Konto-,
Raum-, Capability-, Verbindungs- und Formularwechsel entwerten die Antwort.
Abgelaufene oder verdrängte Anfragen werden abgebrochen; verspätete Ergebnisse
dürfen eine neuere Anzeige nicht überschreiben. Nach Schließen des Panels
werden Timer und Anfragen beendet. Es gibt keine automatischen Retry- oder
Startschleifen. Die Anzeige benennt den Prüfzeitpunkt und verspricht nicht, dass
die beobachteten Ressourcen bis zum Start verfügbar bleiben.

## Nachweisgrenzen

Die v2-Erweiterung prüft vier echte HTTP-Belegungsgrenzen einschließlich
Entwurf, aktiver Belegung, Stop/Freigabe und alter v1-Antworten. Die Runtime-
Tests erfassen zusätzlich ausstehende WHIP-Starts bis Commit, Stop, Timeout oder
Issuerfehler. Policy und Vorschau testen ungültige Scopefelder, fehlende Ports,
erneute Belegungsprüfung nach dem nativen Aufruf sowie das Ausbleiben von
Programmen, Assignments und Credentials. Die UI-Tests prüfen beide
Versionsanzeigen, strikte Downgrade-Ablehnung und den bestehenden Ablauf ab
lokalem Klick. Kostenfreigabe oder ein neuer Produktionsnachweis folgt daraus
nicht.

Für diesen Abschnitt bestanden 29 gezielte Policy-/Runtime-/HTTP-Prüfungen,
14 Frontend-/Parser-/Service-/Renderprüfungen und 68 bestehende Runtime-,
Metrik- und Native-Handoff-Prüfungen. Typprüfung, Todo-Gate und privater
Produktionsbuild bestanden ebenfalls. Der ausgelieferte Build wurde dabei
nicht ersetzt; gemeinsame CI und Produktionsfreigabe sind getrennte Gates.

Gezielte Tests prüfen reale Admission/Budgets, geschlossene Verträge, tatsächliche
HTTP-Routen mit synthetischen Auth-/Membership-Fixtures, UI-Service-Fencing,
monotone Fristen und die gerenderte Angular-Komponente unter jsdom.
Dies ist kein neuer JWKS-, echter Browser-/NAT-, Encoder- oder Lastnachweis.
Die große gemeinsame Browser-/Produktionsabnahme und das Deployment folgen
gebündelt nach der Implementierungsrunde. TBP-024, TBP-030 und TBP-033 bleiben
offen; insbesondere Providerkosten und Zuschauer-Kapazitätsplanung sind dadurch
nicht vollständig implementiert.
