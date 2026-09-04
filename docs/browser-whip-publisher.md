# Browser-WHIP-Publisher

Stand: 2026-09-04, Implementierungsstufe `TBP-011`.

Der Browser besitzt einen echten, hinter einem kleinen Publication-Port
liegenden WHIP-Transport. Er kann genau einen bereits bewusst vorbereiteten
Own-Source-Program-Stream mit höchstens einer Audio- und einer Videospur an
einen geprüften Endpunkt senden. UI und Control Plane sind inzwischen über eine
vor dem Capture abgeschlossene, gerätegebundene Einmal-Challenge verbunden.
Die produktive Runtime lässt den Endpunkt weiterhin default-aus. Das
Vorhandensein des Adapters, ein Deep Link oder das Öffnen des Panels startet
daher weder Capture noch eine Publikation.

## RFC-9725-Ablauf

1. Der Adapter übernimmt ausschließlich den bereits geklonten Stream der
   Composition-Grenze. Beendete Tracks, zwei Audio- oder zwei Videospuren und
   leere Streams werden vor einer PeerConnection abgewiesen.
2. Er erzeugt `RTCPeerConnection` mit `max-bundle`, erforderlichem RTCP-Mux und
   den ausschließlich aus `/config` übernommenen ICE-Servern. Audio und Video
   werden als `sendonly` deklariert; Codecpräferenzen und eine spätere
   Simulcast-Konfiguration stammen aus derselben geprüften Runtime.
3. Ein frischer, höchstens fünf Minuten gültiger Bearer-Grant wird für die
   Aktion `whip:create` und genau den Zielpfad angefordert. Der SDP-Offer geht
   per HTTPS `POST` mit `application/sdp` an den WHIP-Endpunkt.
4. Nur `201 Created`, `application/sdp`, eine begrenzte SDP-Answer und eine
   erlaubte `Location`-Resource werden akzeptiert. Bei Trickle ICE ist im
   strikten Profil zusätzlich ein starkes ETag erforderlich.
5. Gesammelte ICE-Kandidaten gehen begrenzt als
   `application/trickle-ice-sdpfrag` mit frischem `whip:update`-Grant und
   `If-Match` an die Resource. Ein RFC-konformer ICE-Restart nutzt `If-Match:
   *`, übernimmt nur eine valide Fragment-Answer und besitzt ein hartes
   Versuchsbudget.
6. Stop schließt die lokale PeerConnection sofort und löscht die Resource mit
   einem frischen `whip:delete`-Grant. Wiederholter Start derselben Composition
   sowie wiederholtes Stoppen sind lokal idempotent; eine abweichende
   Composition derselben Program-Epoch wird abgewiesen.

Der Adapter speichert den Bearer nicht in seinem Session-State. Requests nutzen
`credentials: omit`, `cache: no-store` und `referrerPolicy: no-referrer`.
Fehlerobjekte und Produktionslogs enthalten weder Grant, SDP noch ICE. Die
Authorization-Schnittstelle ist bewusst injiziert: Die bestehende
`BroadcastGrantAuthority` bleibt die serverseitige Autorität und wird nicht im
UI oder im Transport nachgebaut.

## Grenzen und Redirects

Endpunkt und Redirect-Allowlist akzeptieren im Produkt ausschließlich HTTPS,
keine URL-Credentials, Query-Tokens oder Fragmente. Relative und gefolgte
same-origin Resources sind erlaubt. Ein finaler Redirect-Zielorigin muss in
der Runtime-Allowlist liegen. Nicht gefolgte `301`, `302` und `303` werden als
unsicher abgewiesen; `307` und `308` müssen vom Browser vollständig gefolgt
worden sein. Bei einem Cross-Origin-Redirect kann der Browser den
Authorization-Header entfernen. Ein solcher Gatewayaufbau gilt daher trotz
Allowlist erst nach realem CORS-/Auth-Test als einsatzfähig.

Antwort-, SDP-, ICE-Fragment- und Kandidatenzahl, drei getrennte Timeouts sowie
das Retry-Budget sind hart begrenzt. Automatische Wiederholung gibt es nur für
`429` und `503`; jede Wiederholung fordert einen neuen aktions- und
pfadgebundenen Grant an. `401`, abgelaufene Grants, unbekannte Content-Types,
unzulässige Redirects, CORS-/Netzfehler und verlorene Sessions schlagen
fail-closed fehl. Ein Verbindungsverlust wird sichtbar `degraded`; ein
fehlgeschlagener oder ausgeschöpfter ICE-Restart wird `failed` und nicht
unbegrenzt wiederbelebt.

## MediaMTX-1.20-Kompatibilitätsprofil

Der reale Test gegen das gepinnte Image
`bluenviron/mediamtx@sha256:1b029d11049be75630e9b73bb0d5f47b08a7db4eaee89a80bf8f53bc40e56414`
hat in Chromium und Firefox `POST`, Trickle-`PATCH`, ICE-Verbindung und
`DELETE` bestätigt. Dabei liefert MediaMTX 1.20.1 ein ETag `*` und keine
`a=rtcp-mux-only`-Zeile in der Answer. Das getrennte Profil
`mediamtx-1.20` toleriert ausschließlich diese beiden beobachteten
Abweichungen. Weil kein starkes ETag vorliegt, meldet es ICE-Restart ehrlich als
`whip_ice_restart_unsupported`; das strikte Profil wird nicht aufgeweicht.

Die reproduzierbare Live-Prüfung läuft nach dem bewussten Start eines lokalen
Test-Gateways:

```bash
docker run -d --rm --name webrtc-whip-gate \
  -e MTX_WEBRTCADDITIONALHOSTS=127.0.0.1 \
  -p 18889:8889 -p 8189:8189/udp \
  bluenviron/mediamtx@sha256:1b029d11049be75630e9b73bb0d5f47b08a7db4eaee89a80bf8f53bc40e56414

RUN_LIVE_WHIP_MEDIAMTX=1 npm run test:whip:mediamtx
docker stop webrtc-whip-gate
```

Der Browser-Gate enthält einen sichtbaren Test-Button und erzeugt erst nach
dessen Klick einen Canvas-Testtrack. Chromium und Firefox müssen verbinden,
stoppen und den im Kompatibilitätsprofil nicht verfügbaren ICE-Restart sichtbar
melden. Ohne das Opt-in meldet `npm run check` den Infrastrukturtest als
`SKIP`, nicht als bestandenen Live-Test.

## Noch nicht als Produktionsfähigkeit behauptet

Adapter, aktionsgebundene Grant-HTTP-Grenze, In-Memory-Program-Orchestrierung,
Ausgabe-/Playback-API und sichtbare Start-/Stop-UI sind vorhanden. Der
öffentliche Broadcast bleibt trotzdem deaktiviert, bis der isolierte
Gatewaybetrieb, CORS, Widerruf, LL-HLS-Ausgabe und Browser-/Geräte-Soaks im
echten Deployment gemeinsam verifiziert wurden. Simulcast ist im
Runtime-Schema vorbereitet und nur mit einem kompatiblen Gatewayprofil
aktivierbar. Feste Media-Sections, sichere Quellenwechsel und die gedämpfte
Sendersteuerung sind in
[TBP-012](whip-source-switching-adaptation.md) beschrieben; öffentlich nutzbar
werden sie erst nach dem Produktionsgate.
