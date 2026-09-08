# Private delayed receiver-key regression (MDS-08)

Ananta's private cross-repository screen test intermittently received RTP without
decoded video (349 packets, zero frames, 33 source pushes, connected transport).
A green isolated repeat does not identify or fix that failure. Delaying the
sender transform's first key by two seconds passed in 28.63 seconds; the sender
encoded a later third keyframe. No production crypto change is justified by
that observation alone.

Before implementation: add an explicit private-fixture option delaying only its
human receiver's first SFrame decrypt-key delivery by two seconds. The normal
ACK path and required encryption remain untouched. Hold at most one 16-byte key,
cancel/wipe it on context/all-key clear, replacement key or that Worker's
termination; do not resurrect an invalidated key. Unknown option values fail
before resources. No automatic test activation outside the opted-in root bridge.

The existing moving-screen assertion and timeout remain unchanged. A fixed
read-only bridge command exposes only scheduled/delivered/cancelled counts and
delay milliseconds; success must prove that the injection actually happened.
No key, context ID, packet, media, SDP, ICE or user content in reports. Test the
helper deterministically and run the real private composition, then `npm run
check` in an isolated build worktree. Public trust, serving assets and services
remain untouched. A failure is diagnostic evidence, not authorization to weaken
SFrame or add unbounded retries.

Diagnostic refinement: the first receiver key was cancelled by the normal
consent/rekey sequence before the two-second injection completed (scheduled 1,
delivered 0, cancelled 1); therefore that attempt is not a delayed-key acceptance.
Allow at most three incoming current key generations until one delay completes,
still only one held key/timer and no generated/replayed protocol command. Every
superseded key is wiped. At most six seconds of injected waiting fits within the
unchanged twelve-second first-screen observation. Report all scheduled/cancelled
counts; never call an unexercised injection successful.

Implemented under the default-off `receiverKeyDelay` private fixture option and
the explicitly opted-in bridge's `MEET_TEST_RECEIVER_KEY_DELAY=1`. Seven Node
helper tests passed; the root's final serial sender/receiver/helper matrix passed
three tests in 55.55 seconds with actual decoded moving screen and normal Hub
stop. Both directions completed a real two-second current-key delay. Initial
cancelled-injection attempts and one independent pre-admission network-change
failure remain documented in Ananta's matching contract. The original sporadic
zero-decoded-frame symptom was not reproduced by either delay, so no production
keyframe/crypto fix is claimed. The full isolated repository check follows before
this test-infrastructure slice is finalized.

The isolated `npm run check` at `1f3cab5` subsequently completed with exit 0:
635 frontend tests, 558 Node passes and three explicit Node skips (137.70 seconds
for Node), plus build, Go and configuration/security gates. External runtime
gates remained explicit skips. No serving files or running services changed.

## Recurrence and next bounded diagnostic (2026-09-08)

The root role-lifecycle matrix again failed before its revocation stimulus:
348 inbound RTP packets, zero decoded/key frames, 33 PLIs, connected ICE/DTLS,
32 healthy source pushes, live Worker and **one transform failure**. The current
fixture records closed transform error codes internally but the bridge exposes
only their count, so this observation cannot distinguish envelope/codec/key
budget failures from a Worker load/runtime error. Do not infer a crypto cause.

Before code: add a small read-only test observation helper reporting counts for
the five existing public transform codes and the fixed Worker-runtime category.
Unknown values become an aggregate count, never caller-selected report keys or
strings. Inspect at most 128 recorded values and expose truncation explicitly.
No context IDs, keys, frame bytes, paths, exceptions or arbitrary text. Add
deterministic malformed/unknown/oversize redaction tests and compose the helper
only into the private bridge's failure report. Existing SFrame, source, grant,
timeouts, retries and moving-frame acceptance remain unchanged. Verify a bounded
real root gate and the isolated repository check; a green repeat is still not a
startup fix. Keep MDS-05/08 open.

The helper and failure-report composition are implemented without frontend or
production changes. Five deterministic redaction/budget tests plus the exact
serialized callback in real Chromium and Firefox passed: **7 tests, 1693.93
ms**. Unknown objects are never stringified; prototype names do not become keys;
an accessor beyond the 128-entry bound is never read; report input is not
mutated. The real root lifecycle repeat and isolated full repository check
follow. SRP keeps diagnostic classification out of the existing large bridge.
