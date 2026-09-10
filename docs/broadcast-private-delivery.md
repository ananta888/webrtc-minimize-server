# Private Broadcast-Auslieferung

## Grant-zu-Cookie-Austausch

Ein bereits von der Control Plane ausgestellter `broadcast-playback`-Grant wird
beim Sitzungsaufbau per `Authorization: Bearer` an
`POST /api/broadcast/playback-sessions` gesendet. Body, Origin und
`res_`-Resource sind geschlossen. Die Antwort enthält ausschließlich eine
same-origin Manifest-URL und setzt eine zufällige, kurzlebige Cookie-Session
mit zwei disjunkten Minimalpfaden:

```text
Secure; HttpOnly; SameSite=Strict; Path=/broadcast/play/<resource>/
Secure; HttpOnly; SameSite=Strict; Path=/api/broadcast/playback-sessions/<session-id>
```

Beide Cookies tragen denselben zufälligen Sessionwert. Der erste ist nur bei
Manifesten und Medien sichtbar, der zweite nur bei Erneuerung und Schließen
genau dieser Sitzung. Ein breites `Path=/` wird nicht verwendet.

Der Browser speichert den Grant nicht im Playerzustand und setzt ihn weder in
URL, History noch Referer. Cookie-Name und Session-ID sind zufällig, pro
Resource pfadgebunden und serverseitig nur im flüchtigen Speicher auf den
ursprünglichen Grant abgebildet. Pro Audience und Prozess gelten harte
Sessiongrenzen.

## Manifest-, Part- und Segmentprüfung

Jeder GET-/HEAD-Zugriff unter `/broadcast/play/<resource>/<file>` benötigt die
passende Cookie-Session. Vor jedem Upstream-Zugriff prüft die Authority den
ursprünglichen Grant erneut gegen Aktion, Resource, Pfad, Programm-/Policy-
Epoche, Ablauf und Widerruf. Manifestzugriffe benötigen
`playback:manifest`; Initsegmente, Parts, Segmente, WebVTT und optionale Keys
benötigen `playback:segment`. Ein Widerruf sperrt deshalb den nächsten Request
auch dann, wenn das Cookie nominell noch gültig wäre.

Zulässig sind nur geschlossene LL-HLS-Queryfelder (`_HLS_msn`, `_HLS_part`,
`_HLS_skip`) und die von MediaMTX erzeugte UUID-Session. `token`,
`access_token`, Traversal, fremde Origins, Methoden oder Resources liefern
einheitlich 404. Native-HLS-Anfragen ohne Origin bleiben zulässig, aber nie
ohne das HttpOnly-Cookie.

## Fester Reverse-Proxy

`BroadcastHlsProxy` konstruiert sein Ziel ausschließlich aus einer beim Start
festen internen Gateway-Origin und dem bereits validierten Pfad. Redirects,
beliebige Hosts, unbekannte Content-Types, ungültige Range-Header sowie
Antworten über 24 MiB werden verworfen. Nur notwendige Content-/Range-Header
werden zurückgegeben; private Antworten tragen `private, no-store`,
`nosniff` und `Cross-Origin-Resource-Policy: same-origin`. Gateway-Bearer und
interne Fehlerdetails gelangen nicht in den Browser.

`PUT /api/broadcast/playback-sessions/<opaque-id>` verlangt exakten Origin,
den API-pfadgebundenen Cookie sowie einen frischen scopegleichen Grant und
erneuert beide Cookie-Pfade. `DELETE` verlangt ebenfalls exakten Origin und
den API-Cookie, entfernt den serverseitigen Grant-Verweis und löscht beide
Cookies über ihre jeweiligen Pfade.

Scopegleich bedeutet dieselbe Tenant-, Zuschauer-Prinzipal- (`audienceRef`),
Geräte-, Raum-, Programm-/Epoche-, Resource- und Policy-Bindung. Eine Erneuerung
wechselt nur Bearer und Ablaufzeit, niemals den Prinzipal einer vorhandenen
Cookie-Sitzung. Auch ein gültiger Grant eines anderen Kontos auf demselben
Gerät kann die Sitzung nicht übernehmen; dafür muss eine neue autorisierte
Sitzung innerhalb dessen eigener Quoten erstellt werden. Ein abgewiesener
Wechsel lässt den alten Grant und seine Quote unverändert; er verlängert sie
nicht. Die per Request geprüfte Widerrufbarkeit bleibt erhalten.

Der vorherige Store verglich `audienceRef` bei Erneuerung nicht und konnte so
eine bestehende Sitzung in eine bereits ausgeschöpfte andere Zuschauerquote
verschieben. Ein deterministischer Negativtest scheitert vor der Korrektur an
der fehlenden Ablehnung. Nach der Korrektur wird der Kontowechsel sowohl bei
freier als auch belegter Zielquote abgewiesen. Reguläre Tokenrotation und die
bestehenden Close-/Prune-/Renewal-Races bleiben getrennt getestet.
Zusätzlich stellt die echte Grant-Authority mit ephemeren Signier- und
P-256-Geräteschlüsseln gültige Grants für zwei Testnutzer desselben Geräts aus:
Beide dürfen jeweils eine eigene Sitzung anlegen, aber nicht die Cookie-Sitzung
des anderen erneuern. Ein frisch signierter Grant desselben Nutzers funktioniert
weiterhin. Das ist ein kryptografischer Komponentennachweis, kein Live-OIDC-
oder Safari-Nachweis.

## Noch offene Produktionsgrenzen

Store, Proxy, Serverrouten, Angular-Exchange-Client, öffentliche sowie private
Policy und die sichere Gateway-Konfiguration sind in der Produktionslaufzeit
aktiviert. Der echte Chromium-Produktionsgate belegt privaten und anonymen
Playback, Session-Rotation, Stop-Widerruf und terminales Polling. Reale
Safari-/Mobilbrowser-Gates, verteilte HA-Sessions und CDN-Cookie-Verhalten
bleiben offen.
