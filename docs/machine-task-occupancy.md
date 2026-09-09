# One active v2 participant per Hub Task

`MachineSessionLeases` owns an additive v2 task-occupancy fence. Within one Meet
instance, `(issuer, tenantId, projectId, taskId)` can occupy only one pending or
attached machine session. A different P-256 device, runtime, Hub session, room,
subject or capability subset does not grant authority to create a second copy.
The check runs before ticket creation; concurrent independently signed HTTP
admissions therefore cannot both reserve a participant.

Duplicate admission returns `409 machine_session_already_active`, without
replacing, renewing, stopping or changing the original participant. The caller
does not acquire retry authority. Existing close, original deadline and
membership cleanup release occupancy; a subsequent admission still needs a
new valid one-use Hub grant and a fresh device proof. Distinct task ownership
tuples remain independent. The existing v1 exact-binding/device check is retained
for compatibility; this is not a claim of v1 task-wide uniqueness.

## Verified scope

Before the change, the new duplicate-device regression failed (six existing or
compatibility tests passed). After the change all seven lease tests passed.
The combined actual HTTP admission, lease and trust suite passed **58 tests in
3.09 seconds**, with real ephemeral Ed25519 grants and two real P-256 devices.
Concurrent admission gives exactly one 201 and one 409. Changing runtime,
Hub session or capabilities does not disturb the original WebSocket/participant;
an independently assigned second Task joins successfully.

SRP: occupancy belongs to the existing ephemeral session owner, not to Worker
orchestration, signing, device authentication or transport retry. The narrow
comparison has no new dependencies or side effects. No human approval or
production credential is needed by these tests.

This fence is process-local, like Meet membership. It does not prove persistent
multi-node ownership, automatic room rejoin, full Hub restart or safe replacement
while an old isolated Worker remains alive. Hub dispatch fencing and original
deadlines remain mandatory. Tests are synthetic technical observations, not
production release evidence.

## Combined lifecycle verification

The isolated `npm run check` against **a98706f** is now exit-zero: 874 frontend
tests (10.58 s), optimized build (8.566 s), TypeScript, Go unit/vet and static
gates pass; Node reports **876 passed, zero failures, two skips in 345.702 s**.
This includes the corrected independent-task visual-epoch fixture and the
SFrame/first-keyframe regressions. The two Node skips are the optional GPU MP4
fixture and actual Windows PowerShell parser. Fourteen opt-in external
infrastructure gates remain explicitly skipped; private bridges and compositor
long-run evidence also require their separate opt-ins. No full external or
production acceptance is implied by the default aggregate.

Ananta's separate actual packaged Hub-crash/restart gate passes in 168.41 s:
real visual child completion first, old Worker/browser stopped in 2833.80 ms,
same persisted original Task/deadline and exactly one later native expiry event,
no redispatch or new room participant. Only the private fixture's Meet registry
is read to count members; changing UI sections neither breaks observation nor
changes grants. See Ananta `docs/contracts/meet-hub-process-restart.md` for exact
image identities, failed fixture attempts and cleanup. This is fail-closed
restart/reconciliation, not automatic rejoin or multi-node durability.
