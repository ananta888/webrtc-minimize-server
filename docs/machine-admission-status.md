# Ananta-Betreiberstatus in Analyse

Die Anzeige **Analyse → Ananta · Freigaben meiner Quellen → Betreiberstatus**
liest den vorhandenen öffentlichen `/api/machine/capabilities`-Vertrag.
Sie unterscheidet ausgeschaltete und eingeschaltete Maschinenaufnahme von
fehlgeschlagenen, unbekannten und veralteten Antworten. Sie verändert weder
Trust noch Projektpolicy und startet keine KI, PeerConnection oder Aufnahme.

Eingeschaltet bedeutet ausdrücklich **nicht**, dass der Hub erreichbar ist,
ein Worker läuft oder Inhalte verarbeitet werden. Die darunterliegenden
Publisherfreigaben und beobachteten Remote-Tracks bleiben getrennte Anzeigen.
Die alten Medienbooleans des MP4-Vertrags werden nicht als Aussage über die
neueren Audio-/Chat-/Bildschirmports umgedeutet. Deren rein lesender Browser-
Capability-Probe bleibt eine eigene Schnittstelle.

Beim Öffnen erfolgt genau eine anonyme Same-Origin-GET-Abfrage; weitere nur
über „Betreiberstatus aktualisieren“. Es werden keine Cookies/Token gesendet,
Redirects abgelehnt und Antworten auf 2 KiB sowie fünf Sekunden einschließlich
Body begrenzt. Nach 30 Sekunden gilt die Anzeige als veraltet; kein Polling und
keine automatische Autorisierung. Fehler entfernen den früheren Status.
Beim Schließen werden ausstehende Anfrage und Timer abgebrochen; verspätete
Ergebnisse können die Anzeige nicht reaktivieren. Eine aktive Quellenfreigabe
wird durch diesen rein informativen HTTP-Status weder erweitert noch widerrufen.

Die produktive Aktivierung benötigt weiterhin ein ausdrücklich freigegebenes
öffentliches Hub-Trustprofil und den passenden Ananta-Projektauftrag. Keine
privaten Schlüssel hierher übertragen. Konfiguration und Grenzen stehen in
[Maschinen-Deployment](machine-production-compose.md) und
[gestufter Aktivierung](machine-rollout.md).

## Prüfungen

Die Service-Suite prüft exakte Vertragsform, ausgeschaltet/eingeschaltet,
HTTP-/Redirect-/Typ-/Längen-/UTF-8-/JSON-Fehler, Streaming-Oversize, einen
hängenden Body, nicht kooperatives Fetch, parallele Aufrufe, Ablauf und Destroy.
Der Browser-Gate prüft die reale TLS-Serverantwort, danach kontrollierte
UI-Fehlerantworten, Tastaturbedienung sowie unveränderte Capture-/Connection-
Zähler und Membership in Chromium und Firefox. Die Fehlerantworten sind keine
produktiven Truständerungen. Der vorhandene gemeinsame Audio-/Chat-/Screen-
und Drei-Renewal-Dialog bleibt die getrennte Medienregression.

Am 8. September 2026 bestanden 15 neue Serviceprüfungen plus zehn bestehende
Freigabeprüfungen sowie der Angular-Typcheck. Die neue Ansicht wird getrennt
nachgeladen; der Produktionsbuild hält das unveränderte harte Größenbudget ein
(die bestehende Warnschwelle bleibt überschritten). Der korrigierte Browser-Gate
bestand in Chromium (1,627 s) und Firefox (2,884 s): Sein erster Lauf suchte
die Teilnehmeranzeige fälschlich in Analyse statt nach Rückkehr zu Live.
Diese Testnavigation wurde korrigiert, nicht die Membership-Logik geändert.
Die separate Dialogregression bestand ebenfalls in beiden Browsern
(12,874 / 14,540 s), mit jeweils 16.000 PCM-Samples, korrelierter Chatantwort,
bewegten Remote-Pixeln, drei Renewals und anschließendem Rechteentzug.
Required-SFrame war aktiv, keine Transformfehler wurden beobachtet.
Der isolierte gemeinsame `npm run check` auf Basis von `5fb5172` einschließlich
dieser Ananta-Änderungen bestand mit Exit 0: 713 Frontendtests, 778 erfolgreiche
Nodeprüfungen, null Fehler und zwei explizite Node-Skips (Node 326,095 s).
Build, Go-Unit/Vet und statische Sicherheits-/Konfigurationsgates bestanden.
Die 14 externen Infrastruktur-Gates und der optionale Container-Image-Scan
blieben ausdrücklich übersprungen. Unveröffentlichte Packager-Änderungen
gehörten nicht zu diesem isolierten Kandidaten. Der lokale Serving-Build blieb
unverändert. Commit-/Remote-CI-/Deployment-Evidence ist davon getrennt.
