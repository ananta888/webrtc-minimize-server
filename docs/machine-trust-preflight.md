# Read-only preflight for versioned machine trust

MDS-09 audit at `6aad282`: the existing v1 rollout plan/preflight inspects
only the legacy public-key pair. A profile-only deployment therefore fails
its local key/issuer checks. Do not add legacy trust to bypass that result.
The CLI also opens its plan before checking regular-file type; a FIFO can
block that diagnostic indefinitely. Both gaps belong to this implementation.

Add a closed `ananta.meet-rollout-plan.v2`, preserving v1. The existing
revision/origin/key-fingerprint/tenant/project/room/capabilities fields stay;
v2 additionally requires `trustRevision`, `keyId`, `subject`, `audience` and
`grantTtlSeconds` (1..600). New fields are local expectations, not authority.
The preflight must compare exact profile revision, issuer, audience, key ID,
public-key SHA256, current key window including requested grant lifetime,
exact subject/tenant/project scope and both capability ceilings. Reject a
v1 plan against strict trust, v2 against legacy trust, and mixed config.
Neither successful local checks nor a higher revision attest deployed Hub
policy, active room consent, operator approval, TURN or production evidence.

Extract closed plan parsing and trust comparisons behind narrow pure ports
while retaining the existing preflight facade and fixed redacted check codes
(SRP/ISP). No HTTP, token creation, key generation, configuration writes,
reload, interactive input or production activation. Read plan files through
the already bounded regular-file adapter; retain the 8 KiB JSON limit and
reject duplicates. Invalid input returns fixed blocked JSON and exit 2.

Test both versions, time-window edges, role/scope/capability mutations,
fingerprints, unknown fields, mismatched modes and no private data in reports.
Exercise real headless CLI fixtures, including a parent-bounded FIFO process.
No local-ready report may set productionReady true. Finish the accumulated
Meet changes with the required isolated full check.

## Implemented verification checkpoint

Plan parsing, public-key/profile comparisons and report composition are now
separate modules; the old facade/export and v1 plan remain compatible. V2
checks the requested complete key window and rejects a v1-audience plan
whose capabilities differ from that audience's fixed publication set.
Reports contain only fixed check codes/status, never raw scope or key data.

The old CLI in the private `6aad282` worktree reproduced the FIFO hang and
was terminated by its 2 s parent limit (exit 124). The new CLI uses the
regular-file snapshot reader with an 8192-byte ceiling, rejects FIFO and
duplicate fields, returns fixed blocked JSON/exit 2 and never waits for
interactive input. Real CLI tests use a clean synthetic environment and
compare local readiness to actual git cleanliness; they do not bypass it.

Combined targeted regression: 160 checks pass in 2.871 s. The final narrower
byte-bound revision passes 79 file/profile/preflight checks in 0.512 s;
the stricter actual-cleanliness CLI assertion is also green. Full isolated
verification follows with the separately tracked startup diagnostic change.
No production config, private key or trust registry was written.
