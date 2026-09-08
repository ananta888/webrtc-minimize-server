# Expliziter Maschinen-Trust im Deployment

`MACHINE_DEPLOYMENT_MODE` wählt `disabled` (Standard), `legacy` oder `profile`.
Die Auswahl gilt für `production-deploy.sh deploy`, `rollback`, `smoke` und
`rotate-broadcast-key`. Es gibt keine automatische Erkennung oder Freigabe nur
aufgrund einer vorhandenen Schlüsseldatei. Die bestehende separate Hub-/Projekt-
Policy, aktuelle Publisherfreigaben und die gemeinsame Release-Abnahme bleiben
Voraussetzungen für produktive Maschinenläufe.

Beispiel für ein bereits operatorseitig geprüftes **öffentliches** Trustprofil:

```dotenv
MACHINE_DEPLOYMENT_MODE=profile
MACHINE_HUB_TRUST_PROFILE_JSON_FILE=/etc/ananta-meet/machine-trust.json
MACHINE_ALLOWED_CAPABILITIES=chat.read,chat.send
```

Alternativ `legacy` mit `MACHINE_HUB_ISSUER` und `MACHINE_HUB_PUBLIC_KEY_FILE`.
Dabei ist ausschließlich ein Ed25519-Public-Key im SPKI-PEM-Format erlaubt.
Profile und Einzel-Schlüssel dürfen nicht kombiniert werden; private Schlüssel
und Inline-Key-/JSON-Konfiguration werden vom Deployment-Pfad abgewiesen.
Dateipfade müssen absolut sein. Operator-Dateien gehören außerhalb des
Repository-/Buildkontexts und müssen im Container für den Dienst lesbar sein.
Es werden keine Schlüssel, Grants oder Profile automatisch erzeugt.

## Rein lesende Prüfung

```bash
node scripts/machine-deployment-config.mjs
```

Ein fester Compose-Selektor lässt `.env`, Interpolation und Prozessumgebungs-
Vorrangregeln von Docker Compose selbst auswerten. Der CLI-Prozess hält die
Ausgabe nur im Speicher; der Compose-Unterprozess ist auf fünf Sekunden und
512 KiB Ausgabe begrenzt. Die CLI gibt
bei Erfolg ausschließlich ein geschlossenes Tokenpaar aus, etwa `profile enabled`.
Ein explizit leeres Capability-Ceiling ergibt `profile disabled`; es wird nicht
durch einen Standard ersetzt. Ungültige Auswahl, gemischter Trust, fehlende/
ungültige Dateien oder unbekannte Felder liefern Exit 2 und festes Blocker-JSON,
keine Pfade, Schlüsselwerte oder rohe Dockerfehler. Trustdateien werden nur über
den vorhandenen begrenzten Regular-File-/Snapshot-Reader gelesen; FIFO blockiert
den Prüfer nicht. Der Selektor startet keine Dienste und erteilt keine Rechte.

Der Runner validiert vor Lock-, Schlüssel- und Snapshot-Schreibzugriffen. Der
ausgewählte Override wird bei sämtlichen Compose-Aktionen beibehalten. Nur die
Control Plane erhält das Public-Key-/Public-Profil-Secret als schreibgeschützten
Mount; Native-Packager, Origin und andere Dienste erhalten es nicht.
Der externe Smoke vergleicht zusätzlich die erwartete Maschinenaufnahme mit
`/api/machine/capabilities`. Ein Health-200 allein genügt nicht. Diese Prüfung
belegt weder den konkreten Hub-Key-Pin noch Task-/Projektfreigaben oder Medien-
lieferung; dafür bleiben der versionierte Rollout-Preflight und Live-Gates nötig.

## Änderung und Rückweg

Die gültige Operator-Konfiguration muss während eines Deployments stabil bleiben.
Die Dateiprüfung und spätere Containeraktivierung sind keine atomare Transaktion.
Der Server prüft das Profil beim Start erneut; es gibt keinen Hot-Reload.
Ein Image-Rollback benutzt dieselbe aktuell gewählte Trustkonfiguration und setzt
keine Policydateien, Schlüssel oder Projektfreigaben zurück. Geplante Policy-
Änderungen und deren Rückweg müssen deshalb separat kompatibel sein.

Zum Abschalten `disabled` wählen **und** alle Hub-Key-/Issuer-/Profilwerte
entfernen beziehungsweise leeren. Widersprüchliche Restwerte werden abgewiesen,
nicht still ignoriert. Ein kontrollierter Neustart beendet flüchtige Räume;
deshalb bestehende Wartungs-/Rollbackregeln beachten.

## Prüfstand

29 gezielte Tests für Auswahl, echte Compose-Auswertung/-Mountkonfiguration,
Datei-/FIFO-/Privatschlüsselablehnung und den bestehenden Drei-Image-Runner
bestanden. Smoke-Fixtures prüfen Admission unabhängig von Health; fehlender
Override und ungültige Auswahl brechen vor Deployment-State oder Docker-Schreibzugriffen ab.
Der isolierte Gesamtcheck von `63b1db1` bestand mit Exit 0: 698 Frontendtests,
774 erfolgreiche Nodeprüfungen, null Fehler und zwei explizite Node-Skips;
Node-Laufzeit 332,840 Sekunden. Build, Go-Unit/Vet und statische Sicherheits-/
Konfigurationsgates bestanden; 14 externe Infrastruktur-Gates und der optionale
Image-Scan blieben ausdrücklich übersprungen. Der Serving-Build blieb unverändert.

Ein produktiver Maschinenrollout ist noch nicht erfolgt. Zusätzlich scheiterte
die CI des vorherigen `bc1fce8` im Native-Packager-Racetest: ungeschützter
Diagnoselesezugriff auf `assignment.State` und ein noch nicht genauer
klassifizierter Signalisierungsfehler trotz empfangenem RTP. Der lokale Erfolg
erklärt oder behebt diesen CI-Befund nicht. Die anschließende
[ICE-Fixture-Reproduktion und Korrektur](native-packager-ice-test-ordering.md)
weist den frühen Kandidatenfehler separat nach; wiederholte Container-Racetests
und ein neuer isolierter Gesamtcheck sind bestanden. Neue CI-/Release-Evidence
sowie das freigegebene Operatorprofil bleiben nötig; Fixture-Erfolge aktivieren
keinen produktiven Hub-Trust. Unabhängige Laptop-Host-Verbindungsdeadlines bleiben
offen und werden nicht als durch diese Teständerung behoben ausgegeben.

Am 8. September 2026 bestand anschließend CI 34253165644 für `ba67caa` alle
sieben Jobs. Der Drei-Dienste-Software-Rollout auf dem Mini-PC und ein separater
externer Smoke bestanden. Die neue Auswahl wurde dabei tatsächlich ausgeführt
und blieb `disabled disabled`; `/api/machine/capabilities` meldet weiterhin
`admissionEnabled: false`. Keine Hub-/Projektpolicy oder Schlüssel wurden
geändert. Dies deployt die Implementierung, aktiviert aber keine KI-Teilnahme.
