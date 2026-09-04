# WHIP-Media-Sections, Quellenwechsel und Senderadaption

Stand: 2026-09-04, Implementierungsstufe `TBP-012`.

Der Browser-WHIP-Publisher behandelt Audio und Video als feste Bestandteile
einer WHIP-Session. Er ändert keine Media-Section durch eine proprietäre
Renegotiation. Quellenwechsel und Senderanpassung wirken ausschließlich auf den
bewusst gestarteten Broadcast-Fork; die SFrame-Raumpublikation und ihre
Qualitätseinstellungen bleiben unberührt.

## Feste Media-Sections

Die erste Composition bestimmt, ob die Session eine Audio-, eine Video- oder
beide Sections besitzt. Vor dem Offer wird für jeden enthaltenen Track genau
ein `sendonly`-Transceiver erstellt. Beide Tracks gehören zum selben
Program-`MediaStream`; das SDP-Gate erzwingt `max-bundle`, RTCP-Mux und
eindeutige MIDs.

Ein späterer Wechsel mit derselben Menge von Track-Kinds verwendet
`RTCRtpSender.replaceTrack()`. Dadurch bleiben m-lines, ausgehandelter Codec,
SSRC-/Gateway-Session und Zuschauerpfad bestehen. Soll Audio oder Video
hinzukommen beziehungsweise entfallen, beendet der Adapter die alte Resource
per DELETE und erstellt kontrolliert eine neue WHIP-Session. Das verursacht
eine sichtbare Programmunterbrechung, ist aber keine nicht standardisierte
Renegotiation.

Jede Composition liefert eine geschlossene Zuordnung aus Source-ID, Rolle,
Track und `clear-program-v1`-Envelope. Track-Kind, Source-Rolle, aktuelle
Composition-Source-IDs, Live-Zustand und Streamzugehörigkeit werden vor dem
Wechsel geprüft. Weil `replaceTrack` im bestehenden Transceiver erfolgt, kann
der Ersatz den ausgehandelten Codec nicht eigenmächtig wechseln. Eine andere
Envelope wird abgewiesen. Schlägt ein mehrspuriger Wechsel teilweise fehl,
versucht der Adapter die bereits ersetzten Tracks rückwärts zurückzusetzen und
meldet `degraded` oder bei gescheitertem Rollback `failed`.

## Definierte Quellenrollen

| Rolle | Track | Content-Hint | High-Obergrenze | Priorität |
|---|---|---|---:|---|
| Mikrofon | Audio | `speech` | 48 kbit/s | high |
| Bildschirmton | Audio | `speech` | 96 kbit/s | medium |
| Stille-Fallback | Audio | `speech` | 24 kbit/s | low |
| Kamera | Video | `motion` | 1,2 Mbit/s, 24 FPS | medium |
| Bildschirm | Video | `detail` | 2,5 Mbit/s, 15 FPS | high |
| Slate/Standbild | Video | `detail` | 180 kbit/s, 2 FPS | low |

Bildschirm und Slate verwenden best-effort `maintain-resolution`, Kamera
`balanced`. Netzwerkpriorität wird zuerst zusammen mit lokaler RTP-Priorität
versucht, dann ohne die jeweils nicht portable Erweiterung. Bitrate und FPS
bleiben auch beim Fallback begrenzt. Audio wird nie deaktiviert und fällt nicht
unter 20 kbit/s.

Ein `ended`-Event wird als `whip_audio_source_ended` oder
`whip_video_source_ended` sichtbar `degraded`. Es startet weder Capture noch
automatisch einen Ersatz. Erst ein lokaler, autorisierter Wechsel kann eine
Stille- oder Slate-Quelle einsetzen. Der Besitzer der Composition beendet alte
Forks erst nach erfolgreichem Ersatz.

## Simulcast

Das strikte Runtime-Profil kann die festen Kamera-RIDs `q`, `h` und `f`
einschalten. RID, Aktivität, Bitrate, FPS und Skalierung werden geschlossen und
begrenzt geprüft, bevor sie als `sendEncodings` in den Kamera-Transceiver
gelangen. Die Sendersteuerung verteilt ihr Gesamtbudget gewichtet über die
Layer und überschreitet weder die Program-Obergrenze noch die je Layer
konfigurierte Grenze. Sie erfindet aus einem Single-Layer-Stream keine weiteren
Layer.

Simulcast bleibt default-aus. Das reale `mediamtx-1.20`-Profil lehnt eine
Aktivierung bereits beim Serverstart ab, weil dieser konkrete Adapter dafür
noch keinen bestandenen Interoperabilitätsnachweis besitzt. Ein anderer,
strikt-RFC-konformer Gateway darf es erst nach seinem eigenen Live-Gate
aktivieren.

## Gedämpfte Stats-Adaption

Alle zwei Sekunden liest ein isolierter Controller ausschließlich technische
`RTCPeerConnection.getStats()`-Werte:

- Delta aus gesendeten Bytes und Frames,
- Delta aus gesendeten und als verloren gemeldeten Paketen,
- RTT der Remote-Inbound-/ausgewählten Candidate-Pair-Reports,
- verfügbare ausgehende Bitrate,
- Encoderzeit relativ zum Sampleintervall.

Eine einzelne Schwankung ändert nichts. Erst drei aufeinanderfolgende schlechte
Samples reduzieren `high → medium → low`; Recovery braucht fünf gute Samples.
Zwischen Übergängen liegen mindestens zehn Sekunden. Schlechte Schwellen sind
8 % Paketverlust, 350 ms RTT, 80 % Encoderzeit oder fehlender
Bandbreiten-Headroom. Recovery verlangt höchstens 2,5 %, 150 ms, 55 % und den
Headroom-Faktor 1,25. Bei messbarem Video-Traffic ohne neue Frames gilt das
Sample ebenfalls als schlecht. Unvollständige Reports sind `indeterminate` und
erzwingen keine Qualitätsänderung.

Die Stufen skalieren nur die vorhandenen harten Obergrenzen auf 100 %, 65 %
oder 35 %. Adaptionsfehler werden sichtbar, starten keine Endlosschleife und
heben keine Runtime-Grenze an. Der Timer ist pro Session besessen, verhindert
überlappende Samples und wird vor PeerConnection-DELETE beendet.

## Verifikation und ehrliche Grenze

Der deterministische Langzeittest durchläuft 360 Stats-Zyklen, sechs
`replaceTrack`-Wechsel und eine simulierte Verbindungsunterbrechung mit
begrenztem RFC-ICE-Restart. Mehr als 350 auswertbare Zyklen müssen fortlaufend
neue codierte Frames melden; Stop muss Timer, Listener und PeerConnection
freigeben.

Der reale MediaMTX-Gate zeichnet in Chromium und Firefox animierte
Canvas-Tracks auf, publiziert sie per WHIP, wechselt viermal zwischen Kamera-,
Bildschirm- und Slate-Profil und verlangt nach jedem Wechsel weiter steigende
`framesEncoded`-Werte. Er prüft außerdem POST, Trickle-PATCH, ICE und DELETE.
Der Netzwerk-Restart bleibt im `mediamtx-1.20`-Profil sichtbar unsupported,
weil dessen Wildcard-ETag keinen sicheren RFC-Restart erlaubt. Das ist keine
QoS- oder Dauerlaufgarantie für ein späteres Produktionsgateway; Last-, NAT-
und Chaos-Gates folgen separat.
