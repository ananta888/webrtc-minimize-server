# Runbook: Broadcast-Lifecycle, Security und Außerbetriebnahme

## Provisionierung

1. Gepinnte Images, SBOM/Provenance und `npm audit --omit=dev` prüfen.
2. Gateway-/Packager-Netze gemäß Portmatrix anlegen; Admin/API/WHIP/HLS bleiben privat hinter dem kontrollierten Proxy.
3. Secrets ausschließlich als root-lesbare Hostdatei oder Orchestrator-Secret mounten. Keine Keys, Tokens oder Stream-Schlüssel in Git, Image, Angular-Bundle oder Logs.
4. Gateway-Auth, Grant-Authority, Writer-Fencing, Health und Observability zuerst im internen Profil prüfen.
5. Feature-Flag nur zur nächsten Stufe ändern, wenn alle `entryGates` aus `infra/deployment/broadcast-rollout.v1.json` grün sind.

## Health, Alarm, Quote und Kosten

`/healthz` prüft das Meet, `/readyz` trennt Meet-Readiness von optionalem Broadcast. Bei Broadcast `degraded` keinen neuen Start zulassen, laufende Räume aber nicht beeinflussen. Dashboard und Runbooks zu Availability, Startlatenz, End-to-glass, Player, Captions, Capacity und Error Budget verwenden. Quoten erst aus versionierten Messwerten setzen; solange Providerpreise fehlen, keine Geld- oder Zuschauergrenze behaupten.

## Rotation

Secrets oder Zertifikate atomar ersetzen, betroffenen privaten Dienst neu erzeugen, alte Grants/Leases widerrufen und anschließend externe TLS-, Origin-, Auth-, Playback- und Stop-Smokes ausführen. Private Geräteschlüssel und SFrame-Schlüssel werden nicht exportiert oder gesichert. Bei Verdacht auf Offenlegung sofort Kill-Switch ausführen.

## Incident, Providerausfall und Takeover

1. Neue Broadcaststarts sperren; Meet-Health separat prüfen.
2. Fehlerdomäne als Browserquelle, Packager, Gateway, Host, Netzwerk oder Provider klassifizieren.
3. Nur einen frischen, consentierten und quorum-bestätigten Writer übernehmen lassen. Alte Fences müssen fail-closed scheitern.
4. Bei sicherer Übernahme Discontinuity und Player-Neustart ausgeben; bei Quellenverlust, fehlendem Consent oder Deadline sichtbar stoppen.
5. Provider-/CDN-Ausfall niemals durch öffentliches Öffnen des privaten Origins umgehen. Auf freigegebenen Adapter zurückfallen oder stoppen.
6. Zeit, pseudonyme Refs, Status und technische Metriken protokollieren; keine Raumcodes, SDP/ICE, IPs, Captions, Medien oder Schlüssel.

## Purge, Rollback und sichere Außerbetriebnahme

Feature-Flag leeren, Control Service health-gated neu erzeugen, alle Grants und Writer-Leases widerrufen, Packager/Gateway stoppen und kurzlebige Muxer/CDN-Objekte entfernen. Danach `/healthz`, `/readyz`, `/config`, OIDC, SFrame und einen Raumbeitritt testen. Bei einem Releasefehler das bekannte Produktions-Rollback ausführen. Medien oder Transcripts gehören nicht in Backups; nur ausdrücklich konfigurierte Workspace-Metadaten werden nach dem eigenen Backupplan wiederhergestellt.

Vor endgültiger Außerbetriebnahme DNS/Proxy-Routen entfernen, Zertifikate/Secrets widerrufen, private Firewallregeln schließen, Images/Volumes nach Aufbewahrungsvorgabe entsorgen und belegen, dass das ursprüngliche Meet unverändert erreichbar bleibt.
