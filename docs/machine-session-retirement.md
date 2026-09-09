# Exact Hub-owned session retirement

MDS-06 / Ananta MAP-11 source audit, 2026-09-09 (`b11d749`). Renewals
preserve one membership and reject duplicate v2 Task occupancy, but Ananta
cannot obtain a positive bounded acknowledgement that an old session was
retired before an explicitly authorized reconnect. This slice adds retirement,
not automatic rejoin, trust configuration or any grant/receive-policy issuer.

`POST /api/machine/sessions/retire` uses the same current verified v2 Hub
grant and closed `{roomId, sessionId, nonce}` body as the existing control
backchannels. A present record must match every immutable binding field.
Retirement first invokes a narrow synchronous membership-detachment port;
only a confirmed detachment permits removal of the lease and a receipt.
An exception/unconfirmed detachment must not free task occupancy. Socket close
alone is insufficient because room cleanup is otherwise asynchronous.

An already absent ID is idempotent but proves no previous ownership. The
receipt binds the caller identity and request nonce, not an invented historical
record. The Hub must already possess its independently validated original
membership, enforce an attempt budget/current assignment and wait for bounded
source cleanup before a new grant. Retirement cannot create a new peer, expand
capabilities, transfer consent, lengthen the original task or reopen old input.

Tests must cover exact-scope rejection without mutation, failed detach, ticket
and renewal replay, late retirement of an old ID after replacement, ordinary
lease compatibility and actual authenticated HTTP/WebSocket removal. All test
identities are synthetic. No public deployment or production evidence claim.

SRP/ISP: session ownership stays in `MachineSessionLeases`; membership teardown
is injected as one narrow port from the existing owning server. The broad HTTP
dispatcher remains existing SRP debt; no Worker or peer scheduler is introduced.
