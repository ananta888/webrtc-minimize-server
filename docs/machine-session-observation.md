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

Implementation adds a pure `machineSessionObservation` projection, separate
lease observation callback, closed HTTP route and per-peer publicationRevision.
Both counters are checked before mutation: the old replacement path could
delete the previous source before discovering publicationEpoch exhaustion.
That failure is now atomic; identical no-op announcements still do not advance
either counter. The new observation contains only this machine's declared
sources under its capability set. No source is enabled by reading it.

Initial checks: 34 registry/lease/admission/projection tests passed in 3.31s;
five focused projection/real HTTP tests passed in 0.44s. The latter uses two
actual device-bound machine admissions and signed one-use grants, proves own
source isolation and rejects cross-task/tenant/project/runtime, replay,
unknown fields, expired grants and revoked membership. Full isolated regression
and cross-repository browser verification are still pending at this checkpoint.
# Verification (2026-09-08)

Implementation `777f7ce` passed the full `npm run check` in a detached private
worktree: 639 frontend tests, 573 Node passes with three explicit skips, plus
build, Go, security and configuration checks. External infrastructure remained
explicitly skipped. Serving dist and operator trust were not modified.

The old publication replacement overflow defect was reproduced against the
verified baseline RoomRegistry blob: an invalid replacement removed the old
source. Counter checks now precede mutation; regression tests cover both limits.

Ananta's final focused regression passed 170 tests (66.79 s). Its actual private
Hub/Worker/browser passed (33.26 s), observing own source counts `[1, 0, 1]` and
revisions `[3, 4, 5]` under one membership, with cancellation denying subsequent
observations. Moving screen and two chat answers preceded the source pause/resume;
resumed decoded delivery is not claimed. The test's original sub-second wait was
shorter than Worker control cadence; a separately tested bounded state wait fixes
the fixture, not a production timer. These are synthetic technical results, not
production release evidence or a fix for the separate decoder-startup intermittency.
