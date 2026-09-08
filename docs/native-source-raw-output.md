# Begrenzter PCM-/RGBA-Ausgang des nativen Programms

Interner TBP-030-Anschluss, Stand 2026-09-08. `sourceProgramRaw` implementiert
den kleinen `sourceProgramOutput`-Port. Er verbindet den Programmtakt mit zwei
lokalen, abbrechbaren Schreibpipes. Er startet keinen Encoder, öffnet keine
Capturequelle und verändert weder den bestehenden IVF-/Ogg-Ingress noch die
produktive Source-Factory.

## Pufferbesitz und Zeit

Audio erhält eine feste Queue mit 2–16 Blöcken à 960 PCM16LE-Stereosamples,
Video 2–8 RGBA-Frames bis Full HD. Die Bytequote wird vor Allokation geprüft:
`audioFrames * 3840 + videoFrames * width * height * 4`, maximal 128 MiB und
höchstens das ausdrücklich konfigurierte Budget. Aktuell geschriebene Frames
zählen gegen dieselbe Quote; es existiert kein zusätzlicher aktiver Medienpuffer.
Guard-/Slot-/Channel-Metadaten sind fest durch dieselben Slotgrenzen beschränkt.
Die Quote ist kein RSS-, Encoder-, Kernel-Pipe- oder CPU-Limit.

Der Handoff kopiert nur in einen freien vorallokierten Slot und führt keine
Pipe-I/O aus. Audio muss die exakte fortlaufende 48-kHz-/960-Sample-Folge
liefern, Video die rational berechneten Termine seines 1–60-FPS-Profils.
Szenenrevisionen müssen gültig und nicht rückläufig sein. Queuevoll, falsche
Größe, Zeit oder Revision beenden den Ausgang; Frames werden nicht heimlich
verworfen oder mit falscher Zeit erneut beschriftet.

Zwei unabhängige Schreiber entkoppeln Audio und Video. Ein unvollständiger
Write wird als Rest desselben Rawframes fortgesetzt, mit erneuter Quellen-
und Writerprüfung. Nullfortschritt und Pipefehler sind terminal. Ein Watchdog
prüft alle 10 ms Quelle, Writer und das konfigurierte Write-Limit von 100 ms
bis zwei Sekunden. Dies ist keine harte Echtzeitgarantie des Betriebssystems.

## Widerruf und Abbruchgrenze

Jeder wartende Slot behält seinen `sourceRenderGuard`. Beim Einreihen, während
der laufenden Queueprüfung und unmittelbar vor Übergabe an den Schreiber
werden ungültige Quellenbeiträge durch einen ganzen Stilleblock oder ein
vollständiges Ersatzbild ersetzt. Andere bereits gültige Frames können weiter
ausgegeben werden. Ein einzelner bereits gemischter Frame kann nicht nachträglich
in seine Beiträge zerlegt werden; deshalb wird dieser ganze Frame ersetzt.

Ein aktiver Schreiber besitzt seine Bytes exklusiv. Niemand überschreibt sie
parallel zum Pipe-Write. Wird dessen Quelle während des Writes widerrufen,
endet der gesamte Ausgang. Der geforderte `abort`-Callback muss zuerst den
Encoder und dessen veröffentlichbaren Output invalidieren; danach werden die
beiden Pipes geschlossen, um blockierende Writes zu unterbrechen. Ein halber
Rawframe wird niemals durch ein neu begonnenes Ersatzbild vervollständigt.
Bereits autorisiert ausgegebene Bytes sind nicht rückrufbar.

`Close` widerruft synchron und wischt wartende Slots, führt aber selbst keine
Pipe-I/O unter aufrufenden Mixerlocks aus. Ein eigener Stop-Worker ruft genau
einmal den begrenzten Abort-Callback und die abbrechbaren Pipe-Closes auf.
Aktive Bytes werden erst nach Schreiberende gelöscht; `finished` wartet auf
alle Worker, löscht verbleibende Puffer und gibt deren Referenzen frei. Es
beweist **nicht** das Reaping eines externen Encoderprozesses. Dessen Owner
muss zusätzlich auf sein tatsächliches Prozessende warten.

## Nachweis und verbleibender Anschluss

Gezielte Tests decken Konfiguration/Bytebudget, Zeit-/Revisions-/Queuegrenzen,
Teilwrites, Writer-/Source-Widerruf, blockierende Writer, Pufferlöschung und
beide Mixer über den Programmtakt in echte OS-Pipes ab. Ein real blockierter
Full-HD-Video-Pipe verhindert die Ausgabe von PCM über den anderen Pipe nicht.
Die Matrix bestand dreimal unter Race-Erkennung (3,644 Sekunden) plus Go vet.
Danach wurde nur der Testleser auf begrenzten, durch Reader-Close abbrechbaren
Read umgestellt, um keine plattformübergreifende Unterstützung von
`SetReadDeadline` für anonyme Pipes vorauszusetzen. Auch dieser finale Stand
bestand die dreifache Race-Matrix (3,735 Sekunden) und Go vet. Der gemeinsame
Gesamtcheck folgt; physische Windows-/macOS-Läufe sind hierdurch nicht bewiesen.

Noch zu verbinden sind der feste Raw-FFmpeg-Encoder mit Ausgabe-/Prozessfence,
der gemeinsame produktive Programm-Owner und dessen Wiederanlauf mit Stille/
Ersatzbild nach einem notwendigen In-flight-Abbruch. Ein leerer Guard ist keine
Writer-Berechtigung; ein Dummy-Abort ist ausschließlich eine Testfixture und
kein produktiver Sicherheitsmechanismus. Fremdquellenannahme und öffentliche
Approve-/Renew-Workflows bleiben bis zu diesem durchgängigen Anschluss aus.
