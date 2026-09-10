# Ablauf während einer HLS-Autorisierung

Stand: 2026-09-11. Sechs deterministische Regressionen zeigten im bisherigen
`BroadcastPlaybackSessionStore`, dass eine vor `await` erfasste Uhrzeit auch
nach der Grantprüfung verwendet wurde. Dadurch konnten während der Prüfung
abgelaufene Grants noch Cookies erzeugen, alte Cookies erneuert und
Manifest-/Segmentanfragen freigegeben werden.

## Korrigierte Grenze

Jeder asynchrone Store-Aufruf verbindet seinen validierten Epoch-Zeitanker mit
der seit Aufrufbeginn verstrichenen monotonen `performance.now()`-Zeit. Für
Tests lässt sich nur dieser monotone Messport injizieren. Die Dauer wird auf
Millisekunden aufgerundet; Bruchteile erzeugen keine zusätzliche Lebenszeit.
Uhrfehler, Rücksprünge innerhalb des Aufrufs und unsichere Ganzzahlsummen
werden ohne private Fehlerdetails als 404 abgewiesen.

- Create/Renew prüfen nach der Manifestautorisierung erneut die Zeit und
  verwenden sie für die Segmentautorisierung. Nach deren Abschluss wird
  nochmals frisch geprüft.
- Create prüft zusätzlich unmittelbar vor dem Cookie-Commit, auch nach der
  synchronen ID-Erzeugung. Bei Ablauf entsteht kein Sessionrecord.
- Renew benötigt weiterhin denselben aktuellen Cookie-/Scope-Record. Auch
  ein länger gültiger neuer Grant darf eine inzwischen abgelaufene alte
  Sitzung nicht wiederbeleben. Ein abgelehnter neuer Grant überschreibt
  keine noch gültige alte Sitzung.
- Jede Medienautorisierung prüft nach `await` den Ablauf und die bestehende
  Close-/Prune-/Renew-Bindung erneut. Eine in der Zwischenzeit abgelaufene
  Autorisierung liefert keinen Upstreampfad.
- Abgelaufene Records werden mit der aktualisierten Zeit vor der
  Kapazitätsprüfung entfernt. Cookie-Max-Age berücksichtigt die verstrichene
  Prüfdauer; dessen bisherige Einsekunden-Mindestauflösung verlängert keine
  serverseitige Grantberechtigung.

Die Grenze gilt für den HLS-Cookiepfad und seine Sessionfreigabe. Sie ersetzt
weder die separate Grant-Autorität noch eine Fristprüfung in direkten
Gateway-/CDN-/Providerpfaden und beendet keine bereits zuvor zugelassenen
HTTP-Bodies rückwirkend. Die Streams besitzen eigene Laufzeit- und
Backpressure-Grenzen. Eine globale Korrektur von Systemuhränderungen zwischen
unterschiedlichen Aufrufen wird damit nicht behauptet.

## Verifikation

Die sechs ursprünglichen Regressionen scheiterten vor der Änderung mit
fehlender Ablehnung. Zusätzliche Tests prüfen aktualisierte Prüftimestamps,
Cookie-Max-Age, die exakte und gebrochene Millisekundengrenze, späten Ablauf
bei ID-Erzeugung, Uhrfehler und Überlauf, unbeschädigte alte Sitzungen sowie
Freigabe abgelaufener Quotenbelegung. Bestehende echte P-256-/JWT- und
Parallel-Renew-/Close-Fences bleiben in der gemeinsamen Testauswahl.

Ein echter lokaler HTTP-Test mit kontrollierter Grant-Autorität lässt die
Session während der Prüfung ablaufen: Ergebnis 404 ohne Cookie und ohne
einzigen Upstream-Fetch; der Meet-Health-Endpunkt bleibt 200. Kein Browser,
Mikrofon, AudioContext oder FFmpeg wird dafür gestartet. Dieser Nachweis
ersetzt weder die öffentliche TLS-/OIDC-Abnahme noch Browser-/Lasttests.
