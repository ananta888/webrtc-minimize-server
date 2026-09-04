# MoQ-Verträge und Capability-Aushandlung

Stand: 2026-09-04. Der MoQ-Pfad ist **experimentell und standardmäßig
deaktiviert**. Implementiert ist die versionierte, fail-closed Control-Grenze,
nicht ein produktiver MoQ-Medientransport.

## Gepinnte Arbeitsbasis

| Teil | Projekt-Pin | aktueller Produktstatus |
| --- | --- | --- |
| MOQT | `draft-ietf-moq-transport-20` | experimentell, deaktiviert |
| LOC | `draft-ietf-moq-loc-04` | experimentell, deaktiviert |
| WebTransport | `RFC 9297` | Browser-API allein reicht nicht als MoQ-Nachweis |
| Secure Objects | `draft-ietf-moq-secure-objects-01` | nicht implementiert |
| MediaMTX 1.20.1 | bevorzugt MOQT draft-19 | inkompatibel zum Projekt-Pin |
| Cloudflare MoQ Beta | dokumentiert draft-14/draft-16 | inkompatibel zum Projekt-Pin |

Die Browsermatrix bleibt unverändert vorsichtig: WebTransport ist in mehreren
aktuellen Browserfamilien vorhanden, aber für keine davon wurde der komplette
Projektpfad aus MOQT draft-20, LOC draft-04, Codec, Gateway, Autorisierung und
QUIC real verifiziert.

## Geschlossene Grenze

`contracts/moq/` enthält vier herstellerneutrale Metadatenverträge:
Capability, Catalog, Object-Metadaten und Subscription. Die Node-Control-Plane
empfängt keine Medienobjekte. Ein Binärobjekt wird am Adapter gegen deklarierte
Länge, SHA-256 und die harte 1-MiB-Grenze geprüft; der Inhalt wird weder
protokolliert noch persistiert.

Catalogs sind auf 64 KiB und 32 Tracks begrenzt. Tracknamen, Codecs,
Renditions, Priorität, Group-/Object-IDs, Ablaufzeit und Filter besitzen
geschlossene Wertebereiche. Unbekannte Felder, Drafts und Extensions werden
abgewiesen. Der einzige gültige Namespace wird aus dem autorisierten Scope
gebildet:

```text
<tenantId>/<programId>/epoch/<programEpoch>
```

Subscription und Catalog müssen exakt denselben Tenant, dasselbe Programm,
dieselbe Epoch, Audience und denselben Namespace besitzen. Track, Codec und
Rendition müssen im Catalog enthalten sein. Alte Epochs und Cross-Program-
Subscriptions werden damit nicht allein aufgrund eines erratenen Namens
akzeptiert.

## Aushandlung und Fallback

Browser, Gateway und Provider liefern je eine kurzlebige Capability. MoQ wird
nur ausgewählt, wenn alle drei Rollen vorhanden, aktiviert, frisch und für
die exakten Pins sowie mindestens einen erlaubten Codec kompatibel sind.
Secure Objects wird nur gewählt, wenn die Policy es verlangt und alle drei
Teilnehmer exakt draft-01 deklarieren.

Bei deaktivierter Policy, Ablauf, Versions-, Codec- oder Secure-Objects-
Mismatch wird vor dem Medientransfer genau ein gemeinsamer, policy-erlaubter
Fallback (`ll-hls`, sonst `hls`) gewählt. Das Ergebnis übernimmt unverändert
Tenant, Program-ID, Program-Epoch und Audience. Es erzeugt weder neue Grants
noch URLs und kann deshalb keine Berechtigung erweitern oder einen parallelen
Doppeldownload starten. Ist auch kein gemeinsamer Fallback vorhanden, schlägt
die Auswahl geschlossen fehl.

Die Angular-Zuschauerkomponente zeigt den deaktivierten Experimentalstatus,
die exakten Drafts, die bekannten Provider-Mismatches und den LL-HLS/HLS-
Fallback. Erst TBP-026/TBP-027 dürfen einen echten Adapter und dessen
begrenzten Laufzeit-Fallback ergänzen.
