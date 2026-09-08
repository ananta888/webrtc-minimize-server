# Private chat dispatch diagnostics (MDS-04/08)

Source audit: Meet `089c4db`, Ananta `0977a1003`. A real GPU dialog repeat
failed before any observed inference; subsequent repeats passed. The private
bridge reports `sent: true` after submitting the UI form, but that is not a
DataChannel delivery receipt. `PeerMeshService.sendChat` can correctly omit a
send when the channel or current permission is unavailable. The existing
observer counts attempts before native `send()` but does not distinguish its
successful return from an exception. None of these observations establishes
the cause of the earlier failure.

Add only test instrumentation: bounded attempted/queued/failed send counters
plus correlated-answer-seen/rendered booleans. Keep text/IDs inside the existing
private correlation state; export no contents, keys, scopes or arbitrary errors.
Native bytes, return values and exceptions stay unchanged, with no retries,
buffered replay or production sender/permission modification.

On the existing 30-second correlated-answer timeout, the bridge obtains one
closed content-free snapshot within a separate one-second diagnostic bound.
The result must still fail Ananta's exact answer assertion. Missing, malformed
or stalled diagnostics return a fixed unavailable projection. Preserve the
successful response shape and existing audio status contract. Do not extend
the question/answer budget or infer model execution from a queued send.

Keep timeout/snapshot validation in a separate narrow test helper (SRP), not
in the already broad private bridge or production PeerMeshService. Test exact
native forwarding, exceptions, bounds, redaction, late/failed diagnostic reads
and unchanged success/non-timeout behavior. Then use a fresh private frontend
build for the actual Hub/Worker/Meet gate and run the isolated complete check.
The old serving `dist`, live services, public trust and operator keys stay
untouched. A passing repetition without a causal fix does not close MDS-08.

The instrumentation is implemented. All 20 deterministic observer/timeout
tests passed in 142.07 ms, including exact native forwarding, exceptions,
redaction, unavailable and late snapshots. The serialized observer also ran in
real Chromium and Firefox: both preserved the native unconnected DataChannel
`InvalidStateError` and reported one attempt/one failure/zero queued messages,
without reporting the synthetic question (two passes in 5.140 seconds).
The full private build/check and current-source Hub/GPU dialog still follow;
no production chat behavior or cause of the older failure is claimed fixed.
