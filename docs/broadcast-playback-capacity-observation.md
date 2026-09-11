# Kapazitätsanzeige einer laufenden Sendung

Im Bereich der laufenden nativen Mehrquellen-Sendung öffnet **Wiedergabesitzungen und Kapazität anzeigen** eine verzögert geladene Angular-Ansicht. Erst **Wiedergabekapazität prüfen** fragt den Server ab. Die gewünschte Anzahl zusätzlicher Cookie-Sitzungen ist zwischen 1 und 10.000 einstellbar. Es werden keine Capture-Rechte angefordert, Quellen geändert oder Sitzungen reserviert.

Die Anzeige liefert:

- Noch nicht abgelaufene Cookie-Sitzungen des eigenen Programms und das konfigurierte Programmlimit.
- Das konfigurierte Limit je Publikumsidentität. Dieses gilt auch über mehrere Sendungen hinweg.
- Ob die gewünschte zusätzliche Anzahl zum Prüfzeitpunkt in Deployment-, Tenant- und Programmbudget passt. Das ist **keine individuelle Wiedergabezulassung**: Bei jeder tatsächlichen Wiedergabe werden Grant, Identitätslimit und Kapazität erneut geprüft. Ein Publikumslimit von null sperrt neue Sitzungen auch bei passenden gemeinsamen Budgets.

Die Quelle ist derselbe `BroadcastPlaybackSessionStore`, der produktiv Cookies ausgibt, erneuert und schließt. Keine zweite Belegungsliste: Close und Ablauf geben Plätze frei, unveränderte Renewals belegen keinen neuen Platz. Widerrufene, aber noch nicht abgelaufene Cookie-Records zählen konservativ weiter. Mehrere Tabs können mehrere Sitzungen belegen; geschlossene Tabs ohne erfolgreichen Close können bis zum Ablauf weiter zählen. Die Zahl ist weder die Zahl aktiver Menschen noch eine Messung von Streams, CPU, Bandbreite oder Providerkosten.

## Contract und Sicherheitsgrenze

`POST /api/broadcasts/{programId}/playback-capacity` verwendet die geschlossenen Verträge `contracts/native-packager/playback-capacity-{request,response}.v1.schema.json`. Der Request ist auf 1 KiB beschränkt; die UI liest maximal 2 KiB Antwort. Erforderlich sind verifiziertes Human-OIDC, aktuelle authentisierte Creator-Membership und Gerätefingerprint. Die Runtime prüft den exakten Tenant, Owner, Raum, Publisher-Peer und Fingerprint. Erwartete Programmrevision und Epoch müssen dem laufenden oder degradierten Programm mit aktueller Writer-Lease entsprechen. Ein laufender Handoff ist nicht abfragbar. Maschinen, Fremdprogramme, alte Gerätebindungen und unbekannte Felder werden abgewiesen.

Antworten sind `no-store`, enthalten weder andere Belegungszahlen noch Identitäten, Cookies, Grants oder Writer-Leases. Maximal zwölf gültig gebundene Abfrageversuche je Minute und tatsächlichem Membership-Objekt; dessen Lebenszyklus besitzt auch das Rate-Budget. Eine negative Budgetantwort nennt keine betroffene fremde Scope oder deren Limit. Wie eine tatsächliche Zulassungsentscheidung kann das aggregierte Ja/Nein Änderungen gemeinsamer Verfügbarkeit erkennen lassen; es beweist keine vollständige Nichtbeobachtbarkeit anderer Last.

Die Momentaufnahme gilt höchstens fünf Sekunden, zusätzlich begrenzt durch Token- und Writer-Ablauf. Im Client beginnt die Frist beim Requeststart, nicht bei Empfang. Kontext-, Epoch-, Revisions- und Eingabewechsel, Zeitüberschreitung, ungültige/rückwärts laufende monotone Uhr und Zerstörung brechen die Anfrage ab und verwerfen späte Antworten. Es gibt keinen automatischen Wiederholungs- oder Reservierungsmechanismus.

## Nachweis und weiterhin offen

Gezielte Node-Tests decken die tatsächlichen Store-Operationen und alle gemeinsamen Budgetgrenzen ab. Ein HTTP-Test kombiniert echte JWT-Prüfung und aktuelle Runtime-/Room-Registry mit einem echten Cookie-Store; die Playback-Grant-Autorität dieses Tests ist eine synthetische Fixture, keine Live-Keycloak-/CDN-Abnahme. Parser-, Controller- und gerenderte Angular-Tests prüfen Klickstart, Grenzen, Fristen und Kontextwechsel ohne Browser-Capture.

Die Anzeige ist instanzlokal. Verteilter Kapazitätsabgleich, ein produktiver CDN-Provideradapter, Kostenfreigaben, gemessene Zuschauertragfähigkeit und gemeinsame Last-/Ausfallabnahme bleiben separate offene Aufgaben. Diese Änderung schaltet keinen CDN-Pfad frei.
