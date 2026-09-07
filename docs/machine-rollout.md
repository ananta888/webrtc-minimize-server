# Maschinenpfad: lokale Readiness und gestufter Rollback

Dieses Repository implementiert nur Meet. Hub-TaskQueue, GPU-/ASR-/LLM-Worker,
generische Browsersteuerung und deren Deployment gehören dem separaten Ananta-Team.
Keine Prüfung hier ändert dort Dateien, Trust, Projektpolicy oder Datenbanken.

## Readiness ist keine Autorisierung

`npm run machine:preflight -- /absoluter/pfad/plan.json` liest die bereits vom
Operator gesetzte Prozessumgebung. Optional kann Node sie ausdrücklich laden:
`node --env-file=.env scripts/machine-rollout-preflight.mjs /absoluter/pfad/plan.json`.
Die Datei enthält ausschließlich diese Felder (Werte sind synthetisch):

```json
{
  "schema": "ananta.meet-rollout-plan.v1",
  "meetRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "hubRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "publicOrigin": "https://meet.example.test",
  "hubIssuer": "https://hub.example.test",
  "hubKeySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "tenantId": "synthetic",
  "projectId": "synthetic",
  "roomId": "room-aaaaaaaaaaaaaaaaaa",
  "capabilities": ["chat.read", "chat.send"]
}
```

Der Pin ist SHA-256 über das DER-SPKI des **öffentlichen Ed25519-Schlüssels**,
nicht über die PEM-Datei und nicht über einen privaten Schlüssel. Revisionen
sind vollständige Commit-IDs. Der Plan erlaubt weder Teilnahme noch Empfang;
Raum-/Projektangaben sind Erwartungen, keine Nachweise. Nicht öffentlich ablegen.

Die Prüfung vergleicht die lokale Meet-Revision, einen sauberen Arbeitsbaum,
HTTPS-Origin, erforderliches Human-OIDC/SFrame, exakten Hub-Issuer, Key-Pin und
Capability-Obergrenze. Es gibt keine Netzwerkaufrufe, Grants oder Logausgabe
von IDs, URLs, Token oder Schlüsseln. Eingaben sind auf 8 KiB begrenzt.
Exit 0 / `local_ready` bestätigt **nur diese lokalen Bedingungen**; Exit 2
meldet `blocked`. `productionReady` bleibt ausdrücklich `false`.

Separat erforderlich und nicht durch Planfelder ersetzbar:

- tatsächlich passende Hub-Revision und gemeinsame Contract-/Browser-Evidence,
- frische Hub-Task-/Projektpolicy bei jedem signierten Grant,
- aktuelle Meet-Membership und eigene Publisherfreigaben,
- reale Browser-/Agent-/TURN-/Langzeitabnahme,
- explizite Betreiberentscheidung für die jeweilige Rollout-Stufe.

## Expliziter Trust und Capability-Obergrenze

Ohne Hub-Key und Issuer bleibt Maschinenaufnahme deaktiviert. Der optionale
Compose-Override `infra/deployment/compose.machine.yaml` mountet ausschließlich
den Public Key als read-only Secret. Er wird **nicht automatisch eingebunden**.
Sein Standard erlaubt nur die Chat-Rechtenamen. Private Hub-Schlüssel dürfen
niemals auf Meet oder Worker kopiert werden.

`MACHINE_ALLOWED_CAPABILITIES` ist eine geschlossene, kommaseparierte
Operator-Obergrenze. Leerer Wert bedeutet **keine Maschinenaufnahme**. Duplikate,
unbekannte Namen und Syntaxfehler verhindern den Start. Ohne gesetzte Variable
bleibt der bisherige serverseitige Capability-Umfang kompatibel; das aktiviert
ohne Trust weiterhin nichts. Der optionale Compose-Override schränkt ihn explizit ein.

Die Obergrenze wird bei Join, Renewal und Hub-Autorisierungsabfrage geprüft.
Ein signierter Grant mit einem gesperrten Recht wird insgesamt abgelehnt, nicht
still umgeschrieben. Der unveränderte v1-Grant benötigt weiterhin alle drei
Rechte `avatar.publish,chat.send,speech.publish` und ist kein Chat-only-Grant.

## Stufen und Stop

1. **Chat:** exakt `chat.read,chat.send`, separate eigene Chatfreigabe im Raum.
2. **Audioempfang:** zusätzlich `audio.receive`, explizite eigene laufende
   Mikrofon-/Bildschirmtonfreigabe. Das gewährt weder Recording noch Modellprovider.
3. **Eigene Quelle:** zusätzlich `screen.publish`; die Quelle bleibt ein
   gebundener synthetischer Canvas. `screen-audio.publish` benötigt ein eigenes
   Recht und einen eigenen Start; der neue PCM-Adapter bleibt ohne vollständige
   Browser-/Netzwerkabnahme experimentell und wird nicht implizit mitgewährt.
4. **Avatar/Sprache:** benötigte Rechte `avatar.publish` und/oder `speech.publish`
   einzeln hinzufügen. Der additive lokale `.media`-Port benötigt keinen Chattext.

Sofortiger lokaler Stop erfolgt über `.chat.close()`, `.audio.close()`,
`.screen.close()`, `.screenAudio.close()` oder `.media.close()`. `leave()` beendet alle Ports.
Publisher können ihre eigenen Empfangsfreigaben in Analyse sofort widerrufen;
künftige Schlüssel und SFU-Subscriptions werden entsprechend entzogen.
Bereits beim berechtigten KI-Endpunkt entschlüsselte Inhalte sind nicht rückrufbar.

Der Operator kann beim nächsten kontrollierten Prozessstart einzelne Rechte
aus der Obergrenze entfernen oder einen leeren Wert setzen. Das ist **kein
Hot-Reload**: Ein Neustart beendet alle flüchtigen Sessions einschließlich
menschlicher Räume; Wartungs-/Rollbackfenster berücksichtigen. Eine Dateiänderung
allein widerruft keine laufende Sitzung. Ein kompletter Trust-Rollback entfernt
beide Trust-Werte und den optionalen Compose-Override beim kontrollierten Restart.
Hub-seitiges Stoppen/Verweigern neuer Grants bleibt dessen eigene Zuständigkeit.

## Eigenständige Medienquelle

`window.anantaMachine.media.publish({schema: "ananta.meet-media-source.v1",
sourceId: "media:" + hubSessionId, outputs: ["speech"], mp4Base64})` ist ein
additiver v2-Port für einen bereits synthetisch erzeugten MP4-Clip. Alternativ
`["avatar"]` oder `["avatar", "speech"]`. Keine menschlichen Capture-APIs,
keine Chatpublikation, kein URI-/Dateisystem-/Browserprofilzugriff.

Grenzen: ein Writer, 4.700.000 Base64-Zeichen, 1280×720, 40 Sekunden Medium,
20 Sekunden je Lade-/Transportphase und 45 Sekunden Wiedergabebudget. Nur
ausgewählte Tracks werden veröffentlicht; übrige werden gestoppt. Unbekannte
Felder, falsche Quellbindung, fehlende Rechte, Codec-/Decodefehler und ausstehende
E2EE-Bereitschaft brechen ab. Lease-Generation, Entzug und Uhrenrücksprung werden
alle 50 ms geprüft; ein alter asynchroner Abschluss kann keinen neuen Writer stoppen.
Das ist ein begrenzter Clip-Adapter, kein gapless Streaming- oder GPU-Nachweis.
Der Clip-Adapter reserviert dieselben Kamera-/Mikrofon-Slots wie die separaten
`.avatar`-/`.speech`-Ports. Überlappende Writer werden vor dem Laden abgewiesen;
Sprachclips können neben einem unabhängigen Avatar laufen. Cleanup gibt nur
eigene Slots frei, auch bei Fehlern oder verspäteten Abschlüssen.
Der Legacy-Aufruf `publish(text, mp4Base64)` verwendet denselben Lifecycle und
publiziert weiterhin Avatar, Sprache und Text zusammen.

Die Browser-Capability-Probe bleibt bis zur vollständigen Integrationsabnahme
konservativ. Implementierte Draft-Ports dürfen nicht allein aufgrund ihrer Existenz
als freigegebene Produktionsfähigkeiten beworben werden.

### Agenteneigener Bildschirmton

Der separate lokale Port `.screenAudio.open("screen-audio:" + hubSessionId)`
benötigt `screen-audio.publish` und eine bereits laufende eigene Bildschirmquelle.
Die Antwort nennt `generation`, Format `pcm_s16le`, 48.000 Hz, mono, 4.800 Samples
je Chunk und das Ablaufdatum. `.screenAudio.push(generation, sequence, pcmBase64)`
nimmt genau 9.600 PCM-Bytes / 100 ms, ab Sequenz 1 lückenlos, höchstens 300 Chunks.
Er erzeugt ausschließlich synthetisches Audio in einem eigenen MediaStream-Ziel;
es besteht keine Verbindung zu Lautsprechern, Mikrofon oder fremden Quellen.

Die WebAudio-Queue ist auf maximal fünf Buffer und 400 ms Vorlauf begrenzt;
Überlauf, Decoder-/Graphfehler, über 200 ms Scheduling-Lücke, fehlende Chunks
für eine Sekunde, Bildschirmwechsel/-ende und Lease-/Membership-Wechsel stoppen.
PCM-Kopien werden nach Übergabe beziehungsweise Buffer-Ende und Stop geleert.
`.screenAudio.close()` lässt das Bildschirmvideo bestehen; `.screen.close()`
stoppt zusätzlich dessen Quellton. Bildschirmton startet niemals automatisch
zusammen mit einer Bildschirmfreigabe. Der Ananta-Worker muss diesen additiven
Port selbst explizit anbinden; diese Änderung nimmt ihm keine Policy-Entscheidung ab.

## Begrenzter lokaler Screen-/Lease-Dauertest

`MACHINE_SOAK_SECONDS=300 npm run test:machine:soak` startet einen fünfminütigen
isolierten TLS-/Direct-ICE-Lauf mit synthetisch signierten Testidentitäten, ohne
Produktions-Secrets, Ananta-Zugriff oder Capture. Er prüft tatsächliche dekodierte
Frames **und wechselnde gerenderte Quellpixel**, mehrere Bildschirmaktivierungen,
frische Lease-Erneuerungen, 15-Sekunden-Freeze-Grenze und JS-Heap-Budgets
(absolut 256 MiB, Wachstum höchstens 160 MiB). Stop/Cleanup bleibt separat geprüft.
Konfigurierbar sind 300–7200 Sekunden; ohne Auswahl wird sichtbar übersprungen.
Bei zwei Stunden muss das ursprüngliche harte Sessionende erhalten bleiben,
statt eine zweite Membership zur verdeckten Verlängerung zu erzeugen.

Die Ausgabe benennt ausdrücklich `screen-only`: kein Beleg für GPU, echte
Hub-Policy, Audio-/Chat-Dauerbetrieb, SFU oder TURN. Der Test ersetzt daher nicht
die vollständige MDS-08-Integrationsmatrix. Ein kurzer Erfolg schließt keinen
zweistündigen oder netzübergreifenden Akzeptanzpunkt.

Frame-/PCM-Abstände und relative MP4-Wartebudgets verwenden eine monotone Uhr.
`screen.diagnostics()` liefert versionierte, inhaltsfreie Stop-Kategorien;
die bestehende Form von `screen.status()` bleibt unverändert.
Absolute Grant-/Lease-/Aktivierungsabläufe und der Stop bei rückläufiger Wanduhr
bleiben davon getrennt. Im lokalen Fehlerlauf betrug ein beobachteter Abstand
239 ms monoton, aber 2914 ms auf der Wanduhr; der alte Frame-Watchdog wertete das
fälschlich als zweisekündige Lieferpause. Regressionstests simulieren solche
Vorwärtssprünge bei weiterlaufenden Frames/PCM und prüfen weiterhin echten Stall,
Scopewechsel und absoluten Ablauf. Statistikmessungen laufen zudem getrennt vom
Producer mit höchstens einer ausstehenden, zeitlich begrenzten Abfrage.

### Wiederholtes Starten ohne wachsende SDP

Der Direct-Peer-Pfad verwendet eigene freie Sender-/Transceiver-Slots desselben
Medientyps wieder. Jeder neue Writer erhält vor `replaceTrack` seinen aktuellen
SFrame-Kontext; ausstehende Ersetzungen bleiben bis zum Abschluss reserviert.
Widerruf und ein verspäteter Abschluss dürfen keine neue Quelle überschreiben.
Die vorhandene SDP-Größengrenze von 80.000 Zeichen bleibt unverändert.

`node --test test/machine-source-churn.browser.e2e.test.js` prüft jeweils
18 autorisierte Bildschirmstarts gegen Chromium und Firefox mit tatsächlich
wechselnden Remote-Pixeln, einem einzigen Sender-Transceiver, stabiler
Signalisierung und einer SDP unter 12.000 Zeichen. Wiederholte `ontrack`-Ereignisse
desselben bereits zugeordneten Tracks bleiben idempotent: Die ursprüngliche native
Track-ID eines wiederverwendeten Receivers darf keine zweite Publikation und
keinen falschen Entschlüsselungskontext erzeugen. Der Test löst dieses Ereignis
gezielt aus und verlangt weiterhin genau eine Remote-Kachel.
Im reproduzierten Fehlerfall
vor der Wiederverwendung überschritt bereits der 14. Start die SDP-Grenze.
Dieser Kurztest ersetzt keine Netz-/SFU- oder Langzeitabnahme.

Lokale Verifikation vom 7. September 2026: Gesamtcheck bestanden (527 Frontend-,
456 Node-Tests, zwei optionale Node-Skips; externe Infrastruktur-Gates sichtbar
übersprungen). Der separate 300-Sekunden-Screen-Lauf bestand mit 1.274 gelieferten
Quellframes, vier Lease-Erneuerungen, 15 Aktivierungen, wechselnden Remote-Pixeln
und maximal 12 MiB gemessenem JS-Heap. Das ist keine zweistündige Dialog-,
SFU-/TURN-, GPU- oder Produktionsabnahme.
