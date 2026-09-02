# Raumgebundene Mesh-Analyse

Die Angular-App besitzt im Hauptmenü die Ansicht **Analyse**. Sie visualisiert
ausschließlich die aktuelle, bereits serverautorisierte Room-Membership und die
validierten Trusted-Relay- beziehungsweise Media-Agent-Routen. Die Ansicht ist
beobachtend: Telemetrie kann weder Teilnehmer, Routen, Consent noch
Medienautorität erzeugen.

## Darstellung

- Runde Knoten sind Browser-Teilnehmer, eckige Knoten native Media-Agenten.
- Eine normale Kante ist die isolierte PeerConnection zwischen zwei Browsern.
- Orange Kanten markieren mindestens eine serverautorisierte
  Trusted-Video-Relay-Route über dieses Browserpaar.
- Grüne Kanten verbinden Browser mit ihrem autorisierten Ingress- oder
  Egress-Agenten. Violette Kanten sind validierte Agent-Agent-Föderationslinks.
- Das Label über einer Kante ist die beobachtete Summe beider Richtungen und
  wechselt dezimal automatisch zwischen `kbit/s` und `Mbit/s`.
- Kanten ohne Nutzdaten sind standardmäßig ausgeblendet. Autorisierte Relay-
  und Agentkanten bleiben sichtbar; `–` bedeutet, dass dieser Browser dort
  keine Rate beobachten kann. Insbesondere erfindet die App keine Rate für
  Agent-Agent-Verbindungen.

Ein Klick beziehungsweise `Enter` oder die Leertaste auf einem Knoten öffnet
dessen Textdetails. Neben Status, Rolle, kurzlebiger ID, ICE-/Linkklasse,
Freigaben und Epochen werden Upload und Download getrennt für Gesamtverkehr,
Audio, Kamera/Video, Bildschirmfreigabe und DataChannel angezeigt. Bildschirmton
zählt zu Audio. Die Browserzuordnung von Kamera und Bildschirm verwendet den
standardisierten RTP-`trackIdentifier` und die bereits bekannte lokale oder
signalisierte Publication-Quelle.

## Messfenster und Grenzen

Der schon für die adaptive Qualität verwendete `RTCPeerConnection.getStats()`-
Lauf liest ungefähr alle zwei Sekunden kumulative Bytezähler. Für die
Gesamtrate wird bevorzugt das ausgewählte ICE-Candidate-Pair genutzt, danach der
Transport- und zuletzt der summierte RTP-/DataChannel-Zähler. Audio, Kamera,
Bildschirm und DataChannel werden aus den zugehörigen Einzelreports abgeleitet.
Die Anzeige ist deshalb eine kurze Näherung, kein abrechnungsfähiger Zähler und
keine QoS-Garantie. DTLS/SRTP-, RTP-, ICE- und Netzwerk-Overhead kann in der
Gesamtrate enthalten sein, ohne einer Inhaltszeile zugeordnet zu werden.

Negative Deltas, Zähler-Resets, Intervalle unter 250 Millisekunden oder über 15
Sekunden werden nicht als Rate verwendet. Einzelwerte sind auf 1 Gbit/s
begrenzt. Die erste Stichprobe bildet nur die Baseline.

Vollständige Raumtelemetrie wird nicht permanent an alle Teilnehmer verteilt:
Beim sichtbaren Öffnen der Analyse sendet der Browser über den bereits
vorhandenen Control-DataChannel ein Interesse. Nur an solche interessierten
Raum-Peers wird höchstens alle sechs Sekunden eine Momentaufnahme geschickt.
Beim Schließen wird das Interesse widerrufen. Der geschlossene Vertrag erlaubt
höchstens 22 Links, exakt zehn ganzzahlige Raten pro Link und insgesamt 4096
Bytes; Annahmen erfolgen höchstens einmal pro Sekunde und verfallen nach 15
Sekunden. Unbekannte Felder, IDs, Duplikate, Zieltypen, Raten oder Sequenzen
werden verworfen.

Die Telemetrie bleibt flüchtig in den Browsern und läuft nicht über die
Signaling-Control-Plane. Übertragen werden nur kurzlebige Peer-/Agent-IDs und
aggregierte Raten. IP-Adressen, ICE-Kandidaten, SDP, OIDC-Tokens, SFrame-Schlüssel
und Medieninhalte gehören nicht zum Vertrag. Angaben anderer Browser sind für
die Darstellung als `Peer-gemeldet` markiert und werden nicht als vertrauenswürdige
Policy-Eingabe verwendet.

Das Öffnen der Ansicht startet keine Capture-API. Mikrofon, Kamera und
Bildschirm bleiben ausschließlich an ihre sichtbaren lokalen Startschaltflächen
gebunden.
