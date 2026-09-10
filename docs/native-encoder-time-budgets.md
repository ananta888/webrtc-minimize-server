# Encoder-Minuten: zeitbasierte Native-Zulassung

Der produktive Native-Assignment-Pfad begrenzt zusätzlich zu gleichzeitigen
Ressourcen den konservativ genehmigten Encoder-Zeitbedarf. Eine Encoder-Minute
bedeutet eine Ausgabestufe für 60 Sekunden; drei Renditions für 20 Sekunden
benötigen ebenfalls eine Encoder-Minute. Gemessen wird genehmigte Lease-Zeit,
nicht tatsächliche CPU-Auslastung oder eine Rechnung des Providers.

| Variable | Geltung | Standard |
| --- | --- | --- |
| `BROADCAST_NATIVE_ENCODER_MINUTES_PER_HOUR` | Gesamte laufende Instanz | 2880 |
| `BROADCAST_NATIVE_ENCODER_MINUTES_PER_HOUR_PER_TENANT` | Verifizierter OIDC-Tenant | Erbt global |
| `BROADCAST_NATIVE_ENCODER_MINUTES_PER_HOUR_PER_PRINCIPAL` | Konto innerhalb des Tenants | Erbt global |

Alle drei Grenzen müssen erfüllt sein. `0` verweigert neue positive Zeit;
leere, negative, nicht ganzzahlige oder ungültige Werte brechen den Start ab.
Erlaubt sind ganze Minuten von 0 bis 1.000.000.000. Ein globaler Standard von
2880 entspricht 48 kontinuierlich belegten Encoder-Slots pro UTC-Stunde.
Die bestehenden gleichzeitigen Ressourcen- und Programmlimits gelten weiterhin.
Die Werte werden über Konfiguration und Compose tatsächlich an die Registry
übergeben; kein Request darf einen anderen Tenant oder Budget-Owner wählen.

## Reservierung und Verlängerung

- Admit/Vorschau prüft 60 Sekunden der tatsächlich ausgewählten Ladder ohne
  Verbrauch. Ein fast erschöpftes Budget verkürzt neue Sendungen nicht automatisch.
- Prepare prüft die wirkliche initiale Lease (maximal 120 Sekunden, in der
  normalen Runtime 60 Sekunden). Vor ID/ICE-Allokation erfolgt eine Vorprüfung;
  nach reentranten Ports werden Budget und aktive Writer nochmals geprüft.
- Erst unmittelbar vor dem Registry-Commit werden alle drei Budgets synchron
  belastet. Kein Scope wird bei Ablehnung teilweise belastet.
- Renewal belastet ausschließlich Zeit jenseits des bisherigen internen
  Paid-until-Fence. Wiederholte Heartbeats und zeitweise kürzere öffentliche
  Leases geben weder Budget zurück noch berechnen die gleiche Zeit nochmals.
- Fehlendes Budget verlängert die Lease nicht. Bereits autorisierte Zeit bleibt
  gültig; nach Ablauf greifen die bestehenden Agent-Lease- und serverseitigen
  Stop-/Fencing-Pfade. Das ist keine Garantie eines sofortigen physischen
  Prozessstopps bei einem ausgefallenen oder nicht kooperierenden Agenten.
- Stop, Fehler, Verbindungsverlust, Handoff und eine neue Program-ID erstatten
  genehmigte Zeit nicht. Auch eine autorisierte Übergabevorprüfung darf den
  Zeitverbrauch des Vorgängers nicht aus der Summe nehmen. Sie kann deshalb
  abgelehnt werden, obwohl der alte Writer beim Wechsel freie Encoderplätze
  hinterlassen würde. Das ist beabsichtigt konservativ.

## Fenster, Datenschutz und Grenzen

Die Fenster sind feste UTC-Stunden, keine gleitenden 60-Minuten-Intervalle.
Leases über einer Stundengrenze werden millisekundengenau auf beide Fenster
verteilt, jeweils multipliziert mit der Anzahl der Encoder. Nicht genutzte
Minuten werden nicht in die nächste Stunde übertragen.

Es existieren höchstens 8192 Buckets. Tenant und Konto werden intern mit einem
instanzzufälligen HMAC-Key pseudonymisiert. Keine Räume, Programme, Gerätedaten,
Medien, Texte oder Schlüssel werden in diesem Zähler gespeichert. Die Diagnose
liefert nur globale Encoder-Millisekunden, globales Limit, Fensterbeginn und
einen Clock-Blocked-Status; keine fremden Konto- oder Tenantbelegungen.
Abgelaufene Buckets werden bei der nächsten Beobachtung entfernt. Voller
Bucket-Speicher verweigert neue Scopes statt unbeschränkt zu wachsen.

Eine ungültige oder rückwärts springende Uhr sperrt neue Zeitreservierungen
dieser Instanz dauerhaft; laufende Grants werden nicht künstlich verlängert.
Der Betreiber muss die Uhr und den Betrieb prüfen. Ein Prozessneustart beginnt
eine neue instanzlokale Abrechnung und setzt den Zähler zurück.

**Das ist ausdrücklich keine neustartfeste, clusterweite oder persistente
Monatsabrechnung und keine Provider-Kostengrenze.** Persistente transaktionale
Usage-Zähler, zulässige Speicherpolicy, gemeinsame HA-Abrechnung, Preise und
monatliche Rechnungsperioden bleiben gesondert offen. Ein neu gestarteter
Control-Plane-Prozess darf daher nicht als Fortführung einer garantierten
externen Kostenobergrenze bezeichnet werden. Die Room-Membership bleibt flüchtig.

## Gezielte Verifikation

Kurze Node-Tests prüfen alle drei Scopes, UTC-Überlappung, exakte Gewichtung,
atomare Ablehnung, Bucket-Grenze, Uhr-Rücksprung, ENV und echte Compose-Auswertung.
Registry-Tests prüfen reale Prepare-/Renew-/Stop-/Handoff-Vorprüfungen für
Legacy- und Trusted-Source-Writer sowie reentrante Prepare- und Renewal-Ports.
Der Server-Kompositionstest belegt, dass alle drei ENV-Grenzen tatsächlich in
der ausführenden Registry greifen. Diese Fixtures starten keine Browser oder
Encoder und ersetzen nicht die gebündelte Browser-/Produktionsabnahme.
