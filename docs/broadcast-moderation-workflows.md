# Broadcast-Regie, Quellenwiderruf und Packager-Handoff

Stand: 2026-09-06. Dieses Dokument beschreibt den TBP-030-Zwischenstand.
Die Domainpolicy für serverseitige Moderation ist vorbereitet, aber noch nicht
an eine öffentliche Moderations-API angeschlossen. Der native Packager besitzt
inzwischen einen realen Enrollment-/Publish-/Playback-Pfad. Eine laufende
Own-Source-Komposition lässt sich über einen getrennten lokalen Bildregie-Port
steuern; Fremdquellenmoderation, Standby und echtes Writer-Handoff bleiben offen.

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
