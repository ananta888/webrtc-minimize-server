# TURN-Dialog: ausgewählten Transport statt einzelnes Checklistenlabel prüfen

Am 9. September 2026 scheiterte der Chromium-TURN/TCP-Dialog von `89cec3a`
in CI `34321653965` und zweimal lokal vor der PCM-Abnahme. Die begrenzte
Fehlerdiagnose zeigte beidseitig ICE/DTLS/SCTP und PeerConnection `connected`,
Signaling `stable` sowie 40.464 / 7.233 übertragene Bytes. Der ausgewählte
Candidate-Pair-Statistikwert war dennoch `in-progress`. Der Beobachter verwarf
jedes Paar ohne `state === succeeded` und lief in seine unveränderte Frist.

Die W3C-Statistikspezifikation beschreibt die
[Transportreferenz `selectedCandidatePairId`](https://www.w3.org/TR/webrtc-stats/#dom-rtctransportstats-selectedcandidatepairid)
getrennt vom [Checklistenstatus des Kandidatenpaares](https://www.w3.org/TR/webrtc-stats/#dom-rtcicecandidatepairstats-state).
Die konkrete Kombination oben ist eine gemessene Chromium-Beobachtung, keine
Behauptung, dass jedes `in-progress`-Paar brauchbar oder standardkonform ist.

Der reine Testbeobachter akzeptiert diesen Zustand nur, wenn alle zusätzlichen
Bedingungen gleichzeitig gelten:

- Die verbundene PeerConnection hat ICE `connected` oder `completed`.
- SCTP und dessen DTLS-Transport sind verbunden.
- Ein verbundener Transportstatistik-Eintrag referenziert genau dieses Paar.
- Das Paar hat endliche, positive Payload-Bytezähler in beiden Richtungen.

`failed`, `waiting`, `frozen`, unbekannte Zustände, bloße Nominierung, ein
anderes ausgewähltes Paar oder unvollständige Transporte genügen nicht. Der
bisherige Fallback ohne Transportreferenz verlangt weiterhin `succeeded`.
Zusätzlich muss der lokale Kandidat tatsächlich Relay sein, die konfigurierte
Relay-Policy erhalten bleiben und das Protokoll zum isolierten TURN-Listener
passen. Vorher-/Nachhermessungen verlangen weiter steigende Bytezähler.

Der eigentliche Dialog muss weiterhin 16.000 entschlüsselte PCM-Samples mit
Nutzsignal, Chatantwort, bewegten Bildschirm, drei Renewals und Entzug belegen.
Weder 1.500-ms-/25-s-Messbudgets noch Medienfristen, Consent, SFrame oder TURN
wurden gelockert. Keine Browser- oder Produktions-Medienlogik wurde geändert.
Phasenmarkierte Fehlerdiagnosen enthalten nur begrenzte Zustände/Zähler und
Medienarten, keine SDP-/ICE-Adressen, Namen, Inhalte, Schlüssel oder Tokens.

Der synthetische Statistik-Repro scheiterte vor der Korrektur. Danach bestanden
zwei neue Statistiktests und sieben bestehende TURN-Fixture-Prüfungen. Die
wirklichen TCP-/UDP-Dialoge und der gemeinsame Check werden getrennt erfasst;
ein lokaler Erfolg ersetzt weder den zuvor fehlgeschlagenen CI-Lauf noch eine
öffentliche NAT-/Mobilfunk-/Langzeitabnahme.

Die korrigierten realen Dialoge bestanden anschließend ohne Wiederholung ihrer
Fachaktionen: TCP zweimal in insgesamt 42,377 Sekunden, UDP zweimal in
39,009 Sekunden. Jeweils wurden steigende Datenzähler, der richtige isolierte
Listener, 16.000 entschlüsselte Samples, Chat, Screen, drei Renewals und Entzug
geprüft; SFrame war aktiv, Transformfehler wurden nicht beobachtet.

Der parallel gestartete gemeinsame Check mit der separaten Native-Capability-
Erweiterung bestand 905 Frontend- und 920 Nodeprüfungen, endete aber mit einem
Fehler und zwei Node-Skips (430,609 s). Chromium meldete beim Seitenaufbau des
Screen-Decoder-Falls `test_navigation_network_changed`, bevor dessen
Quellenprüfungen begannen. Die Ursache dieses Navigationfehlers ist nicht
abschließend belegt. Die beiden neuen Statistiktests wurden nach der initialen
Node-Dateisuche ergänzt und gehören zur separaten Neun-Test-Verifikation,
nicht zu diesen 920 Pässen. Der Gesamtcheck wird nicht als bestanden ausgewiesen.

Nach dessen terminalem Ende bestand der unveränderte Screen-Decoder-Test gegen
denselben Build in beiden Browsern (zusammen 5,301 s). Keine Navigations- oder
Decodergrenze wurde dafür geändert. Das ist ein gezielter Folgebefund, kein
Nachweis für die Ursache des früheren Netzwerkfehlers oder ein Release-PASS.
