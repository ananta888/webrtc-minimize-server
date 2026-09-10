# HLS-Sitzungsquoten

Stand: 2026-09-11. Der echte Serverkonstruktor reicht diese Operatorlimits an
den `BroadcastPlaybackSessionStore` weiter:

| Variable | Default | Geltungsbereich |
| --- | ---: | --- |
| `BROADCAST_MAX_PLAYBACK_SESSIONS` | 1024 | Alle Cookie-Sitzungen dieses Prozesses |
| `BROADCAST_MAX_PLAYBACK_SESSIONS_PER_TENANT` | 1024 | Gemeinsamer Tenant aus geprüften Grants |
| `BROADCAST_MAX_PLAYBACK_SESSIONS_PER_PROGRAM` | 500 | Tenant und Programm gemeinsam, über Ressourcen und Epochen hinweg |
| `BROADCAST_MAX_PLAYBACK_SESSIONS_PER_AUDIENCE` | 4 | Grant-Audience über alle Programme, entsprechend der bisherigen Grenze |

Werte müssen ganze Zahlen zwischen 0 und 10.000 sein. Null sperrt neue
Sitzungen, ist keine unbegrenzte Freigabe. Leere/ungültige ENV-Werte schlagen
fehl; Compose ersetzt ausdrücklich leere Werte nicht still durch Defaults.
Defaults sind Schutzbudgets, **kein Nachweis von 500 gleichzeitigen Zuschauern**.

## Autorität und Lifecycle

Vor jeder neuen Cookie-Ausgabe müssen sowohl Manifest- als auch Segmentrecht
durch die bestehende Grant-Autorität bestätigt sein. Tenant, Programm und
Audience stammen ausschließlich daraus; der HTTP-Client darf nur die
Ressourcenreferenz angeben. Fehlende oder fehlerhafte Scopefelder bleiben 404.
Die Policy akzeptiert die bestehenden `sub_`-/`pkr_`-Audienceformen des
Grantvertrags, begründet aber selbst keinerlei Zugriffsrecht.

Erst danach wird der aktuelle Sitzungsspeicher ausgewertet, unmittelbar vor
der synchronen ID- und Cookie-Allokation. Gleichzeitig wartende Grantprüfungen
können dadurch nicht denselben freien Platz mehrfach belegen. Quotenfehler
liefern 429 ohne Set-Cookie und ohne Tenant-/Programm-/Kapazitätsdetails. Bereits
ausgegebene zulässige Sitzungen werden nicht verdrängt. Der vorgelagerte
Credential-Abuse-Schutz bleibt unabhängig aktiv.

Eine Erneuerung derselben Cookie-, Geräte-, Audience-, Policy- und Epochbindung
benötigt keinen weiteren Platz. Sie darf die Sitzung nicht in einen anderen
Scope verschieben. Close entfernt den Platz unmittelbar; die bestehende
Expiry-Bereinigung entfernt abgelaufene Sitzungen beim nächsten Zugriff.
Widerrufene, noch nicht abgelaufene Sitzungen können konservativ weiter zählen;
ihre Medienanfragen müssen trotzdem jedes Mal die aktuelle Grantprüfung bestehen.
Es gibt keine zweite Reservierungsliste oder Quoten-TTL neben den echten Records.

## Aussagegrenzen und Tests

Gezählt werden Cookie-Sitzungen, **nicht Menschen oder aktive Zuschauer**.
Eine erneute Anfrage ohne den bestehenden Sitzungsworkflow kann einen weiteren
Platz verbrauchen; die Audience-Grenze begrenzt das grob. Anonyme Identitäten
werden nicht durch invasives Fingerprinting zusammengeführt. Ein Programmwechsel
ändert nicht die Zählung bereits vorhandener anderer Sitzungen.

Die Grenzen gelten pro Node-Prozess und nur für diesen HLS-Cookiepfad. Direkte
Gateway-, CDN-, WHIP-/WHEP- oder MoQ-Nutzung erhält dadurch keine gemeinsame
Viewerquote. Egress, Request-Bursts, Encoder, Programmdauer und Room-Membership
besitzen eigene Grenzen. Clusterweite Budgets, echte Zuschaueraggregate,
Providerkosten und die gemeinsame Medien-/Lastabnahme bleiben offen.

Node-Tests prüfen alle ENV-/Compose-Grenzen, Nullbudgets, Scopefehler,
gleichzeitige Zulassung, Renewal, Close und Expiry. Vier echte HTTP-Tests verwenden
den unveränderten Serverkonstruktor mit kontrollierter Grant-Autorität und prüfen
Cookieausgabe, private 404, Quoten-429, anschließende Freigabe und Health-200.
Ein zusätzlicher Test verwendet echte P-256-Gerätenachweise und signierte Grants
zweier Benutzer für denselben privaten Stream. Dies ersetzt keine öffentliche
TLS-/OIDC-/Browser- oder WAN-Lastabnahme.
