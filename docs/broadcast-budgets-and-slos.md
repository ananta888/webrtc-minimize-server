# Broadcast-Budgets und SLOs

## Admission vor dem Start

`evaluateBroadcastBudget` prüft jeden geplanten Broadcast gegen drei getrennte
Scopes: Deployment, OIDC-Tenant und Principal. Jeder Scope begrenzt
Viewer-Sessions, Egress, Encoder-Slots, Encoder-Minuten, Programmdauer und
Kosten in Mikroeinheiten. Es gibt bewusst keine globale Raumanzahl; diese
Budgets schützen ausschließlich Broadcast-Ressourcen.

Bei mindestens 80 Prozent eines Limits liefert Preflight eine sortierte
Soft-Limit-Warnung. Eine Überschreitung verweigert den Start mit Scope und
Metrik im internen Fehlercode. Die sichtbaren Kapazitätsklassen sind
`origin-small` bis 20 Viewer, `cdn-medium` bis 500 und `cdn-large` darüber.
Diese Klassifikation ist eine Kostenvorschau, keine Freigabe: Das getrennte
Delivery-Profil muss weiterhin runtime-verifiziert und verfügbar sein.

## Datensparsame Viewerzahl

`PrivacyPreservingViewerCounter` zählt kurzlebige Playback-Session-IDs pro
Programm. Eine keyed HMAC ersetzt die Session-ID im Zähler; IP-Adresse,
User-Agent, OIDC-Subject und Gerätefingerprint werden nicht benötigt. Eine
wiederholte Session zählt innerhalb der 30-Sekunden-Lease nur einmal. Ablauf
entfernt Einträge und leere Programme; Destroy löscht State und überschreibt
den HMAC-Key-Buffer.

Das ist eine grobe Gleichzeitigkeitsschätzung: mehrere Tabs können getrennt
zählen und eine geteilte Session einmal. Sie ist nicht als Personenmessung und
nicht für invasives Fingerprinting gedacht.

## Profilbezogene SLO-Ziele

| Profil | Fenster | Start p95 | End-to-glass p95 | Rebuffer max. | Verfügbarkeit | Caption p95 | Abbruch max. | 30-Tage-Fehlerbudget |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Origin LL-HLS | 5 min | 3 s | 5 s | 2 % | 99 % | 4 s | 3 % | 432 min |
| CDN Standard-HLS | 15 min | 6 s | 12 s | 1 % | 99,5 % | 8 s | 2 % | 216 min |

Beide SLO-Sätze sind vorerst `runtimeVerified: false`. Sie definieren
Messfenster und gewünschte Grenzen, werden aber erst nach echten
Browser-/Netz-/Caption-Lastläufen zu veröffentlichten Zusagen. Der kurze
MediaMTX-Origin-Gate belegt Request-/Ressourcenwerte, nicht diese Player-SLOs.

## Offene Operationalisierung

Die Policies und Negativtests sind vorhanden; es fehlen noch persistente,
transaktionale Usage-Zähler, konkrete Providerpreise, Monatsperioden,
UI-Preflightverdrahtung, Alerting/Error-Budget-Auswertung und reproduzierbare
Lastläufe je veröffentlichter Host-/Region-/Codec-/Rendition-Klasse.
