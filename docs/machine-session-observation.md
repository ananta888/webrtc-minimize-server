# Machine session observation for Ananta MAP-09/12

Source audit `e0e4bfa`: `/api/machine/sessions/authorization` reports current
machine membership and consented incoming sources, not own publication state.
Add a separate `/api/machine/sessions/observation` endpoint with the identical
closed room/session/nonce input and fresh scoped Hub grant. The existing
authorization response must remain unchanged.

The closed `ananta.meet-session-observation.v1` response contains schema, nonce,
lease, binding, peerId, roomId, membershipEpoch, publicationRevision and
publications. Publications are the current machine peer's own registry entries
only: publicationId, source and publicationEpoch. No human sources, receive
grants, media, names, room access expansion or Worker assertions are accepted.
Maintain an ephemeral monotone publication-state revision per membership,
including stops/replacements, with no increment for identical no-op commands.
Overflow fails before changing state. Existing publication incarnation epochs
retain their original meaning.

Pure closed projection and bounded registry mutation stay separate from HTTP
and lease admission (SRP/ISP). The broad server composition retains existing SRP
debt; add one small route composition seam, not media handling or Hub policy.
No frontend capability or human capture change. Ananta validates the receipt
before it can inform later persistent phases; publication registration is not
media delivery, audible output, E2EE or production evidence.

Tests cover real signed HTTP and machine device admission, unchanged v1 shape,
replayed/foreign/expired grants, publication ownership, replacement/stop/no-op
and epoch exhaustion. Run the normal full check in an isolated worktree, then
the private cross-repository browser gate. Do not change serving dist/trust.
