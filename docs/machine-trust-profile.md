# Optional versioned Hub trust

Source audit: Meet `478856c`, Ananta `740dfb7e5`. MDS-02 pins one public
key/issuer and a global capability ceiling. Add separate operator-owned
trust; no production activation is part of this work.

Closed `ananta.meet-machine-trust.v1` fields: `schema`, positive `revision`,
exact HTTPS-origin `issuer`, `audiences` (nonempty existing v1/v2 subset),
`keys` (1..4), `scopes` (0..128, empty denies all). Keys contain only `kid`,
canonical Ed25519 public `x`, Unix-second `notBefore`/`notAfter`. Exact scopes
contain `subject`, `tenantId`, `projectId`, `capabilities`; no wildcard or
cross-product. Duplicate fields/IDs/keys/scopes, unknown fields, private
material and invalid bounds fail closed.

`MACHINE_HUB_TRUST_PROFILE_JSON` or its `_FILE` variant is mutually exclusive
with legacy `MACHINE_HUB_PUBLIC_KEY[_FILE]`/`MACHINE_HUB_ISSUER`. Legacy stays
supported. Strict mode verifies closed headers (`alg`, `typ`, `kid`), EdDSA,
exact issuer/audience, whole grant lifetime and current time within the
selected key window, exact scope and both capability ceilings. Unknown keys
never fetch or fall back. Replay protection spans all profile keys.

Ananta adds optional Hub-owned `ANANTA_MEET_MACHINE_KEY_ID` to JWT headers;
existing v1/v2 payloads and participant/session identities stay unchanged.
Overlapping preinstalled public keys allow scheduled Hub rotation without
Meet restart. Operator configuration replacement/restart removes trust and
terminates this server's ephemeral memberships. No reload API, identity
migration or room/publisher consent is inferred from trust.

Separate profile validation, JWT trust and HTTP composition (SRP/DIP). The
large server remains SRP debt, not a home for additional trust policy.
Test ephemeral real keys, malformed profiles, overlap/expiry/removal,
cross-key replay, scopes, actual P-256 HTTP/WS renewal and Ananta grants.
Legacy/human regressions and isolated `npm run check` are required; serving
dist and operator configuration remain untouched. Org-/Agent principals,
automated operator provisioning and production gates remain subsequent work.
