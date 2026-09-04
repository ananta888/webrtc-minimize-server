# Quellengebundener Trusted-Decrypt-Consent

Stand: 2026-09-04, Implementierungsstufe `TBP-013`.

Ein Trusted-Packager ist ein absichtlich vertrauenswürdiger Medienendpunkt. Er
ist weder ein Blind-Agent noch ein allgemeiner Raum-Relay. Der Status als
Raumersteller, Agentenbesitzer oder aktueller Packager erteilt allein keine
Entschlüsselungsberechtigung. Jede fremde Quelle benötigt eine eigene,
sichtbar ausgelöste und kurzlebige Freigabe.

## Autoritäts- und Datenfluss

```text
Publisher-UI -- sichtbarer Klick --> Control Plane: Consent-Metadaten
Control Plane -- geprüfter Consent --> Publisher und bestimmter Packager
Packager -- öffentliche ephemere P-256-Kennung --> Publisher
Publisher -- ECDH/AES-GCM-verpackter SFrame-Basisschlüssel --> Data Overlay
Blind-Agent/Overlay-Relay -- nur Ciphertext --> bestimmter Packager
Packager -- Schlüssel nur in SFrame-Worker --> Trusted Program Composition
```

Die Control Plane prüft Identität, aktuelle Room-Membership, Rolle,
Geräteregistrierung, Program-/Room-Epoch und den aktiven Packager-Lease. Sie
besitzt nur Consent-, Status- und Audit-Metadaten. SFrame-Schlüssel,
Key-Envelopes und Medienpakete laufen nicht durch Node-HTTP, Signaling-Logs oder
allgemeine Metriken.

Der vorhandene zielpeergebundene Data-Overlay ist der Transport für das
Key-Envelope. Seine Zwischenpeers besitzen keinen Decrypt-Port. Das Envelope
ist zusätzlich selbst für das konkrete Packager-Gerät verschlüsselt, damit
auch ein Fehlrouting oder ein kompromittierter anderer Endpeer keinen
SFrame-Basisschlüssel offenlegt.

## Geschlossene Consent-Bindung

Eine Freigabe bindet genau diese Felder:

| Feld | Bedeutung |
|---|---|
| `trigger=user-action` | nur ein sichtbarer lokaler Klick darf freigeben |
| `tenantId`, `roomId`, `roomEpoch` | aktueller OIDC-Tenant und Raumzyklus |
| `programId`, `programEpoch` | genau eine Broadcast-Ausgabe |
| `grantorSubjectRef` | Besitzer der veröffentlichten Quelle |
| `granteePackagerRef`, `granteeDeviceRef` | konkreter Packager und konkretes registriertes Gerät |
| `sourceId`, `sourceKind` | genau eine Audio-, Kamera- oder Bildschirmquelle |
| `purpose=broadcast-program` | weder Recording noch allgemeine Wiederverwendung |
| `grantedAt`, `expiresAt` | höchstens zehn Minuten, anschließend neue Nutzerentscheidung |

Mehrere Quellen benötigen mehrere Consent-Objekte. Eine bestehende Freigabe
kann nicht um eine weitere Source-ID oder Medienart ergänzt werden. Das macht
die tatsächlich lesbaren Quellen in UI, Audit und Widerruf eindeutig.

## Schlüsselprotokoll

`TrustedDecryptKeyLifecycle` erzeugt für jeden Consent ein eigenes ephemeres
P-256-ECDH-Schlüsselpaar. Der private Schlüssel ist nicht exportierbar. Die
öffentliche Ankündigung ist an Consent, Packager, Gerät, Raum und beide Epochen
gebunden. Der Publisher erzeugt ebenfalls einen nicht exportierbaren
ephemeren ECDH-Schlüssel und leitet daraus einen AES-256-GCM-Wrapping-Key ab.

Authentifiziert werden Envelope-ID, Consent, Tenant, Raum, Room-Epoch,
Programm, Program-Epoch, Grantor, Ziel-Packager, Zielgerät, Source-ID,
Medienart, Zweck, SFrame-Key-ID, `codec-prefix-v1`, Agreement-Key-ID und beide
Zeitpunkte. Das 16-Byte-SFrame-Basismaterial liegt ausschließlich im
Ciphertext. Das Envelope ist auf 8 KiB und 60 Sekunden begrenzt. Jede
Envelope-ID ist je Consent einmalig; ein Replay wird verworfen.

Beim Öffnen wird das Basismaterial direkt an den SFrame-Worker-Installationsport
übergeben und der temporäre JavaScript-Puffer anschließend überschrieben. Der
Lifecycle speichert keine Rohschlüssel. Die WebCrypto- und Worker-Schlüssel
sind dennoch Prozessspeicher des ausdrücklich vertrauten Packagers; Browser-
oder Betriebssystemkompromittierung dieses Geräts bleibt außerhalb des
kryptografischen Versprechens.

## Widerruf und Zustände

Folgende Ereignisse räumen alle dem Consent zugeordneten SFrame-Kontexte und
die nicht exportierbare ECDH-Referenz idempotent auf:

- manueller Widerruf oder Ablauf,
- Wechsel des Packager-Geräts oder Verlust seines Lease,
- Program-Epoch-Wechsel oder Handoff,
- Room-Epoch-Wechsel,
- Quellenende, Leave, Logout, Room-Ende und Component-Destroy.

Nach dem Widerruf stoppt der Packager die betroffene Programquelle. Bereits
von ihm decodierte Medien können technisch nicht rückwirkend ungeschehen
gemacht werden; ein kompromittierter Trusted-Packager ist daher ausdrücklich
Teil der Vertrauensgrenze.

## UI- und Audit-Vertrag

Vor Zustimmung zeigt die UI Programmtitel, Packager-Anzeigename und Gerät,
Quellenart, Zweck, Ablauf sowie den Verlust der Raum-E2EE für genau diese
Broadcast-Quelle. Checkboxen, Panel-Öffnen, Raumerstellerstatus, Handoff oder
Remote-Nachrichten dürfen nicht zustimmen. Der Nutzer kann jede Quelle einzeln
widerrufen. Die laufende Ansicht zeigt `wartet`, `aktiv`, `läuft ab`,
`widerrufen` oder `Packager gewechselt` und stoppt eine nicht mehr autorisierte
Quelle sichtbar.

Audit-Ereignisse enthalten nur pseudonyme Consent-, Subject-, Packager-,
Device-, Source-, Room-/Program- und Epoch-Referenzen, Zweck, Status,
Zeitstempel und einen begrenzten Reason-Code. Sie enthalten niemals Schlüssel,
JWK-Privatmaterial, Envelope-Ciphertext, Token, Room-Code, Namen, SDP/ICE,
Caption-Text oder Medienmetadaten. Die Angular-Ansicht und die serverseitige
Autoritätsgrenze setzen diesen Vertrag um. Die spätere Program-Orchestrierung
muss beide Ports verbinden; sie ist in diesem Stand noch nicht als öffentliche
Produktfähigkeit aktiviert.

## Verifikation und Grenzen

Die Browser-Vertragstests belegen korrekte Installation, sofortiges
Überschreiben des temporären Schlüsselpuffers, Context-Cleanup und Ablehnung
von Replay, falschem Zielgerät, fremdem Schlüssel, Cross-Room,
Room-/Program-Epoch-Drift, anderer Quelle, anderer Medienart, anderem Zweck,
abgelaufenem Consent, unbekannten Feldern und nachträglicher Quellenerweiterung.

Das ist die Schlüssel- und Consent-Grenze für spätere Trusted-Program-Arbeit.
Echte Remote-Source-Auswahl, Program-Komposition und Gateway-Publikation folgen
in ihren jeweiligen Tracks; bis dahin kann kein öffentlicher Broadcast diese
Fähigkeit aktivieren.
