# WebRTC Minimize Server

[![CI](https://github.com/ananta888/webrtc-minimize-server/actions/workflows/ci.yml/badge.svg)](https://github.com/ananta888/webrtc-minimize-server/actions/workflows/ci.yml)

Ein eigenständiger, Keycloak-fähiger Raumserver mit Angular-Oberfläche für Audio, Video, Bildschirmfreigabe, Peer-Chat und freiwillige lokale Vosk-Untertitel. Der Node-Server autorisiert Membership, Topologie und SDP/ICE, terminiert aber keine Medien oder Untertitel. Jede PeerConnection versucht zuerst einen direkten Pfad, danach freiwillige Edge-TURN-Knoten und erst zuletzt Infrastruktur-TURN. Audio-, Kamera- und Bildschirmframes sind im Standardmodus zusätzlich mit RFC-9605-SFrame Ende-zu-Ende verschlüsselt. Das ausgehandelte Medienprotokoll v2 verwendet den codec-bewussten Envelope `codec-prefix-v1`: Bei VP8 bleiben ausschließlich die für den Browser-Packetizer erforderlichen 10 Keyframe- beziehungsweise 3 Deltaframe-Bytes sichtbar, bei Opus das TOC-Byte; diese Bytes und die Envelope-Version sind AES-GCM-authentisiert, der restliche Frame ist verschlüsselt.

Die [aktuelle Architektur als UML-/Datenflussmodell](docs/current-architecture-uml.md) zeigt den vollständigen Direct-, TURN-, Single-/Multi-Media-Agent-, Consent-, Failover- und Bandbreitenpfad mit konkreten Teilnehmerbeispielen.

Die [verifizierte Broadcast-Ausgangsbasis](docs/broadcast-baseline-inventory.md) hält zusätzlich Trust-, Port-, Browser-, Ressourcen- und Deploymentgrenzen vor dem ersten Packager fest. MediaMTX, WHIP, LL-HLS, MoQ und ein Zuschauer-Player sind darin ausdrücklich noch nicht als vorhandene Produktfähigkeiten ausgewiesen.

Die angenommene [Plane-ADR](docs/adr/0001-separated-interactive-broadcast-delivery-planes.md) trennt Control Plane, interaktiven SFrame-Raum, Own-Source-/Trusted-Program-Packager, Media-Gateway, Delivery-Provider und Viewer. Sie beschreibt insbesondere die Klartextgrenzen und hält Zuschauer vollständig außerhalb von Membership, Peer-Liste, 20er-Grenze und Mesh.

Das verbindliche [Broadcast-Threat-Model](docs/broadcast-threat-model.md) trennt ehrliche SFrame-, Trusted-Program-, Transport-, private und öffentliche Security Claims. Es ordnet kompromittierte Packager/Gateways/Provider, Replay, das Erraten von Pfaden, Hotlinking, DoS, Metadaten, Retention und ungewolltes Recording konkreten fail-closed Negativtests zu.

Die [versionierte Broadcast-Capability-Matrix](docs/broadcast-capability-matrix.md) trennt Upstream-Unterstützung von real geprüfter Produktreife. Sie pinnt Standards, Browser-/Mobilgrenzen, Player, Codecs und MediaMTX-/Cloudflare-/Native-Adapter; die geschlossene [JSON-Inventur](docs/broadcast-capability-matrix.v1.json) verhindert insbesondere falsche WHIP→LL-HLS-, Remux→Transcode- oder MoQ-Draft-Behauptungen.

Die [MoQ-Vertrags- und Negotiation-Grenze](docs/moq-contracts-and-negotiation.md) pinnt MOQT draft-20, LOC draft-04 und WebTransport RFC 9297, begrenzt Catalog/Object/Subscription und fällt bei jedem bekannten Draft-Mismatch scopegleich auf LL-HLS/HLS zurück. Der echte MoQ-Transport bleibt bis zu Browser-, Gateway- und QUIC-Gates deaktiviert.

Die [austauschbare MoQ-Adaptergrenze](docs/moq-adapter-boundary.md) hält MediaMTX und Cloudflare als getrennte, derzeit draft-inkompatible Adapter default-aus. Eine serverseitige Host-/Path-Allowlist und Credential-Grenze erzwingt Tenant, Environment, Ablauf, Quoten, Rotation, Kill-Switch und inhaltsfreies Audit.

Der [experimentelle MoQ-Player-Orchestrator](docs/moq-player-fallback.md) prüft vor einer QUIC-Session Scope, Drafts, Playback-Autorisierung, Secure Context, WebTransport und Codec. Fehler wechseln höchstens einmal und erst nach vollständigem MoQ-Cleanup auf HLS; der echte Browser-/Providerpfad bleibt mangels kompatiblem Draft-20-Adapter deaktiviert.

Die [Secure-Objects-ADR](docs/adr/0002-moq-secure-objects-experimental.md) vergleicht den objektverschlüsselten Broadcast mit Raum-SFrame und hält Key Distribution, Metadaten, Cache, ABR, Rotation, Late Join und Revocation getrennt. Ein default-off AES-GCM/HKDF-Prototyp belegt Blind-Relay und Manipulationserkennung lokal, ist aber ausdrücklich weder vollständige Draft- noch Produktionsimplementierung.

Die [Broadcast-Contracts v1](contracts/broadcast/README.md) definieren 13 geschlossene, herstellerneutrale Metadatenfamilien samt Fixtures und serverseitiger Scope-/Epoch-/Ablauf-/Transition-Grenze. Sie enthalten bewusst weder Medien noch Tokens, Secrets, SDP/ICE oder Caption-Text und sind noch an keinen produktiven Broadcast-Endpunkt angebunden.

Die reine [Broadcast-State-Machine](docs/broadcast-state-machine.md) ergänzt idempotente Create-/Start-/Quellenwechsel-/Handoff-/Revoke-/Stop-/Retry-Kommandos, fünf unabhängige Epochen sowie ablaufendes Packager-/Gateway-Fencing. Sie erzeugt nur Control-Plane-Effekte und ist weiterhin nicht an einen produktiven Medienpfad angeschlossen.

Die [Broadcast-Grant-Grenze](docs/broadcast-grants.md) prüft OIDC-Attestation, aktuelle Membership/Rolle, einen frischen raum- und aktionsgebundenen P-256-Gerätebeweis, Trusted-Packager-Consent, Viewer-Policy und Quoten, bevor sie kurzlebige ES256-Publisher-, Packager- oder Playback-Grants ausstellt. Grants sind eng an Programmrevision/Epoch, Audience, Gerät, Ressource und Pfad gebunden, serverseitig sofort widerrufbar und ausschließlich für `Authorization`-Header vorgesehen. Auch diese Domain-Schicht ist noch nicht an einen öffentlichen Broadcast-Endpunkt angebunden.

Die [Broadcast-Audience-Policy](docs/broadcast-audience-policy.md) ergänzt getrennte Sichtbarkeiten `private`, `unlisted` und `public`, eine serverseitige Owner-/Moderator-/Presenter-/Packager-/Viewer-Aktionsmatrix sowie atomare Policy-/Program-Epoch-Wechsel. Das öffentliche Broadcast-Verzeichnis gibt nur minimale freigegebene Programmdaten aus; private Fehler bleiben generisch und zeitlich gepolstert. Eine Viewerentscheidung ist ausschließlich playback-berechtigt und erzeugt ausdrücklich keine Room-Membership oder interaktiven Rechte.

Das [Browser-Broadcast-Modul](docs/browser-broadcast-module.md) trennt Program-State, Consent, Source-Auswahl, Capture-Fork, Composition, Publication, Delivery-Capabilities, Playback und Stats in kleine Angular-Ports. Der sichtbare [Own-Source-Preflight](docs/broadcast-own-source-preflight.md) kann inzwischen ausschließlich bereits aktivierte eigene Originaltracks vor SFrame revisionsgebunden für eine lokale Vorschau klonen; er zeigt Pegel, Publikum, Caption-/Codecstatus, Uploadschätzung und die Klartext-Trust-Grenze. Panel, Deep Link und Source-Auswahl starten keine Aufnahme, und Preview-Stop, Sessionwechsel, Leave, Logout, `pagehide` sowie Destroy räumen Klone und AudioNodes auf, ohne die Raumfreigabe zu stoppen. Der getrennte [Browser-WHIP-Publisher](docs/browser-whip-publisher.md) implementiert inzwischen den begrenzten RFC-9725-Transport und ist real gegen MediaMTX 1.20.1 in Chromium und Firefox geprüft. Die öffentliche Grant-/UI-Anbindung, Gateway-Ausgabe und Zuschauer-Playback sind noch nicht aktiviert.

Die [WHIP-Quellen- und Sendersteuerung](docs/whip-source-switching-adaptation.md) hält Media-Sections über eine Session fest, verwendet bei kompatiblen Kamera-/Bildschirm-/Slate- oder Audioersetzungen `replaceTrack` und startet bei geänderter Audio-/Video-Struktur kontrolliert eine neue WHIP-Resource. Getrennte Audio-/Video-Obergrenzen, Content-Hints, Prioritäten und optionales Kamera-Simulcast werden capability-geprüft; eine Stats-Adaption mit Hysterese und Cooldown reagiert auf Verlust, RTT, Encoderlast, Upload-Headroom und ausbleibende Frames, ohne die SFrame-Raumqualität zu verändern.

Der [Trusted-Decrypt-Consent](docs/trusted-decrypt-consent.md) bindet eine Freigabe an genau eine Quelle, Medienart, Room-/Program-Epoch, einen Zweck sowie einen konkreten Packager und dessen registriertes Gerät. SFrame-Basisschlüssel werden über nicht exportierbares P-256-ECDH und AES-GCM zusätzlich zielgebunden verpackt, nur flüchtig in den Packager-Worker installiert und bei Widerruf, Ablauf, Handoff, Epochwechsel, Leave oder Destroy entfernt. Die sichtbare Einzelquellen-Zustimmung und serverseitige Autoritätsgrenze sind vorhanden; die öffentliche Program-Orchestrierung bleibt bis zu den späteren Integrations-Tracks deaktiviert.

Der [Trusted-Audio-Programmbus](docs/trusted-audio-program-bus.md) mischt ausschließlich consent-gebundene Audio-Forks in einen getrennten, limitierten Ausgang. Sprache, ausgewogene Wiedergabe und Musik/Bildschirmton besitzen begrenzte Opus-/AAC-Ziele, Kanäle, DTX/FEC-Anforderungen, Gain und Ducking. Raumwiedergabe und Talkback haben keinen Rückweg in den Mix; lokales Monitoring ist standardmäßig aus und nur als ausdrücklich gewählte Kopfhörerfunktion verfügbar.

Der [Trusted-Video-Compositor](docs/trusted-video-compositor.md) erzeugt aus consentierten Kamera- und Bildschirm-Klonen ein festes Programmbild mit sieben Layouts, vier Auflösungs-/FPS-Profilen, neutralen Slates und standardmäßig deaktivierten Metadaten-Overlays. Die interaktive Raumdarstellung bleibt davon getrennt.

Die [Native-Packager-Basis](docs/native-packager.md) validiert kurzlebige,
owner-/tenant-/raumgebundene Capability-Reports, wendet CPU-/Upload-/Energie-
Admission an und erzeugt eine begrenzte H.264/AAC-ABR-Leiter über eine
shell-freie FFmpeg-Pipeline. Installation und Control-Plane-Anbindung bleiben
noch offen und werden nicht als einsatzbereit dargestellt.

Der [MediaMTX-Gateway-Adapter](docs/mediamtx-gateway-adapter.md) stellt ein getrenntes, opt-in lokales Integrationsprofil bereit. MediaMTX 1.20.1 ist per OCI-Digest fixiert; nur WHIP, LL-HLS, interne API/Metrics und ICE sind aktiv. Der Container besitzt kein Recording, läuft read-only und veröffentlicht seine Medienports ausschließlich auf Loopback. Das Profil ist keine öffentliche Produktionsfreigabe.

Die [Codec- und Capacity-Policy](docs/broadcast-codec-admission.md) definiert
das H.264/AAC-720p-Pilotprofil, trennt Browser-Single-/Simulcast-, Gateway-
Passthrough- und Native-ABR-Pfade und reserviert CPU, Speicher, Encoder/GPU und
Egress vor einem Packager-Start.

Der [Broadcast-Player](docs/broadcast-player.md) wählt natives HLS oder das
gepinnte hls.js capability-gesteuert, begrenzt Stall-Recovery und räumt bei
Stop, Navigation und Sichtbarkeitswechsel vollständig auf. Er bleibt bis zur
privaten Delivery-Autorisierung vom öffentlichen Gateway getrennt.

Die [private Broadcast-Auslieferung](docs/broadcast-private-delivery.md)
tauscht Playback-Grants gegen pfadgebundene Secure-/HttpOnly-Cookies, prüft
Manifest und jedes Medienobjekt erneut und proxyfiziert nur zu einer festen
internen Gateway-Origin. Die Runtime-Aktivierung bleibt bis zur
Program-Orchestrierung default-aus.

Die [Origin-/CDN-Profile](docs/broadcast-delivery-profiles.md) halten den ersten
reproduzierbaren 20-Viewer-LL-HLS-Lastwert fest und verweigern jede ungemessene
Hochrechnung. CDN bleibt bis zu Origin-Auth-, Purge-, Shielding- und
Providergates unavailable.

Die [Broadcast-Budgets und SLOs](docs/broadcast-budgets-and-slos.md) begrenzen
Viewer, Egress, Encoder, Dauer und Kosten pro Deployment, Tenant und Principal,
ohne eine globale Raumanzahl einzuführen. Viewerzählung bleibt kurzlebig und
kommt ohne IP- oder Gerätefingerprinting aus.

Die Hauptnavigation enthält außerdem eine [raumgebundene Mesh-Analyse](docs/mesh-analysis.md). Ihr interaktiver SVG-Graph zeigt Browser, Trusted Relays und native Media-Agenten sowie lokal gemessene beziehungsweise klar als Peer-Angabe markierte Kantenraten. Ein ausgewählter Knoten schlüsselt Upload und Download nach Audio, Kamera/Video, Bildschirmfreigabe und DataChannel auf. Direkt darunter liegen Inventar, Installation, Widerruf, Mehrfachauswahl, Raum-Consent und aktueller Routenzustand der eigenen Media-Agenten; der allgemeine Einstellungsbereich dupliziert diese Bedienung nicht. Die Telemetrie ist flüchtig, nur bei sichtbar geöffneter Analyse angefordert und niemals Membership- oder Routing-Autorität.

## Lokal starten

Voraussetzung: Node.js 22.5 oder neuer (für den eingebauten SQLite-Workspace-Store). Der anonyme Entwicklungsmodus benötigt keine externe Infrastruktur:

```bash
npm install
npm run build
npm start
```

Danach `http://localhost:8080` in zwei Browserfenstern öffnen. `npm start` verwendet ohne weitere Environment-Variablen bewusst `AUTH_MODE=disabled`; auch dann wird jeder Join durch eine im Browser erzeugte, nicht exportierbare P-256-Geräteidentität signiert. `localhost` gilt als sicherer Entwicklungskontext. Andere Geräte benötigen HTTPS/WSS.

Medien werden niemals automatisch angefordert. Mikrofon, Kamera und Bildschirm starten nur über ihre jeweiligen Buttons. Beim Verlassen stoppt die App alle eigenen Tracks.

Bildschirmfreigabe ist standardmäßig video-only. Bildschirmton muss unter `Einstellungen → Video & Bandbreite` separat und bewusst aktiviert werden, weil Tab- oder Systemaudio den laufenden Gesprächston erneut in den Raum senden und dadurch Echo erzeugen kann. Das Opt-in allein startet keinen Capture-Aufruf und gilt beim nächsten Bildschirm-teilen-Klick. Wird es während einer Freigabe ausgeschaltet, stoppt ausschließlich der Bildschirm-Audiotrack; das geteilte Bild läuft weiter. Unterstützte Browser werden zusätzlich um `restrictOwnAudio` gebeten, diese experimentelle Eigentonfilterung ist jedoch nur Zusatzschutz und keine portable Echo-Garantie. Für Bildschirmton werden Kopfhörer empfohlen.

## Lokale Live-Untertitel

Unter `Untertitel` stehen 13 fest erlaubte, direkt nachladbare Vosk-Modelle von
Deutsch und zwei Englischvarianten bis Mandarin, Persisch, Russisch, Türkisch
und Vietnamesisch bereit. Auswahl und Laden fordern keine Aufnahmeberechtigung
an. Nach dem bewussten Mikrofonstart oder einer Bildschirmfreigabe mit Ton
verarbeitet ein isolierter WebAssembly-Worker ausschließlich lokale Track-
Clones; Mikrofon und Bildschirmton können mit getrennten Recognizern parallel
laufen. Vor dem Start ist wählbar, ob Text nur im eigenen Browser erscheint
oder über den dedizierten WebRTC-DataChannel an Raumpeers geht. Empfänger
benötigen kein eigenes Modell. Die Signaling Control Plane sieht weder Audio
noch Untertitel, und der Verlauf bleibt flüchtig.

Die Archive sind je nach Sprache etwa 32 bis 49 MB groß, werden erst per Klick
geladen und können im Browserprofil gecacht oder wieder gelöscht werden. Die
Erkennung kann deutlich mehr Arbeitsspeicher und CPU benötigen. Details zu
Modellen, Lizenzen, CSP-Isolation, Grenzen und Bedienung stehen in
[docs/browser-vosk-captions.md](docs/browser-vosk-captions.md).

## Räume

Ein normaler Raum erhält einen Namen, einen kryptografisch zufälligen Einladungslink und die Sichtbarkeit `private` oder `public`. Öffentliche Räume kann jeder Besucher ohne Token im Raumverzeichnis sehen; angemeldete Nutzer sehen daneben alle von ihrer exakten OIDC-Identität erstellten Räume. Nur dieser Ersteller darf Name oder Sichtbarkeit ändern. `private` entfernt einen Raum aus der öffentlichen Liste, widerruft aber keinen bereits bekannten Bearer-Invite. Für einen echten Widerruf muss ein neuer Raumcode verwendet werden.

Ein Raum entsteht flüchtig beim ersten Join, besitzt eine vollständig getrennte Teilnehmerliste und akzeptiert standardmäßig höchstens 20 gleichzeitig verbundene Browser. Signale können ausschließlich an Teilnehmer desselben Raums adressiert werden. Es gibt keine anwendungsseitige Obergrenze für die Anzahl gleichzeitig aktiver Räume; praktisch begrenzen nur die verfügbaren Serverressourcen. Leere Membership wird sofort verworfen. Die ebenfalls nur im Arbeitsspeicher gehaltenen Verzeichnismetadaten bleiben nach der letzten Aktivität höchstens `ROOM_IDLE_TTL_MS` erhalten und gehen bei einem Serverneustart verloren; Membership, Medien und Raumverlauf werden nicht persistiert.

`Neue Pair-Session` erzeugt einen eigenen Sessiontyp für Pair Dev. Er akzeptiert höchstens zwei unterschiedliche P-256-Geräte. Ein vorhandener Raum kann nicht zwischen Pair- und Room-Modus wechseln; derselbe Gerätefingerprint darf nicht zweimal derselben Pair-Session beitreten.

Angemeldete Nutzer können zusätzlich einen persistenten Pair-Workspace anlegen. Der OIDC-Issuer bildet die Tenant-Grenze; der Ersteller wird Owner und genau ein authentifizierter Einladungsnutzer Editor. Owner, Editor und Viewer werden bei jeder Operation neu geprüft. Membership-Änderungen verwenden eine Compare-and-Set-Revision; Timeline-Events sind idempotent und entstehen atomar mit einem Outbox-Eintrag. Monotone Read-Cursor und kurzlebige, epochgebundene Presence-Leases überleben einen Serverneustart. Persistiert werden ausschließlich Workspace-Metadaten und ausdrücklich gespeicherte Events, niemals Medien oder übertragene Dateiinhalte.

Vor jedem WebSocket-Upgrade autorisiert `POST /api/sessions` Identität, Gerät, Raum, Modus und Origin. Das Access Token wird niemals in eine WebSocket-URL geschrieben. Stattdessen erhält der Browser ein zufälliges, kurzlebiges und nur einmal verwendbares Signaling-Ticket.

## Adaptive Bandbreite und Active Speaker

Normale Räume verwenden weiterhin eine isolierte PeerConnection je Gegenüber, übertragen aber nicht mehr zwangsläufig jede Kamera in voller Qualität zu jedem Peer:

- lokale Audioanalyse verteilt ausschließlich begrenzte Aktivitätswerte über einen eigenen Control-DataChannel;
- Sprecher 1–2 erhalten Focus-, Sprecher 3–5 Balanced-Qualität;
- inaktive Kameras werden abhängig von Raumgröße, Profil und Linkzustand reduziert; bei bis zu fünf Teilnehmern halten `Auto` und `Ausgewogen` mindestens ein bewegtes Thumbnail (vor Prioritätsgewichtung 400 kbit/s, 12 FPS und vierfache Skalierung), während größere Räume und das explizite Datensparprofil weiterhin aggressiv reduzieren oder pausieren dürfen;
- die gewählte Medienstrategie ordnet Mikrofon, Screenshare und Kamera relativ; Sprache behält unabhängig von der Reihenfolge ein eigenes Mindestbudget;
- WebRTC-Stats können Qualität nur absenken; eine niedrige Bandbreitenschätzung allein führt höchstens zu `constrained`, während `critical` starke RTT- oder Verlustwerte benötigt. Recovery benötigt eine stabile Haltezeit;
- höchstens fünf Fokusvideos bleiben einzeln sichtbar, die übrigen Kameras werden in genau einem lokalen Canvas-Mosaik dargestellt;
- `Auto`, `Ausgewogen` und `Datensparend` können ohne erneuten Capture-Aufruf gewechselt werden.

Unter `Einstellungen → Medienstrategie` stehen die Presets `Gespräch`, `Präsentation`, `Ausgewogen`, `Kamera-Fokus`, `Datensparen` und `Musik / Studio` bereit. Jedes Preset verbindet ein Audioprofil, die adaptive Video-Regel und eine eindeutige Reihenfolge für Mikrofon, Bildschirm und Kamera. Jede einzelne Auswahl kann geändert werden; dann speichert der Browser eine benutzerdefinierte Strategie. Ein Positionswechsel tauscht Quellen, statt doppelte oder fehlende Prioritäten zuzulassen.

`Meine Empfangsqualität` ist davon getrennt und wird ebenfalls nur im eigenen Browser gespeichert. `Automatisch`, `Niedrig`, `Mittel`, `Hoch` und `Nur Audio` werden beim Öffnen jedes direkten Control-DataChannels als geschlossener Intent an genau diese Gegenstelle gesendet. Der Publisher kombiniert den Wunsch pro Zielpeer ausschließlich als zusätzliche Obergrenze mit seiner eigenen Strategie und den Linkwerten; ein Empfänger kann daher weder eine höhere Stufe erzwingen noch die Senderinstanz anderer Empfänger verändern. Im optionalen entschlüsselnden Legacy-Relay-Modus bleibt allerdings der gemeinsame Eingang eines Relay-Browsers ungekürzt, sobald davon weitere Teilnehmer abhängen; dessen persönliche Auswahl darf nicht unbemerkt die Nachgelagerten reduzieren. Im Media-Agent-Pfad begrenzt dieselbe Auswahl die eigene Kamera-Subscription auf `low`, `medium` oder `high`; `Nur Audio` deaktiviert eigene Kamera- und Bildschirm-Subscriptions, lässt Mikrofon sowie Bildschirmton aber aktiv. Agent-Bildschirm bleibt derzeit eine gemeinsame Single-Layer-Publikation und kann pro Empfänger noch nicht auf niedrige oder mittlere Auflösung umgeschaltet werden. Alle Grenzen sind best-effort und keine garantierte Netz-QoS.

Die Audioprofile setzen best-effort Capture-Ziele sowie Senderobergrenzen: sparsame Sprache verwendet Mono und 24 kbit/s, klare Sprache Mono und 48 kbit/s, Musik Stereo und 128 kbit/s. Ein aktives Mikrofon wird per `applyConstraints()` ohne neuen Capture-Aufruf angepasst; angezeigt werden ausschließlich die anschließend von `getSettings()` gemeldeten tatsächlichen Werte. Das Musikprofil deaktiviert bewusst Echo-, Rausch- und Pegelfilter und ist deshalb nur mit Kopfhörern empfohlen. Die Reihenfolge wird zusätzlich als `high`, `medium` und `low` an die RTP-Sender übergeben und begrenzt Video-Bitrate/FPS passend zur Quelle. Diese Prioritäten beeinflussen lokale Bandbreitenzuteilung und gegebenenfalls DSCP, sind aber keine QoS-Garantie; Browser und Netz dürfen sie teilweise ignorieren. Fällt die Priority-Erweiterung aus, bleiben die getesteten Senderobergrenzen aktiv. Audio wird nie allein wegen einer niedrigen Position deaktiviert und behält mindestens 20 kbit/s.

Unter `Einstellungen → Video & Bandbreite` lassen sich Kamera und Bildschirm zusätzlich getrennt begrenzen. Verfügbar sind `Automatisch` sowie 240p, 360p, 480p, 540p, 720p, 900p, 1080p, 1440p und 2160p; die FPS-Obergrenzen reichen von 2 bis 60. Die Auswahl wird nur lokal im Browser gespeichert und startet keine Aufnahme. Bei einem bereits aktiven Track verwendet die Anwendung `applyConstraints()` ohne einen weiteren Berechtigungsdialog und zeigt die danach von `getSettings()` gemeldete tatsächliche Auflösung und Bildrate. Die Werte sind Obergrenzen: Browser und adaptive Sendersteuerung dürfen darunter bleiben. Insbesondere 360p mit 5–10 FPS oder 240p mit 2–5 FPS reduziert den Upload deutlich, eignet sich aber eher für ruhige Bilder als für flüssige Bewegung.

Das Canvas allein spart keine Netzwerkbytes. Die Ersparnis entsteht aus den gleichzeitig angewandten Senderstufen `focus`, `balanced`, `thumbnail` und `paused`.

Ab `PEER_MEDIA_RELAY_MIN_PARTICIPANTS` betrachtet die Control Plane im expliziten Legacy-Modus `MEDIA_E2EE_MODE=disabled` einen zyklusfreien Video-Relay-Baum. Sie stellt ihn aber nur aus, wenn die konfigurierte Kindergrenze den direkten Publisher-Fanout `N - 1` tatsächlich reduziert und genügend geeignete Browser zugestimmt haben. Mit den Defaults `minimumParticipants=3` und `maxChildren=3` bleiben drei und vier Teilnehmer daher direkt; der erste mögliche Relay-Vorteil entsteht bei fünf. Membership-, Route- und Topology-Epochen sind getrennt; jede Publikationsroute besitzt eine kurzlebige Lease, Primary und – soweit topologisch möglich – Backup. Relay-Auswahl berücksichtigt ausdrückliche Zustimmung, Sichtbarkeit, Energie-/Netzklasse, Eigenkapazität und beobachtete Lieferqualität. Dieser Browser-Relay dekodiert und re-encodiert fremde Medien und ist daher nicht blind. In den Modi `required` und `preferred` bleibt er deaktiviert; dort transportieren Direct-, Edge-TURN- und Infrastruktur-TURN-Pfade SFrame-Ciphertext.

Optional kann dort ein getrennter nativer Blind-Media-Agent Publisher-Fanout reduzieren. Nach explizitem Consent wird bevorzugt der Agent des Raumerstellers gewählt; der Bonus ist begrenzt, sodass Gesundheit, Netz, Last oder Batterie einen besseren Freiwilligen vorziehen können. Beim Leave oder Ausfall fragt die Control Plane den nächsten geeigneten Besitzer zur Übernahme oder nutzt dessen separates Auto-Takeover-Opt-in. Kamera-Publisher handeln `q`/`h`/`f`-Simulcast aus; jeder Subscriber fordert innerhalb einer lokalen Obergrenze genau `low`, `medium` oder `high` an. Audio, Bildschirm und Bildschirmton bleiben eigene Single-Layer-Publikationen.

Ab `MEDIA_AGENT_MIN_PARTICIPANTS` (Default 3) darf genau ein gesunder, consentierter Primary den Publisher-Fanout reduzieren; ein Zweiergespräch bleibt direkt. Ein Browser kann nach einem sichtbaren lokalen Klick bis zu drei exakt kontoeigene Online-Agenten atomar für den aktuellen Raum freigeben und gemeinsam widerrufen. Unterhalb der Shard-Schwelle – mit den Defaults also in Räumen mit drei bis fünf Teilnehmern – werden freie Kapazität, aktuelle Last, Netz- und Batterieklasse sowie Creator-Präferenz bewertet, aber noch keine Publisher auf mehrere Agenten verteilt; weitere gewählte Agenten bleiben Standby. Ab `MEDIA_AGENT_SHARD_MIN_PARTICIPANTS` weist die Control Plane jedem Publisher einen Ingress und jedem Subscriber einen Egress zu und kann Primary plus höchstens zwei Standbys als Forwarder nutzen. Bei mehreren aktiven Agenten erzeugt sie einen epochgebundenen, zyklenfreien DAG mit höchstens zwei Hops. Die Agenten bauen die autorisierten Links direkt per WebRTC auf und transportieren ausschließlich die angeforderten SFrame-Ciphertext-Layer; SDP/ICE läuft über die Control Plane, Medien nicht. Bis E2EE-Key-ACK, Agent-/Browser-Verbindung, angewendeter Layer und Receiver-ACK vollständig bestätigt sind, bleibt das required-SFrame-Direkt-Mesh aktiv. Widerruf, fehlende Kapazität oder eine abgelaufene Lease führen ohne Klartextfallback zum Direct-SFrame-Pfad zurück. Kein Agent erhält SFrame-Schlüssel, Decrypt-Port, Membership- oder Policy-Autorität. Die reale Produktionsmatrix aus BME-006 bleibt trotzdem ausdrücklich kein garantierter QoS-Nachweis.

Pair-Sessions besitzen daneben einen eigenständigen Daten-Overlay-Kanal. Jeder Browser erzeugt pro Session einen nicht exportierbaren ECDH-P-256-Schlüssel und verschlüsselt Events oder bewusst ausgewählte Dateien mit AES-GCM für den Zielpeer. Zwischenbrowser sehen nur Ciphertext und begrenzte Routing-Metadaten. Digest, TTL, Membership-/Route-Epoch, schleifenfreier Pfad, Hopzahl, Replay-Fenster, Chunkzahl und per Traffic-Class begrenzte Queues werden geprüft. Fehlende Chunks werden verschlüsselt quittiert und gezielt erneut gesendet; ohne nutzbare Relay-Route wird direkt, aber weiterhin Ende-zu-Ende verschlüsselt übertragen. Ein Download startet ausschließlich durch einen weiteren Nutzerklick.

## Öffentliche Ananta-Voreinstellung

Das Compose-Deployment verwendet ohne Domain-Overrides bereits diese öffentlichen Endpunkte:

- Anwendung: `https://webrtc.ananta.de`
- Identity Provider: `https://keycloak.ananta.de/realms/ananta`
- Browser-Client: `webrtc-browser`
- Access-Token-Audience: `webrtc-room-server`

Die OIDC-Discovery des Realms ist öffentlich erreichbar. Damit der Login funktioniert, muss der öffentliche Keycloak-Client zusätzlich im Realm `ananta` registriert sein; DNS und HTTPS für `webrtc.ananta.de` müssen auf dieses Deployment zeigen. Das Repository verändert den externen Realm nicht automatisch.

Die passende, geschlossene Keycloak-Clientdefinition lässt sich ohne Secret erzeugen:

```bash
npm run --silent keycloak:client-config
```

Sie enthält exakt `https://webrtc.ananta.de/oidc-callback`, den Web Origin, PKCE S256 und den Audience-Mapper. Ein Realm-Administrator kann die Ausgabe über Keycloak Admin oder `kcadm.sh` importieren. Für eigene Domains werden nur die Betreiberwerte ersetzt:

```dotenv
PUBLIC_ORIGIN=https://call.example.org
KEYCLOAK_ORIGIN=https://login.example.org
KEYCLOAK_REALM=company
OIDC_CLIENT_ID=webrtc-browser
OIDC_AUDIENCE=webrtc-room-server
```

`OIDC_ISSUER` bleibt normalerweise leer und wird daraus als `KEYCLOAK_ORIGIN/realms/KEYCLOAK_REALM` abgeleitet. Ein explizites `OIDC_ISSUER` hat für abweichende Provider Vorrang. `OIDC_JWKS_URL` bleibt normalerweise ebenfalls leer und wird aus dem exakt geprüften Issuer abgeleitet.

## Vollständiger lokaler Stack

Das öffentliche Standardprofil startet nur die Anwendung. Das ausdrücklich gewählte Profil `local` ergänzt Keycloak 26.6.1 und Coturn 4.6.3 mit localhost-Werten:

```bash
cp .env.local.example .env
# Vor gemeinsamem oder öffentlichem Betrieb mindestens alle Beispielpasswörter
# und TURN_SHARED_SECRET ersetzen.
docker compose --profile local up --build
```

Danach:

- Anwendung: `http://localhost:8080`
- Keycloak: `http://localhost:8081`
- STUN/TURN: `localhost:3478` über UDP und TCP
- Relay-UDP-Ports: `49160-49200`

Im Browser `Mit Keycloak anmelden` wählen und bei Bedarf über Keycloak ein Konto registrieren. Der importierte öffentliche Client verwendet Authorization Code Flow mit PKCE S256; Implicit Flow und Direct Access Grants sind deaktiviert. `start-dev`, die H2-Datenbank, unverschlüsseltes lokales TURN und die Beispielzugänge sind ausschließlich für lokale Entwicklung vorgesehen.

## Konfiguration

Die öffentliche Voreinstellung steht in `.env.example`, das getrennte localhost-Profil in `.env.local.example`. Die Anwendung lädt `.env` nicht selbst; Variablen werden von Shell, Compose oder Secret-Management gesetzt.

- `PUBLIC_ORIGIN`: exakte öffentliche HTTPS-Origin für Invite-Links und WebSocket-Origin-Prüfung.
- `AUTH_MODE`: `required`, `optional` oder `disabled`; Compose verwendet `required`, direkter Node-Start standardmäßig `disabled`.
- `KEYCLOAK_ORIGIN`, `KEYCLOAK_REALM`: leicht austauschbare Kurzform, aus der der OIDC-Issuer gebildet wird; beide müssen gemeinsam gesetzt sein.
- `OIDC_AUDIENCE`, `OIDC_CLIENT_ID`: browserseitig sichtbare und serverseitig exakt geprüfte Clientwerte.
- `OIDC_ISSUER`: optionaler vollständiger Issuer-Override mit Vorrang vor der Keycloak-Kurzform.
- `OIDC_JWKS_URL`: optional getrennte interne JWKS-Adresse, etwa der lokale Compose-Service `keycloak`; öffentlich wird sie sicher aus dem Issuer abgeleitet.
- `SESSION_TICKET_TTL_MS`, `DEVICE_PROOF_MAX_AGE_MS`: enge Gültigkeitsfenster für Ticket und signierten Gerätenachweis.
- `STUN_URLS`: kommaseparierte STUN-URLs.
- `TURN_URLS`, `TURN_SHARED_SECRET`, `TURN_REALM`, `TURN_CREDENTIAL_TTL_MS`: Coturn-REST-Credentials mit HMAC und kurzer Gültigkeit.
- `TURN_SERVERS_JSON`: optionales statisches `RTCIceServer`-Array für ausdrücklich kontrollierte Tests; nicht für Produktion empfohlen.
- `EDGE_TURN_SERVERS_JSON`: serverseitige Liste freiwilliger Edge-TURN-Knoten mit `id`, `urls`, `realm` und jeweiligem `sharedSecret`; Secrets werden niemals an den Browser ausgegeben.
- `PEER_EDGE_FALLBACK_MS`, `INFRASTRUCTURE_TURN_FALLBACK_MS`: begrenzte Eskalation von Direct/STUN zu Edge und anschließend Infrastruktur-TURN; der zweite Wert muss größer sein.
- `MEDIA_E2EE_MODE`: `required` (Default, kein Klartext-Fallback), `preferred` (sichtbarer Fallback nur ohne Encoded-Transform-Capability) oder `disabled` (Legacy-Relay, keine Frame-E2EE).
- `MAX_ROOM_PARTICIPANTS`: Betreiberlimit von 2 bis höchstens 20; Default ist 20.
- `ROOM_IDLE_TTL_MS`: Obergrenze für inaktive Room-Metadaten.
- `SIGNAL_RATE_LIMIT`: Nachrichten je Peer und 10 Sekunden; Default 300 für Direct-ICE plus höchstens 76 Layer-Intents bei 20 Peers und vier Publikationen.
- `ACTIVE_SPEAKER_LIMIT`: Zahl einzeln fokussierter Sprecher, begrenzt auf 2 bis 5.
- `PEER_MEDIA_RELAY_ENABLED`: Betreiberfreigabe für Trusted Peer Relay; Nutzerzustimmung bleibt trotzdem standardmäßig aus.
- `PEER_MEDIA_RELAY_MIN_PARTICIPANTS`: kleinste Raumgröße, ab der ein Legacy-Browser-Relay geprüft wird; Default 3. Eine Route entsteht zusätzlich nur bei echtem Fanout-Vorteil gegenüber `N - 1`.
- `PEER_MEDIA_RELAY_MAX_CHILDREN`, `PEER_MEDIA_RELAY_MAX_HOPS`: harte Fanout- und Tiefengrenzen.
- `PEER_ROUTE_LEASE_MS`, `PEER_ROUTE_RENEW_MS`: Lease-Gültigkeit und frühere Erneuerung; Renewal muss kürzer sein.
- `PEER_RELAY_HEALTH_WINDOW_MS`, `PEER_RELAY_HEALTH_COOLDOWN_MS`: Quorum-Beobachtungsfenster und Failover-Cooldown.
- `PEER_DATA_OVERLAY_ENABLED`: schaltet nur den browserseitig E2EE-geschützten Daten-Overlay ab; Direct Chat/Control bleiben erhalten.
- `MEDIA_EDGE_AGENTS_JSON`: ausschließlich serverseitige Liste nativer Blind-Media-Agenten mit exakt `id`, `ownerPrincipal` (`issuer|subject`) und individuellem `sharedSecret`; niemals an Browser ausgeben.
- `MEDIA_AGENT_LEASE_MS`, `MEDIA_AGENT_RENEW_MS`, `MEDIA_AGENT_MAX_STANDBYS`, `MEDIA_AGENT_TAKEOVER_TTL_MS`: kurze Agent-Leases, Erneuerung, höchstens zwei Standbys und sichtbares Übernahmefenster.
- `MEDIA_AGENT_MIN_PARTICIPANTS`: kleinste Raumgröße für einen einzelnen geeigneten, consentierten nativen Media-Agenten; Default 3.
- `MEDIA_AGENT_SHARD_MIN_PARTICIPANTS`: Raumgröße, ab der die Control Plane Publisher über Primary und Standbys verteilt; Default 6.
- `MEDIA_AGENT_RATE_LIMIT`: geschlossene Agent-Control-Nachrichten je zehn Sekunden; Default und Maximum 2.000 für den begrenzten 20-Peer-/Vier-Publikations-Burst.
- `MEDIA_AGENT_SELF_SERVICE_ENABLED`: aktiviert ausschließlich mit OIDC und einer HTTPS-`PUBLIC_ORIGIN` die kontogebundene Installation aus der Angular-App; im nackten Entwicklungsmodus ist sie aus.
- `MEDIA_AGENT_REGISTRATION_DB`: persistenter SQLite-Pfad für öffentliche Agent-Schlüssel, Besitzerbindung und gehashte Einmaltickets; Default im Compose-Volume ist `/app/data/media-agent-registrations.sqlite`.
- `MEDIA_AGENT_ARTIFACT_DIR`: Verzeichnis der reproduzierbar gebauten Linux-, macOS- und Windows-Binärdateien. Nur tatsächlich vorhandene Ziele erscheinen im Browser.
- `MEDIA_AGENT_ENROLLMENT_TTL_MS`, `MEDIA_AGENT_MAX_PER_PRINCIPAL`, `MEDIA_AGENT_ENROLLMENT_RATE_LIMIT`: Ablaufzeit, aktive Gerätequote und stündliche Enrollment-Grenze.
- `PAIR_WORKSPACE_ENABLED`, `PAIR_WORKSPACE_DB`: optionaler persistenter Pair-Workspace und Pfad seines SQLite-Volumes.

Beispiel für einen externen Coturn-Dienst:

```bash
TURN_URLS='turns:turn.example.org:5349' \
TURN_SHARED_SECRET='aus-secret-management' \
TURN_REALM='call.example.org' npm start
```

Das Shared Secret bleibt ausschließlich auf Server und Coturn. Der Browser erhält erst nach autorisiertem `POST /api/sessions` einen zeitlich begrenzten Benutzernamen und das zugehörige HMAC-Credential.

### Freiwilliger Edge-Agent

Unter [`edge-agent/`](edge-agent/) liegt ein optionaler nativer TURN-Agent auf Basis von Pion. Ein geeigneter Rechner kann damit freiwillig zum bevorzugten zweiten ICE-Pfad werden. Er erhält keine Room-Membership, keine OIDC-Tokens und keine SFrame-Schlüssel; er leitet nur WebRTC-Pakete weiter. Globales und nutzerbezogenes Allocation-Limit, feste UDP-Relay-Ports, kurzlebige REST-Credentials und eine standardmäßige Sperre privater Zielnetze begrenzen den Dienst.

Der Rechner muss von den anderen Teilnehmern erreichbar sein: per öffentlicher IPv6-Adresse oder per IPv4-Portweiterleitung für `3478/udp`, optional `3478/tcp` und den konfigurierten UDP-Relay-Bereich. Ein Rechner hinter CGNAT ohne öffentliche IPv6-Adresse, Portmapping oder vorgelagerten Relay kann nicht allein durch den Agent zum erreichbaren Relay werden. Installation, Firewall, Secret-Kopplung und Verifikation beschreibt [docs/edge-agent.md](docs/edge-agent.md).

Beispiel für die ausschließlich serverseitige Registrierung eines Agenten:

```dotenv
EDGE_TURN_SERVERS_JSON='[{"id":"edge-1","urls":["turn:edge.example.org:3478?transport=udp","turn:edge.example.org:3478?transport=tcp"],"sharedSecret":"aus-secret-management","realm":"webrtc.ananta.de"}]'
```

### Freiwilliger blinder Media-Agent

[`media-edge-agent/`](media-edge-agent/) enthält den davon unabhängigen, selektiven Pion-Medienforwarder. Er verbindet sich ausgehend per WSS, erhält nur kurze raum-, Membership- und Route-gebundene Leases und besitzt isolierte PeerConnections zu den ihm zugewiesenen Browsern sowie zu ausdrücklich serverautorisierten Nachbaragenten. Der Browser verschlüsselt Frames bereits vor dem Upload mit einem publikationsgebundenen SFrame-Gruppenschlüssel und verteilt diesen einzeln über den ECDH-/AES-GCM-Overlay an die anderen Raumteilnehmer – niemals an einen Agenten. Kamera-Simulcast wird pro Subscriber ohne Decode/Re-encode auf genau einen erlaubten, aktuell verfügbaren Layer reduziert. Ein eigener Egress-Track hält RTP-Sequenz und -Zeit beim Wechsel zwischen den unabhängigen RID-Sequenzräumen monoton; die opaque Payload bleibt dabei unverändert. Revisionsgebundene Readiness nach dem ersten weitergeleiteten Paket verhindert, dass ein alter oder noch nicht fließender Layerwechsel den Direct-Fallback abschaltet. Agentenübergreifend werden nur aktuell nachgefragte Layer weitergereicht.

Native Browser-Agent-Offers werden zusätzlich über einen geschlossenen,
geordneten `media-agent-control`-DataChannel serialisiert: Der Agent fordert
eine monotone, routegebundene Sequenz an, der stabile Browser erteilt genau
einen kurzlebigen Turn, und nur ein Offer mit derselben Sequenz wird über die
Control Plane akzeptiert. Browser-Offers haben dabei Vorrang. Duplikate,
Sprünge, unbekannte Felder, falsche Epochen und abgelaufene Turns schließen die
betroffene Agent-Verbindung; sie erzeugen keine neue Medien- oder
Membership-Autorität.

Trickle-ICE bleibt auch über ICE-Restarts geordnet: Browser und Agent binden
Kandidaten über `usernameFragment` an die passende SDP-Generation. Ein vor dem
zugehörigen Offer eintreffender Kandidat wird nur begrenzt gehalten, mit genau
dieser Generation angewendet und als alte Generation verworfen. Dadurch kann
ein verzögerter Offer weder einen fremden Kandidaten übernehmen noch einen
TURN-Restart durch Ufrag-Überkreuzung abbrechen.

```bash
cd media-edge-agent
cp .env.example .env
# ID und mindestens 32 zufällige Secret-Zeichen ausschließlich in .env setzen.
docker compose up -d --build
```

Die Control Plane benötigt denselben Agenten ausschließlich in ihrer privaten Umgebung:

```dotenv
MEDIA_EDGE_AGENTS_JSON='[{"id":"laptop-edge","ownerPrincipal":"https://keycloak.example/realms/example|oidc-subject","sharedSecret":"aus-secret-management"}]'
```

Für neue freiwillige Rechner ist im öffentlichen Compose-Preset zusätzlich der Self-Service-Pfad aktiv. Ein angemeldeter Nutzer öffnet **Analyse → Dein Media-Agent**, wählt Betriebssystem und Architektur und erzeugt mit einem sichtbaren Klick eine Installationsdatei. Diese enthält nur ein maximal zehn Minuten gültiges Einmalticket. Der Installer lädt das exakte Artefakt per HTTPS, prüft den eingebetteten SHA-256-Wert, erzeugt lokal eine P-256-Identität und richtet einen Autostart im Benutzerkonto ein. Der private Schlüssel verlässt den Rechner nicht; die Control Plane speichert nur den öffentlichen Schlüssel. Das langlebige HMAC-Secret aus `MEDIA_EDGE_AGENTS_JSON` bleibt ausschließlich als kompatibler Betreiberpfad bestehen und wird nicht an den Browser gegeben.

Download und Ausführung sind getrennte, explizite Nutzeraktionen. Seitenladen, Öffnen der Analyse oder ein Remotesignal startet weder Installation noch Capture, Portfreigabe oder Raum-Consent. Die Pakete sind derzeit nicht kommerziell code-signiert/notarisiert; UI und Installer weisen auf mögliche Betriebssystemwarnungen hin. Linux ist der reale Rolloutpfad dieses Projekts, macOS und Windows werden cross-kompiliert und vertraglich geprüft, bleiben bis zu einem echten Gerätetest aber ausdrücklich `unverified`.

Consent ist in der Raumoberfläche standardmäßig aus und widerrufbar. Eine Übernahme erklärt Upload-, CPU-, Batterie-, IP-/Metadaten- und TURN-Folgen. Ein fester Port ist nicht zwingend: `MEDIA_AGENT_UDP_PORT=0` nutzt normale ICE-Sockets und bei Bedarf TURN. Eine feste UDP-Weiterleitung, beispielsweise `44000/udp`, plus passendes `MEDIA_AGENT_PUBLIC_IP` verbessert direkte Erreichbarkeit. Die Browser-Agent-Verbindung startet mit Direct/STUN und ergänzt Edge- sowie Infrastruktur-TURN erst nach den serverautorisierten Fristen per ICE-Restart; eine bereits verbundene Route stoppt diese Eskalation. Der native Pion-Agent erhält innerhalb seiner kurzen Lease derzeit die vollständige ICE-Serverliste, sodass dessen Candidate-Gathering in den Coturn-Quoten berücksichtigt werden muss. `user-quota` muss mindestens die gleichzeitig benötigten Allocations eines Principals und `total-quota` die Raum-/Agent-Matrix tragen; kleine Beispielwerte sind keine 20-Teilnehmer-Kapazitätszusage. Betrieb, Trust-Grenzen, Creator-Wahl, Failover, Simulcast und Föderation beschreibt [docs/blind-media-edge-agent.md](docs/blind-media-edge-agent.md).

### Kapazitätsgrenze

20 ist die harte Membership-Grenze je Raum, keine garantierte Medienqualität. Ohne bereit bestätigten Blind-Media-Agenten hält jeder Teilnehmer im SFrame-Standardpfad weiterhin bis zu 19 `RTCPeerConnection`-Verbindungen; Kamera und Screenshare werden nach Active-Speaker-, Link- und Nutzerprofil gedrosselt. SFrame allein reduziert weder Verbindungszahl noch Publisher-Fanout. Der TURN-Edge-Agent verbessert nur Erreichbarkeit. Der getrennte Blind-Media-Agent reduziert nach vollständiger Readiness den Publisher-Upload auf eine Simulcast-Publikation zum eigenen Ingress; der selektive Egress sendet pro Subscriber nur einen Kamera-Layer. Bei mehreren Agenten übernimmt der direkte, höchstens zweistufige Agent-DAG den Cross-Shard-Transport. Browser behalten das Direct-Mesh als sofortigen Failover. Ein portabler browserbasierter Ciphertext-DAG und ein zentral betriebener SFU mit garantierter Großraum-QoS bleiben getrennte, nicht behauptete Fähigkeiten.

## Öffentliches Deployment

Für das Ananta-Preset muss ein HTTPS-Reverse-Proxy `webrtc.ananta.de` auf Port 8080 weiterleiten und WebSocket-Upgrades für `/signal` sowie – nur bei konfigurierten nativen Agenten – `/media-agent` durchreichen. Für eine eigene Installation werden `PUBLIC_ORIGIN`, `KEYCLOAK_ORIGIN` und gegebenenfalls `KEYCLOAK_REALM` in `.env` ersetzt; dieselbe Origin muss in der erzeugten Keycloak-Clientdefinition registriert werden. Keycloak und Coturn benötigen produktive Datenbank, TLS, gesicherte Adminzugänge und Secret-Management. `TURN_EXTERNAL_IP` muss die von Clients erreichbare Adresse enthalten; für TURN/TLS werden `turns:` und ein gültiges Zertifikat benötigt. Der lokale Compose-Stack ist keine unveränderte Produktionsvorlage.

Läuft Caddy selbst in Docker, verbindet das kleine Override beide Stacks über
ein bereits bewusst angelegtes externes Netz. Caddy kann dann stabil
`webrtc-room-server:8080` verwenden; der Alias überlebt auch ein Recreate des
WebRTC-Containers:

```bash
docker network inspect webrtc-edge >/dev/null
docker compose \
  -f compose.yaml \
  -f infra/reverse-proxy/compose.caddy-network.yaml \
  up -d --build webrtc
```

Der Caddy-Container muss ebenfalls mit `webrtc-edge` verbunden sein. Für einen
auf dem Host laufenden Reverse-Proxy bleibt das Override weg und der
veröffentlichte Port 8080 wird verwendet. Ein abweichender externer Netzname
kann ausschließlich beim Deploy über `WEBRTC_REVERSE_PROXY_NETWORK` gesetzt
werden.

## API

- `GET /`: Browser-App
- `GET /healthz`: inhaltsfreier Health-/Room-Zähler
- `GET /config`: öffentliche ICE-Konfiguration
- `GET /api/rooms`: öffentliche Räume und – mit gültigem Bearer-Token – die eigenen Räume auflisten
- `POST /api/rooms`: privaten/öffentlichen Room-Invite, Pair-Invite oder authentifizierten persistenten Pair-Workspace erstellen
- `PATCH /api/rooms/:roomId`: Name oder Sichtbarkeit ausschließlich als verifizierter Room-Owner ändern
- `POST /api/sessions`: Bearer-Token und P-256-Gerätebeweis prüfen; Einmal-Ticket und kurzlebige TURN-Credentials ausstellen
- `GET /api/workspaces`, `GET /api/workspaces/:id`: eigene Workspaces und revisionierte Membership lesen
- `GET|POST /api/workspaces/:id/events`: permission-aware Timeline fortsetzen oder idempotentes Event schreiben
- `PUT /api/workspaces/:id/cursor|presence`: monotonen Cursor beziehungsweise epochgebundene Presence-Lease setzen
- `POST /api/workspaces/:id/roles`: Rolle mit erwarteter Membership-Revision ändern oder widerrufen
- `GET /api/media-agents`: ausschließlich die eigenen OIDC-gebundenen Agentregistrierungen und ihren Online-/Widerrufszustand lesen
- `POST /api/media-agents/enrollments`: nach expliziter Nutzeraktion ein kurzlebiges Enrollment samt plattformspezifischem, checksum-gebundenem Installer erzeugen
- `DELETE /api/media-agents/:id`: eine eigene dynamische Registrierung widerrufen und ihre aktive Verbindung sofort beenden
- `GET /downloads/media-edge-agent/:target`: eines der exakt freigegebenen, im Runtime-Katalog veröffentlichten nativen Artefakte laden
- `GET /signal?ticket=…`: WebSocket-Signaling mit einmal verwendbarem Session-Ticket
- `GET /media-agent`: originloser WSS-Control-Pfad für native Agenten mit kompatibler HMAC- oder registrierter P-256-Challenge sowie einmaligem P-256-Enrollment; kein Browser- oder Medienendpunkt

## Sicherheitsstatus

Im `required`- oder `optional`-Auth-Modus prüft der Server Access Tokens über JWKS auf Signatur, erlaubten Algorithmus, Issuer, Audience, Ablaufzeit und Subject. Join-Nachweise werden zusätzlich durch eine nicht exportierbare Browser-P-256-Identität signiert. WebRTC verschlüsselt jeden Direct-/TURN-Pfad mit DTLS-SRTP beziehungsweise DTLS/SCTP. Im standardmäßigen Media-Modus `required` schützt RFC-9605-SFrame Audio-, Kamera- und Bildschirmframes zusätzlich mit `AES_128_GCM_SHA256_128`; im Direkt-Mesh entsteht Key-Material pro Publikation, Zielpeer und Membership-Epoch. Für eine Agent-Route erzeugt der Publisher stattdessen einen publikations-, Agent-, Membership- und Route-Epoch-gebundenen Gruppenschlüssel und verteilt ihn weiterhin einzeln im zielpeergebundenen ECDH-/AES-GCM-Overlay. Medien-Key und ACK handeln Protokoll v2 sowie exakt `codec-prefix-v1` aus; alte oder unbekannte Formate werden nicht akzeptiert. Der sichtbare VP8-/Opus-Codecpräfix und der Envelope-Header fließen als Additional Authenticated Data in AES-GCM ein. Gesendet wird erst nach den erforderlichen ACKs. Der Agent erhält keinen Schlüssel. Unbekannte KIDs, Authentifizierungsfehler, Präfixmanipulation und Replays werden verworfen. Fehlende Browser-Capability, nicht unterstützte Codecs oder fehlende ACKs ergeben fehlende Medien statt Klartext.

Die Peer-Public-Key-Zuordnung für diesen Overlay stammt weiterhin aus dem authentisierten Signaling-Pfad. Damit verbirgt SFrame Inhalte vor ehrlichen, aber neugierigen TURN-, Edge- und Control-Plane-Betreibern; es beweist keine Ende-zu-Ende-Identität gegen einen vollständig kompromittierten Signaling-Server. `MEDIA_E2EE_MODE=disabled` aktiviert bewusst den alten Decode/Re-encode-Relay und besitzt diese Frame-E2EE-Eigenschaft nicht. SQLite ist kein HA-/Backup-System; Betreiber müssen Volume-Sicherung, Dateirechte und Wiederherstellung selbst verantworten.

Die vollständige Herkunfts- und Lückenmatrix steht in [docs/ananta-webrtc-adoption.md](docs/ananta-webrtc-adoption.md). Produktionsschritte stehen schema-validiert unter `todos/backlog/`.

## Entwicklung

`AGENTS.md` macht das Todo-Tracking verbindlich. Der vollständige lokale Gate ist:

```bash
npm run check
npm audit --omit=dev
docker compose config --quiet
docker compose --profile local --env-file .env.local.example config --quiet
docker build --tag webrtc-room-server:local .
(cd edge-agent && go test ./...)
docker build --tag webrtc-edge-agent:local edge-agent
(cd edge-agent && EDGE_AGENT_ENV_FILE=.env.example docker compose --env-file .env.example config --quiet)
(cd media-edge-agent && go test -race ./...)
docker build --tag webrtc-media-edge-agent:local media-edge-agent
(cd media-edge-agent && MEDIA_AGENT_ENV_FILE=.env.example docker compose --env-file .env.example config --quiet)
```

`npm run check` umfasst Todo-/Workflow-Schemas, Angular-Unit-Tests, Angular-Produktionbuild und Node-/Integrationstests. Die Browsermatrix prüft SFrame im `required`-Modus mit echten Chromium- und Firefox-Kontexten ohne automatische Capture-Anfrage. Für Vosk prüft sie zusätzlich den vollständigen 13-Modell-Katalog, fehlenden Vorabdownload und fehlende Capture-Aufrufe; der Produktionbuild extrahiert den isolierten Worker nur bei exakt passender Paketversion und SHA-256-Prüfsumme. Ein gerichteter Chromium→Firefox-VP8-Langzeittest überschreitet Counter 350 und verlangt danach weiter dekodierte Frames sowie einen neuen Keyframe ohne Drops; Unit-Tests prüfen zusätzlich Prefix-Authentisierung, Counterbreitenwechsel, Opus und unbekannte Envelope-/Codecvarianten. Die 3/4/5/6-Peer-Grenztests unterscheiden nativen Single-Agent-Nutzen vom nur bei kleinerem Root-Fanout erlaubten Legacy-Browserbaum. Der getrennte Sechs-Chromium-Gate prüft den expliziten Legacy-Relay-Baum einschließlich Sender-Fanout, Active Speaker, Datensparprofil, Mosaik und Churn-Fallback. Fehlende Browser werden ausschließlich mit sichtbarer Begründung übersprungen. Der TURN-Edge-Agent besitzt zusätzlich einen echten lokalen Allokationstest. Der Blind-Media-Agent testet echte Pion-PeerConnections für individuelle `low`/`high`-Auswahl sowie einen direkten Zwei-Agenten-Pfad, auf dem ausschließlich der angeforderte Simulcast-Layer mit byte-identischem opaque SFrame-Payload ankommt. JSON-Schema-, DAG-, stale-Epoch- und Cross-Agent-Negativtests sichern die Control Plane. Die realen BME-006-/BME-011-Gates bestanden mit sechs Browsern, zwei Agentprozessen, Chromium/Firefox, Direct/All-TURN, drei Simulcast-Layern, portablem Single-Layer-Fallback, Drain, Crash-/Totalausfall, Lease-/Heartbeat-Partition und Direct-Mesh-Rueckfall. Das ist ein Produktionspfadnachweis, aber keine garantierte QoS fuer 20 Teilnehmer.

Der Live-Infrastruktur-Gate startet absichtlich nicht implizit. Mit laufendem Compose-Stack, einer eigens angelegten Testidentität und expliziten Variablen prüft er Keycloak Discovery, PKCE-Login, JWKS-Tokenprüfung, autorisierte Einmal-Tickets sowie eine echte Coturn-Relay-Allokation:

```bash
export KEYCLOAK_ADMIN_PASSWORD='lokales-admin-passwort'
export LIVE_OIDC_USERNAME='webrtc-gate'
export LIVE_OIDC_PASSWORD='eigenes-lokales-testpasswort'
bash scripts/prepare-live-keycloak-user.sh
RUN_LIVE_INFRASTRUCTURE=1 npm run test:infrastructure
```

Die erforderlichen Variablen stehen in `.env.example`; produktive Konten oder Secrets dürfen für diesen Gate nicht verwendet werden. GitHub Actions führt denselben Test mit einem vollständig ephemeren Stack aus.

## Lizenz

Dieses Projekt steht unter der [BSD-3-Clause-Lizenz](LICENSE). Copyright © 2026 Peter Stuiber.
