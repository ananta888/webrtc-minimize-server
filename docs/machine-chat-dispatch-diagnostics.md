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

## Full-check investigation

The first isolated complete check at `0e474ca` was not green: 665 frontend
tests, build, security and Go unit/vet gates passed, but Node reported 736
passes, one failure and seven skips in 226.429 seconds. The existing Chromium
native SFrame counter-400 test exceeded its unchanged ten-second Docker
subprocess bound; the corresponding Firefox case passed. The subsequent
two-case isolated repeat passed in 19.106 seconds. This does not establish a
causal fix or erase the failed full run. The final external-infrastructure
stage was not reached in that run.

The shell had neither Go nor FFmpeg available. Its Go fallback used Docker,
and five additional codec checks were skipped without FFmpeg. To exercise
those paths, Ubuntu archive packages were downloaded and extracted into an
owned temporary prefix, without system installation or service changes:
Go `1.24.13-2` (matching the repository toolchain), FFmpeg/avdevice
`7:8.0.1-3ubuntu2` and their missing SDL/Jack/OpenAL/DC1394 runtime libraries.
Only the explicit test invocation receives that PATH/library prefix and
private Go caches; this is not a new global tool configuration.

All eight focused native/browser tests then passed in 73.677 seconds with no
skips: both counter-400 browser cases, actual VP8/Opus decoding, audio mixing,
video composition and both browser-to-native RTP/source decoding cases. Test
deadlines and application source are unchanged. The full check is repeated
with this tooling profile; Docker-fallback startup uncertainty remains a
separate limitation, not a decoder bug declared fixed by a different runner.

The complete repeat with that explicit tooling profile also was not green:
Node reported 741 passes, one failure and two skips in 205.224 seconds. The
native/FFmpeg paths passed, but the existing Chromium screen-decoder browser
case ended with `test_fixture_wait_deadline` (8.186 seconds); Firefox passed.
The output does not identify which fixture wait expired. Neither the decoder
nor the test budget has been changed, and the final infrastructure stage was
again not reached. This independent intermittent failure remains open;
the current-source packaged GPU dialog is checked separately.

The current-source cross-repository GPU voice gate passed in 101.51 seconds
against the fresh private frontend built from `0e474ca`, using immutable
packaged Worker image `sha256:3444cb7d1124c52959be70043b4c66fa78bba0e55f109c18b724d2ab46dddb9e`
without Worker source mounts. The two selected Piper voices produced 44,800
and 165,376 local samples and exact correlated chat answers; the independent
receiver observed active audio with no human captures or transform errors.
The observer recorded exactly two events, ACKs, prepared turns, spoken turns
and replies, with no failures. Remote revocation took 438.87 ms. This is real
local GPU execution under synthetic test policy, not production release
evidence or a causal fix for prior intermittent startup failures.

The isolated Chromium/Firefox screen-decoder repeat passed both cases in
4.599 seconds, including real disposal of the stale bitmap and reception of
the fresh green screen. That repeat is retained separately from the failed
full run; no assertion, timeout or application behavior was relaxed.

The separately invoked `npm run test:infrastructure` completed with fourteen
explicit skips for opt-in live identity/TURN, platform lifecycle and broadcast
infrastructure gates. None of those skips is a successful live verification.
