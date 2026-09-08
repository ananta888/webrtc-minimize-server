# Verzögerter Quellstart und gebundenes Keyframe-Feedback

Stand 2026-09-08, interner Anschluss TBP-030. Dieser Pfad ist in der echten
Browser-/SFrame-/FFmpeg-Fixture verbunden, nicht als öffentliche
Quellenannahme freigeschaltet. Der produktive Programm-Owner, gemeinsame
Ausgabetakt und Encoder-/Writer-Anschluss bleiben erforderlich.

## Start ohne blockierenden Medienempfang

Der Source-Transport ruft `WriteEncoded` unter seinem Frame-Lock auf. Dort
darf kein FFmpeg-Prozess gestartet oder auf dessen Ende gewartet werden.
`sourceLazyDecoder` prüft stattdessen zuerst Quelle, Codec, Framegrenzen,
RTP-Fortschritt und die bereits gebundene Sender-Report-Clock.

Vor einer gültigen Zuordnung aus mindestens zwei Reports werden Frames
verworfen: kein Decoder, kein Klartext-Warmup und keine Reservierung. VP8
benötigt zusätzlich einen gültigen Keyframe; bei einer Folge ausschließlich
von Deltaframes kann der gebundene Feedbackport einen neuen anfordern.
Audio verwendet ausdrücklich den adaptiven 48-kHz-Clockmodus, Video den
festen 90-kHz-Modus. Dies ändert keine Source-/Membership- oder Schlüsselrechte.

Sobald Start möglich ist, reserviert ein codecgebundener `sourcePendingDecoder`
den vorhandenen Prozess-/Medienposten. Erst danach kopiert der Lazy-Sink
höchstens einen Startframe. Ein dedizierter Worker führt den Prozessstart
aus; der Transport kann sofort weiterlaufen. Währenddessen werden zusätzliche
Frames verworfen und eine entstandene Lücke vermerkt, statt eine zweite,
unbegrenzte Startqueue anzulegen.

Gab es während des VP8-Starts eine Lücke, wird der gehaltene Initialframe
gelöscht und der Decoder erhält erst einen anschließend eintreffenden
Keyframe. Deltaframes mit möglicherweise fehlenden Referenzen werden nicht
weitergegeben. Ohne Lücke wird der gehaltene Keyframe an die begrenzte
Decoderqueue übergeben und unmittelbar gelöscht. Audio behält seine echten
RTP-Zeiten einschließlich ausgelassener Startintervalle; es bekommt keine
erfundenen Ankunftszeitstempel.

## Eine Reservierung, zwei Lebensdauern

Pending-Start und Codec halten denselben Budgetposten mit höchstens zwei
lokalen Handles. Dadurch bleibt die Kapazität belegt, bis sowohl der Warmup
gelöscht als auch der Prozess vollständig aufgeräumt ist. Ein sofortiger
Prozessausfall oder ein abgelehnter Start darf den noch gehaltenen Startframe
nicht aus der Buchhaltung verschwinden lassen. Es entstehen weder ein zweiter
Prozessplatz noch zusätzliche erlaubte Medienbytes.

Der Pending-Start ist einmalig: paralleler/doppelter Start wird abgewiesen;
Abort vor dem Start verhindert ihn. Danach besitzt der Startworker den
Prozess-Handle, während der Source-Owner den Warmup löschen kann. Die alten
unmittelbaren Decoderkonstruktoren benutzen denselben Vorbereitungspfad und
geben ihren nicht benötigten Warmup-Hold direkt beim Konstruktorende zurück.

Eine unabhängige 50-ms-Überwachung prüft Quelle und Clock auch während eines
verzögerten Starts. Eine zwölfsekündige Startupfrist begrenzt das Warten vor
Aktivierung. Widerruf löscht den Startframe, sperrt Ausgabe und schließt die
Clock sofort auf dem lokalen Close-Pfad. Ein später zurückkehrender Start
wird geschlossen und abgeholt, bevor `finished` gemeldet wird. Dies verspricht
keine feste Dauer eines Betriebssystem-Exec-Systemaufrufs; ein noch laufender
Start bleibt sichtbar angerechnet und wird nicht fälschlich als beendet gewertet.

## Feedback bleibt beim Transport

Der Sink erhält einen parameterlosen Keyframe-Anfrageport. Er kann weder
Peer, SSRC noch Paketinhalt bestimmen. Erst nach erfolgreicher OnTrack-Prüfung
bindet der Transport ihn an genau diese VP8-SSRC und PeerConnection; Audio
erhält keinen solchen Port.

Anfragen werden in einer Queue mit einem wartenden Eintrag zusammengefasst
und höchstens einmal je Sekunde angenommen. Ein separater Sender prüft erneut
die aktuelle Source-Policy. Auch zwischen abgeschlossenen RTCP-Schreibaufrufen
liegt mindestens eine Sekunde, damit eine blockierte Ausgabe keinen späteren
Burst verursacht. Er sendet ausschließlich PLI an die verifizierte SSRC.
Rücksprünge der Anfragezeit, Floods und geschlossene Generationen werden
abgewiesen. Transport-Close beendet die Verbindung und wartet auch auf diesen
Worker. Eine Anfrage ist keine Garantie für den Empfang eines Keyframes.

## Prüfbare Grenzen

Unit- und Race-Tests prüfen unbekannte Clock vor Reservierung, Keyframepflicht,
Startlücken, Widerruf während verzögertem Start, gelöschten Warmup, fortlaufende
Budgethaltung, frühes Reaping, einmaligen Start, fehlerhafte Eingaben sowie
die unabhängige Überwachung. Der echte Pion-Quelltest empfängt PLI am Sender,
vergleicht die tatsächliche SSRC, verweigert Floods und prüft den verbrauchten
Port nach Quellenende; der Audiofall darf keinen Video-Feedbackport erhalten.

Die gepaarte Browserfixture verwendet nun für beide tatsächlichen SFrame-
Quellverbindungen die Lazy-Decoder, einschließlich VP8-/Opus-Decodierung,
PCM-Resampling und A/V-Impulsprüfung. Die vorhandene 150-ms-Grenze und die
Prüfung von mindestens sechs eindeutigen Impulspaaren bleiben unverändert.
Konkrete Stand-/Testnachweise stehen im Todo; externe Skips sind keine
Produktionsabnahme. Der Gesamtumfang des Broadcast-Packagers bleibt offen.
