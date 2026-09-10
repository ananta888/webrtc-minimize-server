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
Aktive-Programmlimits, Viewer-Kapazität, verfügbare Leitung, CDN-Last, Providerpreis
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

Der geschlossene Request-Vertrag `capacity-preview-request.v1.schema.json`
enthält die bestehenden Auswahlgenerationen 1 (Standard), 2 (Audio), 3 (Video
plus explizit nullable Audio). Er enthält keinen Tenant, Principal, Program-ID,
Lease, Titel oder Medieninhalt. Die Fingerprint-Zuordnung wird gegen eine aktuell
authentisierte menschliche Creator-Membership dieses Raums geprüft. Besitz,
Onlinezustand, aktuelle native Quellengeneration und Raumconsent des Packagers
kommen aus der Control Plane, nicht aus den Request-Feldern.

Der Antwortvertrag ist `capacity-preview.v1.schema.json`. Der Runtime-Parser
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

Gezielte Tests prüfen reale Admission/Budgets, geschlossene Verträge, tatsächliche
HTTP-Routen mit synthetischen Auth-/Membership-Fixtures, UI-Service-Fencing,
monotone Fristen und die gerenderte Angular-Komponente unter jsdom.
Dies ist kein neuer JWKS-, echter Browser-/NAT-, Encoder- oder Lastnachweis.
Die große gemeinsame Browser-/Produktionsabnahme und das Deployment folgen
gebündelt nach der Implementierungsrunde. TBP-024, TBP-030 und TBP-033 bleiben
offen; insbesondere Providerkosten und Zuschauer-Kapazitätsplanung sind dadurch
nicht vollständig implementiert.
