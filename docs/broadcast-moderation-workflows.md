# Broadcast-Regie, Quellenwiderruf und Packager-Handoff

Stand: 2026-09-04. Dieses Dokument beschreibt den implementierten TBP-030-
Zwischenstand. Die Domain- und Browsergrenzen sind implementiert und getestet;
die öffentliche Control-Plane-API, ein produktiver Native-Packager und reale
Accessibility-/Handoff-Gates fehlen noch. Deshalb zeigt die ausgelieferte
Angular-Ansicht die Regie, hält ihre mutierenden Schalter aber deaktiviert.

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

- persistente, OIDC- und Membership-gebundene Control-Plane-API sowie
  serverseitige Composition-Root,
- produktiver Native-Packager aus TBP-016 einschließlich Enrollment,
  Keystore, Receive-/Publish-Pfad und signierten Artefakten,
- vollständige Verdrahtung der sichtbaren Angular-Regie mit Serverzustand,
  Consent-Authority, Writer-Lease und Program-Compositor,
- echte Handoff-/Lease-Loss-/Netzunterbrechungstests mit zwei Geräten,
- manueller Tastatur-, Fokus-, Screenreader- und Mobile-Accessibility-Gate.

Bis diese Punkte bestehen, bleibt `[connected]="false"` die öffentliche
Voreinstellung. Weder der Sendestart noch eine Regieaktion wird simuliert.
