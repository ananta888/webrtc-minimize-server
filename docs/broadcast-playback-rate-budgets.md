# HLS: Wiedergabe ist kein unbekannter Probeabruf

Der native Audio-Browsertest reproduzierte zweimal einen stillstehenden Player
bei 28,032 Sekunden und 420 Frames. Anfangston und Mute waren beim Zuschauer
bereits dekodiert. Eine begrenzte rein lesende Diagnose des letzten veröffentlichten
fMP4-Segments zeigte weiterhin korrekten Ton nach Unmute: RMS ungefähr
0,088 links und 0,044 rechts bei angeforderten 50 beziehungsweise 25 Prozent.
Producer und veröffentlichtes Segment stimmten überein; der Player meldete
`broadcast_player_rate_limited`.

Die HTTP-Route belastete bisher **jeden** Playlist-, Initialisierungs- und
Segmentabruf mit `playback-probe`, begrenzt auf 30 pro Minute und IP-Adresse.
Schon ein einzelner normaler HLS-Player überschreitet dieses Budget. Ein
separater HTTP-Regressionstest scheiterte vor der Korrektur genau am 31. Abruf
einer gültigen Playback-Sitzung mit HTTP 429.

## Getrennte, weiterhin begrenzte Schlüssel

- Unbekannte Sitzungen, falsche Cookies, Ressourcen, Methoden, Origins oder
  Dateipfade verwenden weiterhin das 30-Probeabrufe-pro-Minute/IP-Budget.
- Eine bekannte aktuelle lokale Playback-Sitzung verwendet ein eigenes
  `playback-media`-Budget von maximal 1.200 Abrufen pro Minute. Das berücksichtigt
  auch subsekündliche Playlist-/Partabrufe; es ist keine unbegrenzte Ausnahme.
  Beispielsweise benötigen Parts plus Playlist bei 200 ms etwa zehn Abrufe
  pro Sekunde, zuzüglich Initialisierung, Wechsel und Untertiteln.
- Die Zuordnung verlangt den exakten Cookie-Namen und -Wert, aktuelle lokale
  Session, Ressource sowie gültige Requestfelder. Eine vom Client behauptete
  Session-ID, ein Cookiepräfix oder eine gemeinsame IP genügen nicht.
- Diese billige lokale Zuordnung ist **keine Autorisierung**. Jeder weitergeleitete
  Abruf muss anschließend weiterhin den aktuellen Grant, Scope, Ablauf und
  Widerruf bestehen. Auch eine noch bekannte Sitzung mit inzwischen widerrufenem
  Grant darf kein Segment erhalten.
- Die bestehenden Grenzen von sechs gleichzeitigen Abrufen pro Sitzung,
  64 insgesamt sowie Antwortgrößen-, Zeit- und Sessionquoten bleiben unverändert.
  Rate-Buckets bleiben begrenzt und HMAC-pseudonymisiert; keine Cookies oder
  Grantdaten werden in Diagnosen ausgegeben.

Zwei Zuschauer hinter derselben NAT-Adresse verbrauchen damit nicht mehr das
gemeinsame Probe-Budget für ihre autorisierte Wiedergabe. Unbekannte Probeabrufe
können umgekehrt die gültigen Sitzungen nicht durch diesen IP-Bucket sperren.
Ein bekannter, aber widerrufener Grant bleibt gesperrt; die getrennte Rateklasse
ist keine Wiederherstellung seiner Rechte.

## Verifikation und Grenzen

24 fokussierte Admission-/Session-/Proxy-/HTTP-Prüfungen bestanden in 675 ms.
Der echte HTTP-Fall prüft 90 zulässige Abrufe, falschen Cookie-Namen, weiterhin
begrenzte unbekannte Probes, zwei Sitzungen hinter derselben IP und wirksamen
Grantentzug ohne weiteren Origin-Abruf. Eine gesonderte Prüfung erschöpft das
1.200er-Budget und bestätigt die Trennung der Sitzungen. Die Authority dieses
kurzen HTTP-Tests ist eine explizite synthetische Fixture, keine Live-OIDC-Abnahme.

Der neue reale Audio-/Szenen-Nachlauf besteht: alle drei Fälle in 115,350 s.
Der HLS-Zuschauer dekodiert nach Mute wieder die angeforderten 50/25-Prozent-Pegel
(RMS 0,0885/0,0444) bei fortlaufender Wiedergabe über die vorherige 28-Sekunden-
Abbruchstelle hinaus. Quellenwiderruf erzeugt wieder Stille. Beide Szenenfälle
prüfen ebenfalls echte dekodierte Bilder; der Zweiquellenfall erhält die zweite
Quelle über zwei Encoderwechsel. Diese lokalen synthetischen Quellen ersetzen
keine Produktions- oder Langzeitabnahme. Der anschließende gemeinsame Projektcheck
in der isolierten Kopie bestand mit Exit 0: 1.209 Frontendtests,
1.143 Node-/Browserfälle, null Fehler und vier Node-Skips (513,191 s), außerdem
Build, Typprüfung und Go-Unit/Vet. Beide Szenenfälle und der Audioausgang
bestanden erneut innerhalb dieser festen Gesamtprüfung. 14 externe Gates und
der Image-Scan wurden ausdrücklich übersprungen.

Die vorherige CI `34399249169` auf `529040f` scheiterte an
einem Zweiquellen-Szenentest, trotz bestandener Ananta-TURN- und Native-Jobs;
Docker und Live-Keycloak/TURN wurden übersprungen. Ein Zusammenhang dieses
CI-Fehlers mit dem jetzt reproduzierten Rateproblem ist noch nicht nachgewiesen.
Der separate Ananta-Bildschirmstillstand nach etwa 36 Minuten wird hiermit
ebenfalls nicht als behoben behauptet. Noch kein Rollout dieser Änderung.
