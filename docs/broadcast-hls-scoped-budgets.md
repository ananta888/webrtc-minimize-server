# HLS-Auslieferungsbudgets pro Tenant und Zuschaueridentität

Der HLS-Proxy prüft Request-Rate, Egress-Zielrate und Byte-Burst gleichzeitig
für die gesamte Instanz, den verifizierten Tenant und die verifizierte
Zuschaueridentität (`audienceRef`) innerhalb dieses Tenants. Alle drei Grenzen
müssen erfüllt sein. Eine Zuschaueridentität ist weder eine eindeutige Person
noch das Betreiberkonto des Programms. Die bestehenden globalen
Playback-Sitzungsgrenzen pro Audience gelten unabhängig davon weiter.

| Globale Variable | Zusätzliche Scope-Suffixe |
| --- | --- |
| `BROADCAST_HLS_MAX_REQUESTS_PER_SECOND` | `_PER_TENANT`, `_PER_AUDIENCE` |
| `BROADCAST_HLS_MAX_EGRESS_BITS_PER_SECOND` | `_PER_TENANT`, `_PER_AUDIENCE` |
| `BROADCAST_HLS_EGRESS_BURST_BYTES` | `_PER_TENANT`, `_PER_AUDIENCE` |

Nicht gesetzte Scope-Werte erben den tatsächlich konfigurierten globalen Wert.
Die Defaults bleiben 200 Requests/s, 100 Mbit/s und 24 MiB Burst. Scope-Werte
von null verweigern den entsprechenden Bedarf; globale Werte bleiben positiv.
Leere, negative, gebrochene oder außerhalb der vorhandenen Grenzen liegende
Werte verweigern den Start. Compose erhält explizite Leerwerte einschließlich
vererbter Leerwerte, statt sie durch einen scheinbar gültigen Default zu ersetzen.

## Autorität und Verbrauch

Die Playback-Session-Registry liefert erst nach der aktuellen Grantprüfung
eine kleine immutable interne Budget-Scope. Diese erscheint weder im
öffentlichen Session-JSON noch in Proxy-Headern. Requestfelder, URL-Parameter,
Cookieinhalte, Program-IDs und behauptete Tenant-IDs wählen keine Budget-Scope.
Erneuerung, mehrere Tabs, mehrere Programme und neue Cookies derselben
Identität setzen ihren Verbrauch nicht zurück. Ein anderes Konto desselben
Tenants teilt dessen Grenze; derselbe Audience-Ref in einem anderen Tenant
besitzt eine getrennte Audience-Grenze. Die Instanzgrenze bleibt gemeinsam.

Vor dem Upstream-Aufruf wird ein Request gegen alle drei Budgets geprüft und
atomar belastet. Eine Scope-Ablehnung belastet keine andere Scope. Scheitert
danach die bestehende Parallelitätszulassung oder der Upstream, gibt es keine
Erstattung. Jeder Byte-Chunk wird vor dem Enqueue geprüft und ebenfalls atomar
belastet. Verbrauchte Bytes werden bei Abbruch nicht erstattet. HEAD verbraucht
Requestbudget, liefert aber keinen Body; nicht gelesene Body-Daten verbrauchen
kein Egressbudget dieses Proxys.

Alle drei Token-Buckets verwenden pro Entscheidung denselben intern fixierten
monotonen Zeitpunkt. Zwischen Prüfung und Abbuchung gibt es weder asynchrone
Arbeit noch externe Ports. Ein ungültiger oder rückwärts laufender Zeitgeber
sperrt neue Entscheidungen dieser Instanz dauerhaft. Eine längere Pause füllt
höchstens das konfigurierte Burstbudget, nicht unbegrenzt Guthaben auf.

## Speicher und Fehlerverhalten

Höchstens 8192 Scoped-Buckets enthalten instanzzufällige HMAC-Digests und
Tokenstände. Sie enthalten keine Medien, Tokens, Räume oder Klartext-Identitäten.
Ein voller Speicher entfernt nur vollständig wieder aufgefüllte Einträge;
erschöpfte Einträge dürfen nicht durch Identitätswechsel verdrängt werden.
Streamhandles behalten lediglich Digest-Schlüssel. Nach einer zulässigen
Entfernung verwenden alte und neue Handles denselben neu erzeugten Bucket,
statt zwei voneinander unabhängige Guthaben zu erhalten.

Vor dem Upstream-Aufruf ist eine Quotenablehnung die allgemeine Antwort
`429 broadcast_playback_temporarily_unavailable`, ohne fremde Belegung oder
die betroffene Scope zu verraten. Ist ein Body bereits gestartet, wird der
betroffene Stream begrenzt abgebrochen und sein Parallelitätsplatz freigegeben.
Je nach Socket-Timing sieht der Client einen Abbruch vor den Headern oder
während des Bodys; ein nachträglicher HTTP-Status 429 ist dann nicht garantiert.
Unbekannte oder widerrufene Playback-Sitzungen bleiben unabhängig davon 404.

## Nachweis und verbleibende Grenzen

Kurze Tests prüfen atomare Request-/Byte-Verrechnung, Nullwerte, fractional
Refill, Clock-Rollback, Speichergrenze, Scope-Mutation und alte Streamhandles.
Reale Playback-Registry-/Proxy-Aufrufe belegen Tabs, Programmwechsel,
Cookie-Erneuerung und ignorierte Request-Scope-Manipulationen. Echte lokale
HTTP-Aufrufe prüfen alle sechs ENV-Grenzen in der regulären Server-Komposition,
ohne einen Proxy zu injizieren; fehlende Auth und Health bleiben unverändert.
Compose-Tests prüfen tatsächliche Vererbung, Nullwerte und Leerwerte.

Das sind instanzlokale Transportbudgets, keine gemessene Hostkapazität,
neustartfeste Abrechnung, physische Traffic-Shaping-Garantie oder Providerkosten.
Ein direkt bedienter CDN-Pfad wird dadurch nicht gezählt oder begrenzt. Seine
Provider-Quoten, Kostenobergrenzen, Last- und Failover-Abnahme bleiben offen.
Auch die bekannten separaten Audio-Kalibrierungs-/Ausfallbefunde sind damit
nicht behoben. Raum-Membership, SFrame und Capture werden nicht verändert.
