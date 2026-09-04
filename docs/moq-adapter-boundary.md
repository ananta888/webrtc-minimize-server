# Austauschbare MoQ-Adaptergrenze

Stand: 2026-09-04. `src/moq-adapters.js` trennt Domain und spätere Angular-
Player von konkreten Gateways und Providern. Die Grenze aktiviert weiterhin
keinen produktiven MoQ-Pfad.

## Port und Registry

Jeder Adapter stellt nur vier kleine Operationen bereit: kurzlebige Capability
melden, Publish öffnen, Subscribe öffnen und eine Session idempotent schließen.
Die Registry kennt Adapter-IDs, aber keine Provider-SDKs und keinen Broadcast-
Reducer. Browser, Gateway und Provider werden über die Verträge aus TBP-025
ausgehandelt; ein Adaptertausch ändert die zentrale State Machine nicht.

Ein zustandsbehafteter Mock ist ausschließlich bei `NODE_ENV=test` verfügbar.
Er belegt denselben Port, ohne als Runtime-Capability ausgeliefert zu werden.

## Ehrlicher Ist-Zustand

- `mediamtx-moq` deklariert MediaMTX 1.20.1 mit MOQT draft-19 und ist wegen des
  Projekt-Pins draft-20 deaktiviert.
- `cloudflare-moq` deklariert die dokumentierten draft-14/draft-16 sowie LOC
  draft-03 und ist ebenfalls deaktiviert.
- Cloudflare Stream ist weder diese Capability noch ein impliziter
  WHIP-zu-MoQ-Adapter. Die Adapter-IDs und Rollen bleiben getrennt.

Beide Runtimeadapter verweigern Publish/Subscribe. Sie simulieren keinen
Erfolg und zwingen die Negotiation zum bereits autorisierten LL-HLS/HLS-
Fallback.

## Ziel- und Credential-Grenze

Providerziele benötigen HTTPS, Port 443, eine exakte Host-Allowlist und einen
erlaubten Pfadpräfix. Userinfo, Query, Fragment, IP-Literale, localhost,
Traversal und fremde Hosts werden verworfen. DNS-/Egress-Regeln des Containers
müssen zusätzlich DNS-Rebinding und unerlaubte Netze sperren; URL-Validierung
allein ersetzt diese Betriebsgrenze nicht.

Credentials liegen als überschreibbarer Buffer ausschließlich im
serverseitigen Vault. Zugriff ist an Provider, Environment, Tenant, Aktion,
Ablauf und Minutenquote gebunden. Rotation löscht den vorherigen Buffer;
Kill-Switch und `destroy()` stoppen Zugriff beziehungsweise überschreiben alle
Secrets. Der injizierte Provider-Client sieht das Authorization-Header nur für
den konkreten Aufruf. Rückgaben sind auf opaque Session-/Endpoint-Refs, Status,
Ablauf und inhaltsfreie Codes begrenzt; Token-, Secret-, Credential- oder URL-
Felder werden abgewiesen.

Das Audit enthält höchstens 256 Einträge mit Provider-ID, pseudonymer
Tenant-ID, Environment, Aktion, Ergebnis und Zeitpunkt. Es enthält keine URL,
keinen Header, Token, Namespace, Program-ID oder Medieninhalt.

Cloudflares dokumentierter URL-Tokenpfad wird dadurch nicht stillschweigend
freigegeben. Ein späterer Adapter benötigt vor Aktivierung kurzlebige,
programmspezifische Tokens, vollständige Proxy-/Access-Log-Redaktion,
serverseitige Quoten und ein reales Leak-/Rotation-Gate.
