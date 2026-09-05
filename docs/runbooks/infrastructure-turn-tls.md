# Infrastruktur-TURN mit TLS auf 5349

Dieser Ablauf ergänzt den vorhandenen Coturn auf Oracle um `turns:` über
TCP 5349. UDP/TCP 3478 und der begrenzte UDP-Relaybereich bleiben unabhängig
davon erhalten. Coturn verwendet weiterhin dieselben kurzlebigen
REST-Credentials und dasselbe serverseitige Shared Secret; dieses Repository
enthält weder das Secret noch private Schlüssel.

## Zertifikatsgrenze und Rotation

Caddys Datenvolume wird nicht in Coturn eingebunden. Der root-only Dienst
`ananta-turn-tls-sync.service` kopiert stattdessen einen Snapshot in
`/etc/ananta/turn-tls/releases/`, nachdem er alle folgenden Bedingungen
geprüft hat:

- reguläre, nicht verlinkte und nicht schreibbare Quelldateien mit erwarteter
  Eigentümer-UID,
- parsebares Zertifikat und parsebarer privater Schlüssel,
- vollständige Hostnamenprüfung für `webrtc.ananta.de`,
- mindestens sieben Tage Restgültigkeit sowie
- identische öffentliche Schlüssel von Zertifikat und Private Key.

Die Kopie bleibt Eigentum von root; nur die dedizierte Coturn-GID 10002 darf
Verzeichnisse traversieren und den Schlüssel mit Modus 0440 lesen, aber nichts
verändern. Erst danach wechselt der Dienst den relativen Symlink `current` atomar. Bei
unverändertem Material wird Coturn nicht neu gestartet. Bei einer Änderung
wird genau der laufende Container mit den Compose-Labels
`ananta-public`/`coturn` neu gestartet; null oder mehrere Treffer brechen
fail-closed ab. Ein vor dem atomaren Wechsel gesetzter Marker bleibt bei einem
fehlgeschlagenen Restart erhalten, sodass der nächste Timerlauf denselben
Coturn-Restart nachholt, obwohl das Zertifikat bereits aktuell ist. Der Timer
prüft viermal täglich mit zufälliger Verzögerung.

Installation auf dem Oracle-Host als root:

```bash
install -m 0755 scripts/sync-turn-tls-certificate.sh /usr/local/sbin/ananta-sync-turn-tls
install -d -m 0750 -o root -g 10002 /etc/ananta/turn-tls
install -m 0600 infra/deployment/ananta-turn-tls-sync.env.example /etc/ananta/turn-tls-sync.env
install -m 0644 infra/deployment/ananta-turn-tls-sync.service /etc/systemd/system/
install -m 0644 infra/deployment/ananta-turn-tls-sync.timer /etc/systemd/system/
systemctl daemon-reload
```

Vor dem ersten Lauf wird in `/etc/ananta/turn-tls-sync.env`
`TURN_TLS_RESTART_ENABLED=0` gesetzt. Nach erfolgreichem initialem Sync wird
Coturn wie im nächsten Abschnitt konfiguriert und neu erzeugt. Anschließend
wird der Wert auf `1` gesetzt und der Timer aktiviert:

```bash
systemctl enable --now ananta-turn-tls-sync.timer
systemctl start ananta-turn-tls-sync.service
```

Statusausgaben nennen nur Ergebnis und Hostnamen. Journal und normale
Toolausgaben dürfen weder Shared Secret noch Key-Inhalt enthalten.

## Coturn

Der bestehende Coturn-Service erhält ausschließlich diesen zusätzlichen
read-only SELinux-Bind-Mount:

```yaml
user: "10002:10002"
volumes:
  - /etc/ananta/turn-tls:/run/turn-tls:ro,Z
read_only: true
cap_drop: ["ALL"]
cap_add: ["NET_BIND_SERVICE"]
security_opt:
  - no-new-privileges:true
tmpfs:
  - /tmp:rw,noexec,nosuid,nodev,size=16m,uid=10002,gid=10002
```

Das gepinnte Coturn-Binary trägt eine File-Capability und kann nach
`cap_drop: ALL` nur mit der einzelnen Bounding-Capability
`NET_BIND_SERVICE` gestartet werden. Weitere Linux-Capabilities bleiben
entzogen; der Dienst läuft als UID/GID 10002 und alle Listener liegen oberhalb
von 1024.

In seiner bereits geschlossenen Argumentliste wird `--no-tls` entfernt und
werden diese Argumente ergänzt:

```text
--tls-listening-port=5349
--cert=/run/turn-tls/current/certificate.pem
--pkey=/run/turn-tls/current/private-key.pem
--pidfile=/tmp/turnserver.pid
```

Coturn 4.17 startet DTLS nur nach einem expliziten `--dtls`; dieses Argument
wird nicht gesetzt, sodass 5349 auf TCP/TLS begrenzt bleibt. TLS beginnt
standardmäßig bei TLS 1.2; die früheren
`--no-tlsv1`-/`--no-tlsv1_1`-Schalter existieren in dieser Version nicht.
Die vorhandenen Realm-, REST-Secret-, Quota-, Relayport- und
Denied-Peer-Regeln bleiben unverändert. Nach `docker compose up -d coturn`
muss der Container genau einen TLS-Listener auf TCP 5349 besitzen.

## Firewall und externer Gate

Erst nach erfolgreichem Listener- und Zertifikatsgate wird auf dem Host
`5349/tcp` dauerhaft geöffnet. Zusätzlich muss die OCI-Network-Security-List
oder Network-Security-Group denselben Port von den vorgesehenen Quellen
zulassen; eine Hostfreigabe ersetzt diese Cloud-Regel nicht.

Extern prüfen:

```bash
openssl s_client -connect webrtc.ananta.de:5349 -servername webrtc.ananta.de -verify_return_error </dev/null
```

Danach wird ein echter REST-authentisierter TURN/TLS-Allocationstest mit
kurzlebigen Credentials ausgeführt. Erst wenn beides erfolgreich ist, darf
die Runtime zusätzlich veröffentlichen:

```text
turns:webrtc.ananta.de:5349?transport=tcp
```

Ein bloß offener TCP-Port genügt nicht. Bei Fehlern bleibt die URL aus der
Runtime entfernt; der bestehende UDP/TCP-3478-Pfad arbeitet weiter. Rollback:
TURNS-URL aus der Runtime entfernen, Coturn-Argumente und Mount zurücknehmen,
Container neu erzeugen und 5349 in Host- sowie OCI-Firewall wieder schließen.
