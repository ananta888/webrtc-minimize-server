# Native video recovery after sender-clock quarantine

TBP-015, 10 September 2026. The existing source clock deliberately suspends its
fixed RTP/program mapping after a moderate sender-report outlier. Two consistent
reports can restore it; rejected measurements do not extend the twelve-second
freshness limit or become a new time anchor.

A deterministic clock-to-compositor regression failed before this change:
`temporary clock quarantine irreversibly closed active video input`.
The active decoder's RGBA sink treated every unavailable mapping as terminal,
so the clock's intended recovery was unreachable for an already active source.

The production source owner now supplies a small local video-timeline port.
It distinguishes waiting for binding/reports, temporary suspension, ready and
terminal denial. Waiting/suspended inputs discard images and render slate without
closing the decoder. Invalid timestamps, closed/expired clocks and revoked
sources still fail closed. No report tolerances, codec rules, permission checks,
SFrame behavior or test deadlines change.

A local epoch advances on entry to quarantine. Buffered images are wiped when
that epoch is observed; previously borrowed render guards consult the current
clock and remain invalid after recovery. This also covers suspension and recovery
between two render callbacks. The fixed timestamp anchor and last accepted frame
remain intact, and the image pool does not grow. This is not a protocol epoch or
a grant of additional source authority.

The focused Go race checks pass. The real FFmpeg VP8 decoder test also passes:
twenty decoded moving frames, six intentionally replaced by slate during
quarantine, then moving output from the same decoder, followed by revocation and
process cleanup. Reports in this test are explicitly injected synthetic timing,
not observed network jitter. The first new slate assertion used the post-H264
red value 8; it was corrected to the existing raw compositor value 9.

The real Angular/native/SFrame/HLS scene check passes its single-source case
(24.966 s) but fails its two-source case (30.443 s). Both producer and committed
HLS fragments contain slate in both tiles while the audience decoder continues
(327 frames / 21.533 s). Thus the broader initial missing-source failure persists.
The grouped isolated `npm run check` is now terminal with exit 1: 1,274 frontend
tests, production build (13.657 s), types, native unit/vet and static gates pass;
1,213 Node/browser cases pass, two fail, four skip (608.619 s). Both native scene
cases, the two-packager handoff and both active Ananta renewal dialogues pass.
The speech AAC selection fails after a reported source-program restart stopped
its source: both producer and committed output decode to silence in the correct
mono format. A separate native v4 assignment fixture exits unsuccessfully; its
wrapper does not provide the native failure stage. Neither failure is diagnosed
by the video quarantine regression. External infrastructure gates are not reached.
The unchanged native v4 case subsequently passes when run directly (7.528 s),
with red/blue images and decoded 700-Hz audio in both renditions. That repetition
does not explain its grouped failure or change the failed project-check result.

The standalone complete native race suite also passes (49.749 s plus 2.102 s for
the internal SFrame package), as does vet. All eleven changed source/test files
match the isolated snapshot after **only CRLF/LF normalization**; raw bytes differ
for tracked files due to checkout line-ending conversion. The serving index hash
remains unchanged. No new release or deployment is approved by these results.

## Follow-up: automatic live decoder regression

The normal Go unit suite deliberately skips opted-in FFmpeg tests. The existing
Node codec-fixture runner now explicitly executes the new live video quarantine
case, retaining its bounded compiled binary, deadline and strict no-skip checks.
That exact entry point passes in 1.475 s without running the long browser matrix
again. This test-only follow-up is separate from the `f05a7ff` CI already running.

Two additional private instrumented two-source checks pass (25.318/25.351 s).
The latter samples source state only after a test failure, so no such snapshot
was emitted. These runs still provide no failing decoder/program stage to explain
the original intermittence. Private signal/debug hooks are not release code.
This fixes the reproduced lifecycle mismatch; it does **not** yet establish the
cause of the intermittent missing camera/screen in earlier CI or production.
No deployment or completed long-run source-reliability claim is made.
