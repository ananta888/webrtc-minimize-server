# Ananta: clientseitige Erneuerungsgrenze

Der Meet-Client muss bei einer Erneuerung die **alte** lokale Lease bis zur
Übernahme der Antwort als gültig beobachten. Eine erfolgreiche HTTP-Antwort
beweist die serverseitige Entscheidung, nicht ihre rechtzeitige Verarbeitung
im Browser. Hintergrundtabs oder ausgelastete Event-Loops können den lokalen
Ablauftimer verzögern.

## Umsetzung

Vor der Korrektur prüfte `RoomSessionService.renewMachine()` die alte Deadline
nur am Anfang. Sechs neue Service-Regressionen reproduzierten die unerlaubte
Übernahme nach Ablauf beziehungsweise Uhr-Rücksprung während Gerätenachweis,
HTTP oder JSON-Verarbeitung. Alle sechs scheiterten zunächst, während die
14 bestehenden Tests bestanden.

Eine kleine, nur beim ausdrücklichen Renewal geladene Transporteinheit prüft
nun vor dem Gerätenachweis, nach jeder asynchronen Grenze und direkt vor der
synchronen Übernahme:

- die unveränderte lokale Sitzung und den Raum;
- Abbruch, alte Deadline und nicht rückläufige beobachtete Entscheidungszeit;
- exakte Session-ID, folgende Generation, unverändertes Gesamtende und eine
  gültige neue Deadline nach dem geschlossenen Serververtrag.

Der Session-Service bleibt Eigentümer von Lease und Cleanup. Nach unklarem
Ausgang wird nur die noch zu dieser Operation gehörende Sitzung verlassen.
Eine inzwischen eingesetzte Ersatzsitzung wird nicht beendet. Das Laden des
Moduls läuft innerhalb desselben Zehn-Sekunden-Budgets; verspätetes Laden
erteilt keine neue Autorität. Das Initialbundlebudget wird nicht erhöht.

Dies ändert weder Hub-Verifikation, P-256-Nachweis, Quellenfreigaben noch
Reconnect-Policy. Nach einem abgelaufenen Renewal braucht der Worker einen
neuen autorisierten Lebenszyklus; die alte Antwort ist kein Wiederbeitritt.
Es ist kein nachgewiesener Fix für den separaten Langzeit-Bildschirmstillstand.

## Prüfgrenzen

Die gezielten Service-/Lifecycle-/Operation-/Expirytests bestehen nach der
Korrektur. Zusätzliche Tests prüfen einen Rücksprung gegenüber einer neueren
Zwischenbeobachtung und einen Raumwechsel während des Gerätenachweises.

Die echte Browserregression lässt zuerst den privaten TLS-Server den frischen
Ed25519-Grant und P-256-Nachweis akzeptieren. Nur im isolierten Maschinenbrowser
wird danach eine Verarbeitung an der alten Deadline simuliert. Die Antwort
muss trotz bestätigter neuer Servergeneration lokal abgelehnt werden;
Membership und PeerConnections müssen enden. Die Server-/Betriebssystemuhr,
produktive Berechtigungen und das Ananta-Repository bleiben unverändert.

Alle fünf echten Browserfälle bestanden in 38,507 Sekunden: beide aktiven
Audio-/Chat-/Screen-Dialoge mit jeweils vier Phasen à 16.000 PCM-Samples und
drei Renewals, beide neuen Verspätungsfälle (Chromium 1,321 s, Firefox 3,296 s)
und der bestehende hängende Gerätenachweis. Die Maschinen öffneten keinen
menschlichen Capture; bestätigte Freigaben wurden nicht verlängert.
60 gezielte Server-/Admission-/Trust-/Receive-Prüfungen bestanden ebenfalls.
Der isolierte Produktionsbuild bestand in 12,975 Sekunden mit unverändertem
1,60-MB-Hardlimit; die bestehende 1,50-MB-Warnung bleibt sichtbar.

## Gemeinsamer Prüfstand

Der isolierte `npm run check` auf `6e099b8` plus Clientkorrektur endete mit
**Exit 1**: 1.217 Frontendtests bestanden; 1.160 Node-/Browserfälle bestanden,
ein Fehler und vier explizite Node-Skips (519,650 Sekunden). Build, Typprüfung,
Go-Unit/Vet sowie statische Gates bestanden. Die externe Infrastrukturstufe
wurde nach dem Fehler nicht erreicht; der optionale Image-Scan war ausdrücklich
übersprungen. Beide aktiven Ananta-Dialoge, beide neuen Deadline-Browserfälle,
der hängende Gerätenachweis und beide nativen Szenenfälle bestanden.

Der einzige Fehler war die bewegte Avatarprüfung in
`test/machine-avatar.browser.e2e.test.js:80` unter Firefox, nach bereits
bestätigter Sitzungserneuerung. Ein **unveränderter gezielter Nachlauf** bestand
in 13,108 Sekunden mit allen drei Renewals, bewegtem Avatar, dekodiertem
Bildschirm und Sprachausgabe. Er reproduzierte den Fehler nicht und beweist
keinen Ursachenfix; der vorherige Gesamtcheck bleibt rot. Es wurde keine
zweite Gesamtsuite oder Zweistundenprüfung gestartet.

Prüfverzeichnis: `/tmp/webrtc-ananta-client-renewal.YUU041`, Protokolle
`check.log` und `avatar-followup.log`. Alle vier geänderten Source-/Testdateien
stimmen bytegenau mit dem Prüfkandidaten überein. Die separaten offenen nativen
Audio-Strategieänderungen sind nicht enthalten; der lokale Serving-Index blieb
unverändert. Keine öffentliche Aktivierung, neuer Rollout oder abgeschlossene
Langzeitabnahme wird behauptet.

## Audio-Cleanup nach einem Sitzungswechsel

Am 11. September 2026 wurde eine zusätzliche Grenze am Graph-Port geprüft:
`MachineAudioSessionService.finish()` schließt den Decoder asynchron. Lehnt
dieses Schließen erst nach `open()` einer Ersatzsitzung ab, darf der alte
Fehler deren Controller und PCM-Puffer nicht beenden. Dasselbe gilt nach einem
expliziten `close()`: Ein alter Cleanup darf den abgeschlossenen Status nicht
nachträglich überschreiben.

Zwei injizierte Graph-Port-Regressionen reproduzierten beide Verletzungen vor
der Korrektur. Der Cleanup-Fehler ist jetzt an den ursprünglichen Controller
gebunden. Gehört dieser weiterhin zur aktuellen Sitzung, bleibt der Fehler
fail-closed (`meet_audio_finish_failed`); eine Ersatzsitzung bleibt dagegen
offen und kann neue PCM-Chunks ab Sequenz eins quittieren. Die gemeinsame
Auswahl aus Audio-, Graph-, Lease-, Chat- und Session-Contract-Tests besteht
mit 63 Fällen. Typprüfung und Todo-Gate bestehen ebenfalls.

Diese Port-Härtung ist **kein nachgewiesener Fix** für den separaten
Chromium-Offenstatusfehler aus CI 34537434250: Die konkrete GraphFactory
fängt `AudioContext.close()`-Ablehnungen bereits selbst ab, und jener Browser-
Dialog verwendet kein `finish()`. Freigaben, Queue-Limits, Fristen, Capture
und die Erneuerungspolitik ändern sich nicht.

Der isolierte Produktionsbuild unter `/tmp/webrtc-audio-fencing.yockx8`
bestand in 9,817 Sekunden mit unverändertem Initial-Hardlimit und der
bestehenden 1,50-MB-Warnung. Die anschließende echte Chromium-/Firefox-
Erneuerungsregression bestand mit zwei Fällen in 19,168 Sekunden: je vier
Phasen mit 16.000 PCM-Samples, Chat, dekodiertem Bildschirm, drei Erneuerungen
und anschließendem Widerruf. Kein produktiver Capture und keine Änderung
am ausgelieferten lokalen `dist/`. Das ersetzt weder den gemeinsamen
CI-Gesamtcheck noch die offene Langzeit- und Produktionsabnahme.

Der aktive Dialogtest liefert bei fehlgeschlagenen Offenstatus-Assertionen
jetzt denselben begrenzten Snapshot von PCM-Zählern und Portstatus sowie
einen Audiofehler aus einer festen Sechserliste (`none`/`unknown` sonst).
Er liest den Audiostatus einmal; rohe Ausnahmen, Inhalte und Identitäten
werden nicht übernommen. Drei Node-Tests prüfen den exakt serialisierten
Callback einschließlich Secret-Canaries. Der anschließende Zweibrowserlauf
mit diesem Beobachter bestand ebenfalls (19,217 Sekunden). Erfolgsbedingungen,
Fristen und native Audiooperationen bleiben unverändert. Eine zukünftige
Fehlerbeobachtung muss die CI-Ursache erst noch eingrenzen.
