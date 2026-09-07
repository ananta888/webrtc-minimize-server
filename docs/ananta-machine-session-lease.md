# Ananta-Anbindung: Implementierungsrunde und Lease-Port

Meet-seitiger [Readiness-/Rollback-Runbook](machine-rollout.md): getrennte
Operator-Capability-Obergrenze und rein lesender Preflight. Ein lokaler PASS
erteilt keine produktive Hub-/Raumfreigabe. Der additive `.media`-Port trennt
synthetische Avatar-/Sprachausgabe vom Chat und der agenteneigenen Bildschirmquelle.
Die Maschinenroute wird bedarfsgeladen; normale Teilnehmer laden ihre speziellen
Controller-Ports nicht schon beim Öffnen des Raums.

Fortsetzung: Anantas Hub-/Worker-Adapter ist jetzt in der Implementierung
verdrahtet (`/home/krusty/ananta/docs/contracts/meet-dialog-runtime.md`).
`POST /api/machine/sessions/authorization` liefert nach einem frischen v2-Grant
die aktuelle Membership, Publisherfreigaben und echten Publikationsepochen an
den Hub. Weder Worker-Angaben noch Freigaberevisionen ersetzen diese Autorität.
Die Route transportiert ausschließlich Metadaten; sie verlängert keine Sitzung.

`window.anantaMachine.screen` besitzt jetzt `open/push/status/close` für eine
isolierte synthetische Quelle `screen:<verifizierte Hub-Session>`. Ein separater
Canvas-Adapter begrenzt 640×360/5 FPS, 256 KiB pro JPEG, einen ausstehenden Decode,
eine Sekunde Decode-Zeit und 30 Sekunden pro Aktivierung; bei fehlenden Frames
schließt er nach zwei Sekunden. Lease-/Membership-Wechsel verwerfen alte Frames.
Anantas derzeitige Quelle ist eine offline erzeugte eigene Task-Ansicht, kein
allgemeiner Browsersteuerungs- oder Desktopzugriff. Hub-gesteuertes Pause/Fortsetzen
und bewegte, beim menschlichen Gegenüber dekodierte CDP-Bilder sind lokal geprüft.
Freie Navigation und der Wechsel auf bestehende Browser-Worker bleiben offen.

Der Audio-Port liefert zusätzlich eine zufällige `subscriptionId`. Eine
korrelierte Antwort ist höchstens einmal nach vollständig aufgenommenem
Samplebudget und unter weiterhin gültiger Quell-/Sendefreigabe zulässig.
Hub-ASR-Tasklease, Hub-Dialoglease und Meet-Sitzungslease werden im Workeradapter
explizit unterschieden. Die gemeinsame Browser-/ASR-/TURN-Abnahme steht aus;
Capability-Probes bleiben bis zur tatsächlichen Abnahme konservativ.

Diese Erweiterung wird zusammen mit den folgenden MDS-Bausteinen implementiert.
Sie ist noch **nicht deployed**. Kurze Task-Tests laufen unmittelbar; die große
Browser-/Netzwerk-/Langzeitmatrix folgt gebündelt nach der Implementierungsrunde.

## Kompatibilität und Zuständigkeiten

Der bestehende Ed25519-Grant `ananta-meet-machine-v1` bleibt unverändert.
Jede Verlängerung benötigt einen frisch ausgestellten, einmal verwendbaren
Grant des bereits operatorseitig vertrauten Hubs. Ein Service-Bearer, alter
Grant oder Worker-Callback ersetzt diese Autorisierung nicht. Der Hub muss
seine aktuelle Task-/Projektpolicy **vor jeder neuen Signatur** prüfen.
Meets Server kontaktiert keinen frei vom Worker angegebenen Callback.

`GET /api/machine/capabilities` meldet unterstützte Versionen und getrennt
`admissionEnabled`. Keine Capability erteilt Raumrechte. Chat-Ereignisempfang,
Audio-Subscription und Bildschirm-Publikation werden bis zu ihrer tatsächlichen
Anbindung ausdrücklich als nicht verfügbar gemeldet.

## Sitzungsverlängerung ohne erneuten Raumbeitritt

Die bestehende Session-Antwort enthält zusätzlich `machineLease`:

```json
{
  "schema": "ananta.meet-session-lease.v1",
  "sessionId": "ms_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "generation": 1,
  "expiresAt": 1788700000000,
  "absoluteExpiresAt": 1788706000000
}
```

Die Zahlen und Kennung im Beispiel sind synthetisch. Die Session-ID ist kein
Bearer und keine Identität. Der isolierte Controller ruft
`window.anantaMachine.renew(freshGrant)` auf. Der Browser erzeugt einen neuen
nicht exportierbaren P-256-Nachweis und sendet `POST /api/machine/sessions/renew`:

- Grant ausschließlich im Authorization-Header, niemals URL oder WebSocket.
- Geschlossener Body: `roomId`, `sessionId`, `expectedGeneration`, `deviceProof`.
- Separater Signaturkontext `webrtc-machine-renew-v1`, danach Raum, Session-ID,
  erwartete Generation, Zeitstempel und Nonce, jeweils durch LF getrennt.
- Derselbe verifizierte Hub-Issuer, Subject, Tenant, Projekt, Task, Raum und
  Gerätefingerprint; kein Refresh zwischen verschiedenen Aufträgen.
- Aktuelle, noch nicht abgelaufene Membership und exakt nächste Generation.

Die Antwort besitzt dieselbe geschlossene Lease-Struktur. Ein erfolgreicher
Refresh erhält Peer-ID und PeerConnections. Jede einzelne Lease bleibt auf
höchstens zehn Minuten begrenzt, die gesamte Sitzung auf zwei Stunden und
512 Generationen. Eine unbenutzte Erstaufnahme verfällt nach 30 Sekunden.
Es gibt keine implizite Reconnect-, Restart- oder HA-Fortsetzung.

Die Registry löscht Autorität vor dem Socket-Stop. Ablauf, Leave und Verlust
der aktuellen Membership verhindern eine Wiederbelebung. Ein Socket, der den
Close-Handshake ignoriert, wird nach einer Sekunde terminiert. Gleichzeitige
Refreshs können nur einmal dieselbe Generation konsumieren. Der Browser
begrenzt den Refresh auf zehn Sekunden und stoppt lokal bei unbekanntem Ausgang,
Ablehnung oder Scopewechsel. Leave und verspätete Antworten sind gefencet.

Dieser v1-Lifecycle erweitert ausdrücklich **keine Empfangsrechte**. Separate
Receive-Scope, Publisherfreigabe und Schlüsselverteilung sind MDS-02/03/04,
nicht durch längere Anwesenheit oder ein neues Ablaufdatum ersetzt.

## Chat-Vertragsbasis

`src/machine-chat-contract.js` ist browserneutral und übernimmt
`ananta.meet-chat-event.draft1` aus Anantas Vertrag. Die unveränderten gemeinsamen
Beispiele liegen in `test/fixtures/ananta-meet-chat-admission.json`.
Parsing erteilt keine Autorität. Doppelte und escaped Feldnamen, ungültiges UTF-8,
unbekannte Felder, falsche Generationen und Text-/Bytegrenzen werden geprüft.

`MachineChatQueue` ist ausschließlich ein flüchtiger Port am verarbeitenden
Endpunkt, kein Chat-Ingress des Signaling-Servers. Er fordert bei Push, Poll
und ACK frische Autorität vom komponierenden Adapter: höchstens 32 Ereignisse,
128 KiB, acht Ereignisse pro Poll, 512 Dedup-Einträge. Erschöpfung schließt den
Port, statt still alte Ereignisse durch neue zu ersetzen. Nur bereits gelieferte
Cursor sind quittierbar; alte, eigene, Maschinen- und unbekannte Senderereignisse
lösen keine Hub-Weitergabe aus. Scopewechsel, Ablauf, Rechteentzug und rückläufige
Uhr leeren und schließen. Anantas Hub-Autoritätsadapter, korrelierte Antworten und
generationengebundener Receive-Lifecycle sind angeschlossen; spätere Antworten
dürfen weder eine alte Queue noch eine widerrufene Quelle wiederbeleben.

## Implementierter Draft-Empfangsport (lokale Integration, keine Produktionsabnahme)

Der isolierte Client besitzt jetzt `window.anantaMachine.chat` und `.audio`.
Die Capability-Probe bleibt für die noch nicht gemeinsam abgenommene
Dialog-/Audiointegration **false**. Der bestehende begrenzte v1-MP4-Publisher
bleibt getrennt; v1 erteilt keine Empfangsrechte. Maschinen benötigen Räume
mit `machineReceiveVersion=1` auf allen Browsern und erforderlichem SFrame.
Ein alter Browser kann damit nicht unbeabsichtigt einen KI-Empfänger beliefern.

Ein v2-Grant verwendet Audience `ananta-meet-machine-v2` und Typ
`ananta-meet-machine-v2+jwt`. Zusätzlich zu den geschlossenen v1-Claims bindet
er `runtimeId`, `sessionId` und eine explizite, eindeutige Capability-Liste.
`audio.receive`, `chat.read`, `chat.send`, `avatar.publish`, `speech.publish`,
`screen.publish` und `screen-audio.publish` sind getrennte Rechte; ein bekannter
Rechtename ist kein Beleg, dass der zugehörige Source-Adapter bereits existiert.
Der nachfolgende verifizierte HTTP-Kontext enthält keine Tokens oder Schlüssel.
Renewal darf Runtime, Hub-Session oder Rechte nicht verändern.

Unter **Analyse → Ananta · Freigaben meiner Quellen** kann jeder authentisierte
menschliche Publisher nur eigene laufende Audioquellen und eigene neue
Chatbeiträge für eine konkrete KI freigeben. Ein Raum-Ersteller darf das nicht
für andere Teilnehmer tun. Freigaben sind standardmäßig aus, höchstens zehn
Minuten gültig und jederzeit widerrufbar. Die Oberfläche unterscheidet eine
passende Serverbestätigung von Pending/Fehler und tatsächlicher Verarbeitung.
Das Öffnen der Ansicht fordert keinerlei Capture-Recht an.

Direct-Sender, SFrame-Key-Ausgabe/-Annahme und native SFU-Subscription-Pläne
prüfen den Receive-Scope. Entzug erzeugt neue Senderkeys und deaktivierte
SFU-Pläne mit neuer Revision; alte ACKs werden ungültig. Bereits berechtigt
entschlüsselte Inhalte lassen sich nicht rückwirkend zurückrufen. Kein
Signaling-/Blind-Agent erhält Inhalte oder neue Decrypt-Rechte.

### Chat

`chat.open()` nimmt keine vom Controller behauptete Scope entgegen. Die
Projektion stammt aus aktuellem verifiziertem HTTP-Kontext, Membership, Lease
und bestätigten Publisherrechten. Nur danach eintreffende neue Ereignisse
werden beobachtet, keine vorhandene Chat-Historie. `chat.poll()` liefert bis
zu acht Ereignisse mit Cursor, `chat.ack(cursor)` quittiert nur zuvor
gelieferte Einträge. `chat.reply(messageId, text)` erlaubt höchstens 450 Zeichen
und genau einen Sendeversuch zu einer bereits gelieferten, noch frischen Frage.
Der Rückgabewert `queuedPeers` belegt nur lokales Einreihen, keine bestätigte
Zustellung oder Darstellung. Nach einem teilweise fehlgeschlagenen Senden wird
keine zweite Antwort erzeugt.

Das additive DataChannel-Format v2 bindet `roomId`, `membershipEpoch`, zufällige
128-Bit-`messageId`, `replyTo`, `sentAt` und Text. Senderart und Peer-ID stammen
aus aktueller Membership und Verbindung, niemals dem Text oder JSON-Absender.
60 Ereignisse pro Minute/Peer, 30 Sekunden Frische und begrenztes Dedup gelten
vor Zustellung. Normale Human-Räume behalten v1-Chat; v1 erzeugt keine
maschinellen Events. Maschinen-/eigene Antworten starten keine KI-Schleife.
Scopewechsel oder Entzug leeren den Endpoint spätestens beim nächsten Zugriff
beziehungsweise nach 250 ms. Wiederöffnen spielt nichts nach.

### Audio

`audio.open(publicationId, seconds)` wählt genau eine aktuell freigegebene
Remote-Mikrofon- oder Bildschirmtonquelle. `audio.sources()` listet ausschließlich
gerade freigegebene, verfügbare Quell-IDs; der Aufruf startet keinen Graphen.
Die Laufzeit beträgt 1–10 Sekunden
Audio, höchstens 30 Sekunden einschließlich Abholen; Setup ist auf fünf
Sekunden begrenzt. Eigene KI-Ausgabe, unbekannte Quelle, stummgeschalteter oder
ersetzter Track und fehlende Rechte werden verworfen. Kein `getUserMedia`,
`getDisplayMedia`, Host-Capture oder ASR wird dadurch gestartet.

Der Browser resampelt den entschlüsselten MediaStream tatsächlich in einen
16-kHz-AudioContext. Abweichende Raten bleiben unsupported. Der eigene Worklet
liefert mono PCM16 little-endian: 1600 Samples / 3200 Bytes pro 100-ms-Paket,
ein unquittiertes Worklet-Paket und höchstens zehn gepufferte Pakete im Endpoint.
`audio.poll()` liefert bis zu fünf Pakete mit `sequence`, `startSample` und
`pcmBase64`. `audio.ack(sequence)` löscht quittierte PCM-Puffer. Der Base64-Pfad
bleibt lokal zwischen isoliertem Browser und seinem Controller, nicht HTTP
über Meets Server. Überlauf und Lücken stoppen statt Audio still zu überspringen.

Jeder Chunk, Poll und ACK prüft erneut Rechte und exakte Bindungen; zusätzlich
prüft ein 100-ms-Watchdog. Trackwechsel, Mute, Entzug, Leave, rückläufige Uhr
oder Lease-/Membership-/Policy-Wechsel stoppen den Graphen und leeren Puffer.
Ein alter asynchroner Callback kann keine neue Subscription beliefern.
Die per Source verwendete Kopie wird gestoppt, nicht die menschliche Aufnahme.

### Gemeinsame Ananta-Anbindung und verbleibende Abnahme

Anantas v2-Issuer, aktuelle Task-/Projekt-Autorität, TaskQueue-Dispatch und
HMAC-geschützter Worker-Rücktransport sind implementiert und im lokalen
repoübergreifenden Browsergate verbunden. Die dortige Projektpolicy und
Modellantwort sind ausdrücklich synthetisch, nicht produktive Freigaben.
`lease_id` in Meets Draft-Scope ist die **Meet-Session-Lease**, nicht Anantas
Hub-Dispatch-Lease. `receive_revision` ist **keine** `publication_epoch` des
Ananta-ASR-Vertrags. Der Adapter prüft beide Bindungen getrennt, einschließlich
des von Meet bestätigten Publikationsepochs.

Der separate CDP-Source-Adapter liefert bewegte Bilder der eigenen Offline-Ansicht
an einen tatsächlichen menschlichen Testempfänger. Getrennte Hub-Steuerung für
Chat, Audio und Bildschirm arbeitet mit CAS- und Quellrevisionen. Der direkte
Meet-Gate prüft außerdem 16.000 reale entschlüsselte PCM-Samples mit Nutzsignal,
korrelierte Chatantworten, drei Lease-Wechsel und Freigabeentzug. Ein privater
lautloser Audio-Sink hält die empfangene Trackkopie aktiv; er öffnet kein Mikrofon.

Echte CUDA-ASR-/LLM-Ausführung, maschinenspezifische SFU-/TURN-Pfade, vollständiger
Langzeitbetrieb und beliebige Browser-Worker-Navigation sind separat abzunehmen.
Keine dieser lokalen Prüfungen verändert produktiven Trust oder ersetzt die
Betreiberfreigabe. Wiederholte SFrame-KIDs dürfen weder Zähler noch Replay-Fenster
zurücksetzen; acht aktive Empfangsschlüssel und höchstens 512 bekannte KIDs pro
Kontext begrenzen den Überlappungspfad. Budgetüberschreitung stoppt fail-closed.

### Isolierte lokale TLS-Testanbindung

Der repoübergreifende Test benötigt keinen freien öffentlichen Host-Port 443.
`test/helpers/machine-tls-proxy.js` erzeugt pro Fixture einen eigenen internen
Docker-Netzbereich. Ein begrenzter Node-Container leitet darin ausschließlich
TLS-Bytes von seiner privaten Adresse auf den kurzlebigen Fixture-Server am
zugehörigen Bridge-Gateway weiter. Es gibt keine veröffentlichten Host-Ports,
Host-Netzwerkfreigabe oder Host-Dateimounts. Zertifikat und Identitäten bleiben
ephemere Testdaten; die produktive HTTPS-Origin-Policy wird nicht aufgeweicht.

`MEET_TEST_PROXY_IMAGE` wählt ein bereits lokal vorhandenes Node-fähiges Image
(Standard: `webrtc-ci-local-webrtc:latest`); vor dem Start wird es auf seine
lokale SHA-256-Image-ID aufgelöst. Dieses Image führt nur den opaken Proxy aus,
nicht den Meet-Anwendungsstand. Die tatsächlich getestete Meet-Anwendung kommt
weiterhin aus dem aktuellen Quellcode und dessen vorher erzeugtem `dist/`.
Container und Netzwerk werden ausschließlich unter dem eigenen zufälligen
Fixture-Namen entfernt. Der Proxy besitzt zusätzlich eine begrenzte Laufzeit.

Ein eigener Coturn-Container im selben internen Netz liefert ausschließlich
STUN-Adressbestimmung (`--stun-only`), keine TURN-Allokation. Ohne diesen lokalen
Dienst lieferte der interne Chromium-Container keine signalisierbaren ICE-
Kandidaten; mDNS allein verband Host und Container hier nicht. Der Gate benötigt
keinen externen STUN-Dienst und ändert weder mDNS-Privacy-Flags noch ICE-Policy in
Produktion. `MEET_TEST_STUN_IMAGE` ist standardmäßig `coturn/coturn:4.17.0` und wird
ebenfalls auf die lokale Image-ID aufgelöst. UID 65534, read-only Root, bounded
tmpfs/RAM/PIDs/CPU und ein harter Prozess-Timeout begrenzen den Dienst. Nur die
vom Image-Binary benötigte `NET_BIND_SERVICE`-Capability bleibt erhalten;
Host-Ports werden nicht veröffentlicht. Das beweist ausdrücklich keinen
öffentlichen TURN-/NAT-Pfad.

Anantas opt-in Test benötigt dessen optionales Python-Extra `meet-tests` und
ein bereits lokal gebautes Meet-Media-Worker-Image. Der Test startet daraus nur
einen eigenen sandboxed Chromium-Server im selben privaten Netzbereich, ohne
GPU oder Host-Mounts. Python-Client und Browser verwenden Playwright 1.58.0.
Dadurch ist weder ein Browserdownload auf dem Host noch eine Änderung seiner
AppArmor-/Namespace-Policy erforderlich. Das interne stdio-Ready-Protokoll
übergibt hierfür zusätzlich `test_network`; es ist keine produktive API.
Der Ananta-Test muss seinen Browser-Container vor dem Meet-Netzwerk entfernen.
Ein synthetischer Dialogtest ersetzt weder echte Modell-/GPU-Läufe noch
öffentliche TURN-Abnahme.
