# Private Broadcast-Auslieferung

## Grant-zu-Cookie-Austausch

Ein bereits von der Control Plane ausgestellter `broadcast-playback`-Grant wird
nur einmal per `Authorization: Bearer` an
`POST /api/broadcast/playback-sessions` gesendet. Body, Origin und
`res_`-Resource sind geschlossen. Die Antwort enthält ausschließlich eine
same-origin Manifest-URL und setzt eine zufällige, kurzlebige Cookie-Session:

```text
Secure; HttpOnly; SameSite=Strict; Path=/broadcast/play/<resource>/
```

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
Upstreamantworten gelangen nicht in den Browser.

`DELETE /api/broadcast/playback-sessions/<opaque-id>` verlangt exakten Origin
und das passende Cookie, entfernt den serverseitigen Grant-Verweis und löscht
das Cookie über denselben Pfad.

## Noch offene Produktionsgrenzen

Store, Proxy, Serverrouten und Angular-Exchange-Client sind implementiert und
negativ getestet. Die normale Laufzeit erzeugt den Proxy jedoch noch nicht,
solange Broadcast-Program-Orchestrierung, Grant-Ausgabe und sichere
Gateway-Konfiguration nicht gemeinsam aktiviert sind. Caddy-Rate-Limits,
reale Safari-/hls.js-Cookie-Gates, Key-/Cookie-Rotation und CDN-Verhalten sind
noch offen. Öffentliche Streams erhalten später eine ausdrücklich getrennte
Policy; sie fallen nicht stillschweigend aus der privaten Prüfung heraus.
