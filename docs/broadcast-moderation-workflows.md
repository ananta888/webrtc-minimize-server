# Broadcast-Regie, Quellenwiderruf und Packager-Handoff

Stand: 2026-09-06. Dieses Dokument beschreibt den TBP-030-Zwischenstand.
Die Domainpolicy für serverseitige Moderation ist vorbereitet, aber noch nicht
an eine öffentliche Moderations-API angeschlossen. Der native Packager besitzt
inzwischen einen realen Enrollment-/Publish-/Playback-Pfad. Eine laufende
Own-Source-Komposition lässt sich über einen getrennten lokalen Bildregie-Port
steuern. Für eigenes natives Publishing ist die unten beschriebene serverseitige
Same-Program-Übergabe angeschlossen. Angular-Übergabedialog, Player-Neustart,
Fremdquellenmoderation und Standby bleiben offen.

## Angeschlossene native Übergabe-API

`POST /api/broadcasts/:programId/native-handoff-control` liefert dem aktuellen
Owner-Gerät den geschlossenen Programm-/Writer-Snapshot. Der Body enthält nur
`requestVersion: 1` und den Fingerprint des bereits P-256-geprüften Raumgeräts.
`POST /api/broadcasts/:programId/native-handoffs` bindet die ausdrücklich
angeforderte Übernahme an diesen Snapshot: `expectedProgramRevision`,
`expectedProgramEpoch`, `expectedFencingRevision`, Ziel-`packagerId`,
`requestedRenditions`, `allowHardwareAcceleration`, `deviceFingerprint`,
`requestVersion: 1` und `trigger: "user-action"`. Der JSON-Schema-Vertrag liegt
unter `contracts/native-packager/handoff.v1.schema.json`.

Beide Routen benötigen OIDC, den exakten Origin und aktive Creator-Membership
derselben Browser-Peer-/Gerätebindung wie die laufende native Publikation.
Zielgerät, Kontobindung, Room-Consent, Health, Capability und freie Kapazität
werden vor dem Eingriff und unmittelbar vor Nachfolgeraktivierung geprüft.

Der `output-restart`-Befehl erhält Programm-ID, Titel, Quellen und Audience.
Er erhöht ausdrücklich Broadcast-/Lease-Epoch, entzieht alle alten Writer und
Grants und weist eine noch nie verwendete opaque Ausgabe-Ressource zu. Alte
HLS-Init-/Segment-URLs werden nicht wiederverwendet. Dann sendet ausschließlich
der Server `assignment-stop` und wartet maximal zwölf Sekunden auf den echten
terminalen `stopped`-ACK. `failed`, Disconnect oder ein verschwundener Eintrag
zählen nicht als bestätigter Stop. Erst danach entsteht ein neues Assignment.
Ein internes, nicht serialisiertes Fortsetzungsobjekt verhindert doppelte oder
gefälschte Abschlüsse. Abort, Deadline, Membership-/Consentverlust und
Zustellfehler enden ohne verspäteten Nachfolgerstart; nach bereits begonnener
Umstellung bleibt die Sendung sichtbar beendet statt unbemerkt zurückzufallen.
Der Abschluss bindet außerdem die exakte vorbereitete Revision, Epoch und
Ausgabe. Das Drain-Budget verwendet zusätzlich eine monotone Uhr. Vor dem
Eingriff werden genügend Plätze im begrenzten Command-Ledger für Nachfolger,
Readiness und terminalen Cleanup reserviert; bei Erschöpfung wird eine weitere
Übergabe abgewiesen, während der laufende Writer noch regulär stoppbar bleibt.
Die Ownership-Prüfung erfolgt vor jedem Blick auf fremden Assignment-State,
sodass private Programme nicht über unterschiedliche Übergabefehler aufgezählt
werden können.

Lokale HTTP-/WebSocket-Tests mit zwei getrennten P-256-Packagern belegen diese
Reihenfolge und einen abgebrochenen HTTP-Aufruf mit verspätetem Stop-ACK.
Ein separater Test prüft den Widerruf eines tatsächlich signierten Playback-
Grants vor Nachfolgeraktivierung. Das ist noch **kein** Nachweis dekodierbarer
Medien über die Übergabe: Der neue Origin-Pfad, Browser-Publikationswechsel,
bewusste UI-Bestätigung und kontrollierte Player-Reautorisierung/-Neustart
müssen noch zusammen angeschlossen und real geprüft werden. Insbesondere
ist ein Agent auf einem beliebigen anderen Host nicht allein durch seine
Registrierung an den aktuell konfigurierten HLS-Origin angebunden.

## Bereits angeschlossene lokale Bildregie

Während einer aktiven Own-Source-Sendung zeigt die Angular-Regie die bereits
freigegebenen eigenen Videoquellen. „Layout sofort anwenden“ wechselt zwischen
allen sieben Layouts. Einzel-/Sprecheransicht erlauben die manuelle Hauptquelle;
eine automatische Sprechererkennung wird nicht behauptet. Der lokale Klick
ändert ausschließlich die Darstellung der bestehenden Komposition, nicht ihre
Quellfreigaben, Writer-Zuordnung oder Ausgabeprofile.

Kompositions-ID, vollständige Quellbindung und eine lokale Revision schützen vor
veralteten Befehlen. Stopp/Destroy entfernt das Angebot sofort. Es gibt keinen
erneuten Capture-Aufruf, Program-POST oder Wechsel der Sendertracks. Warte-/Endbild
ändert nur Video; Audio und Publikation laufen bis zum separaten Stopp weiter.
Der Broadcast-Zweig bleibt ausdrücklich ein Trusted-Packager-Pfad, kein blinder
SFrame-Relay. Siehe [Compositor und gemessene Gates](trusted-video-compositor.md).

Die folgenden Rollen-, Consent- und Handoff-Abschnitte beschreiben weiterhin die
vorbereitete, noch nicht vollständig produktiv verdrahtete Servermoderation.
Ihre Schalter bleiben getrennt von der lokalen Bildregie deaktiviert.

## Rollen und Bestätigung

- Owner und Moderator dürfen Quellen anfragen oder entfernen, Layout ändern,
  Packager und Standbys auswählen, Handoffs anstoßen und die Sendung beenden.
- Presenter dürfen nur ihre eigene Quelle veröffentlichen oder widerrufen.
- Packager erhalten ausschließlich die eng gebundene Writer-Operation; Viewer
  erhalten keine Regierechte.
- Jede UI-Aktion benötigt einen konkreten lokalen Klick und eine zweite,
  höchstens zwei Minuten gültige Bestätigung. Request und Bestätigung binden
  Tenant, Raum, Programm, Rolle, Subject, Programmrevision und Program-Epoche.
  Ein Handoff bindet zusätzlich die Lease-Epoche.
- Stale Revision, Program-Epoche oder Lease-Epoche ist ein sichtbarer Konflikt.
  Die UI darf die Aktion nicht still gegen einen neueren Stand wiederholen.

### Browser-/Server-Vertrag und begrenzter Lebenszyklus

Das lokale `targetLabel` bleibt ausschließlich im Bestätigungsdialog und wird
nicht in den geschlossenen Server-Envelope übernommen. Jede der acht Aktionen
erlaubt nur ihre eigenen Pflichtfelder. Snapshot und Adapterergebnis werden
ebenfalls typstreng und geschlossen geprüft; rückläufige Revisionen/Epochen
sind keine gültigen Ergebnisse. Ein gemeinsamer Vertragstest kompiliert den
tatsächlichen Browserworkflow und übergibt seine serialisierten Nachrichten an
die produktive Serverpolicy. Er beweist Vertragskompatibilität, keine bereits
angeschlossene HTTP-Route oder vollzogene Writer-Übergabe.

Es gibt genau eine aktive Aktion pro Workflow mit einem standardmäßig zehn
Sekunden langen Gesamtbudget einschließlich lokalem Quellenstopp. Beide Ports
erhalten dasselbe AbortSignal. Destroy beendet auch bei ignorierendem Adapter
die lokale Warteoperation und ist terminal; verspätete Antworten dürfen keine
Folgeaktion oder erfolgreiche UI-Rückmeldung erzeugen. Nach ausstehendem lokalen
Widerruf wird vor dem Netzwerk nochmals die Bestätigungsfrist geprüft.

Ein Timeout während des Serveraufrufs beweist **keinen** Rollback: Die zukünftige
HTTP-Anbindung muss den autoritativen Stand neu laden und für einen weiteren
Versuch eine neue Bestätigung verlangen. Sie darf einen unklaren Ausgang nicht
als erfolgreiche Rücknahme darstellen. Die lokale Safety-Implementierung muss
selbst synchron fencen und ihr Cleanup abbrechbar ausführen; das Zeitlimit dieses
Workflows kann einen fehlerhaften externen Adapter nicht rückwirkend stoppen.

## Sofortiger eigener Quellenwiderruf

Der lokale Sicherheitsport läuft vor dem Netzwerkaufruf. Dadurch bleibt der
Widerruf auch dann lokal wirksam, wenn die Control Plane gerade nicht erreichbar
ist. Der verbindliche Effektplan lautet:

1. Eingang der Quelle fencen und den lokalen Broadcast-Klon stoppen,
2. quellengebundenes Decrypt-Material widerrufen,
3. Decoder zerstören,
4. Compositor-Fläche vollständig löschen,
5. auf ein neutrales Slate wechseln oder das Layout ohne Quelle neu setzen,
6. verbleibende Quell-Grants widerrufen.

`retainLastDecodedFrame` ist immer `false`. Weder ein eingefrorener letzter
Frame noch ein versteckter Audiozweig darf nach dem Widerruf weiterlaufen.

## Native-Packager-Auswahl

Die Kandidatenpolicy akzeptiert höchstens 16 aktuelle Capability-Reports und
filtert vor der Auswahl:

- exakt denselben Tenant und denselben Kontoinhaber,
- expliziten Consent für genau den aktuellen Raum,
- Operator-Allowlist,
- `healthy`, ausreichende Uploadklasse und die verlangte Energieklasse,
- AAC plus `libx264` als Software-Fallback,
- CPU-, Pixel-, Rendition- und optionale Hardwareencoder-Grenzen.

Regie und Kandidatenpolicy akzeptieren die tatsächlich registrierten
`pkr_…`-Geräte-IDs sowie kompatibel die bisherigen kurzen Agent-Slugs.
Ein passendes ID-Format allein verleiht keine Freigabe: Owner, Tenant, Raum,
Consent, Operatorpolicy und Capability müssen weiterhin übereinstimmen.
Array-Coercion ist verboten; die nächste Fencing-Revision darf den sicheren
Ganzzahlbereich nicht überschreiten.

Aus den verbleibenden Kandidaten wird genau ein aktiver Writer gewählt. Er
erhält die nächste Fencing-Revision und darf nach separatem Quellenconsent die
nötigen Decrypt-Schlüssel erhalten. Höchstens zwei Standbys werden als
`warm-no-media-key` geführt und erhalten keine Decrypt-Schlüssel. Der Schritt
ist eine Trusted-Packager-Policy und verwendet ausdrücklich nicht die bereits
installierten blinden Media-/Relay-Agenten.

## Inhaltsfreies Audit

Das begrenzte Audit hält höchstens 256 Datensätze mit Aktion, pseudonymen
Tenant-/Room-/Program-/Subject-Referenzen, erwarteter Revision/Epoche, Ergebnis,
Fehlercode und Zeitpunkt. Namen, Labels, SDP/ICE, Captions, Schlüssel,
Audio-/Videodaten und Nutzinhalte gehören nicht hinein.
Referenzen, Revisionen, Zeit und Fehlercode werden vor Aufnahme typstreng und
längenbegrenzt geprüft. Unbekannte/prototypgeerbte Aktionen, Array-Coercion oder
Rohtext als Identität erzeugen keinen Auditdatensatz; zusätzliche lokale Labels
und Nutzlastfelder werden nicht übernommen. Die künftige HTTP-Anbindung darf
abgewiesene Rohrequests nicht ungeprüft als Auditereignisse weiterreichen.

## Noch offene Gates

- OIDC- und Membership-gebundene Moderations-API sowie serverseitige
  Composition-Root; Raum-/Medienzustand bleibt flüchtig,
- verbleibende Plattform-/Keystore-/Betriebsgates aus TBP-016; Enrollment und
  nativer Publish-/Playback-Pfad sind bereits separat implementiert und getestet,
- vollständige Verdrahtung der serverseitigen Angular-Regie mit Serverzustand,
  Consent-Authority, Writer-Lease und Program-Compositor,
- echte Handoff-/Lease-Loss-/Netzunterbrechungstests mit zwei Geräten,
- manueller Tastatur-, Fokus-, Screenreader- und Mobile-Accessibility-Gate.

Bis diese Punkte bestehen, bleibt `[connected]="false"` für die Servermoderation
die öffentliche Voreinstellung. Die unabhängig angebundene lokale Bildregie
meldet ausdrücklich „Lokale Bildregie bereit“, nicht „Control Plane verbunden“.
Weder Sendestart noch Regieaktion werden simuliert; ein Stop mit Neuanlage gilt
nicht als vollständiges Writer-Handoff.
