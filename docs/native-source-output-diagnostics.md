# Native source output failure boundaries

TBP-030/014, 10 September 2026. No causal runtime fix is claimed.

The existing two-source scene test failed in CI `34452209348` on `3598664`:
the viewer continued decoding but never displayed both selected source tiles.
A scene-application receipt is not proof of decoded source delivery.

A new failure-only test probe reads the private fixture's already existing HLS
producer and committed fragments through bounded regular-file readers. A local
FFmpeg process accepts only a pipe input, decodes one frame and returns two RGB
samples. Only fixed `red`, `blue`, `slate` or `other` classifications escape the
probe; no pixels, decoder stderr, keys or identifiers are returned. Missing,
oversized or invalid inputs return null. Each decoder has a five-second limit.
This is test instrumentation, not a native control endpoint or production API.

Six focused tests pass, including actual encoded red/blue H264 tiles. The first
probe implementation scaled subsampled YUV before RGB conversion and mislabeled
the red tile; the synthetic test caught it. Conversion to RGB **before** scaling
fixes this probe, without changing classification thresholds or application code.

The real two-source test then reproduces the failure in 32.360 seconds:
both producer and committed output contain `[red, slate]`. The current single
pixel viewer observation happens to sample the dark divider. The important
evidence is the two-tile native output: the screen is already absent before the
audience path. This narrows the investigation to source input/composition but
does not establish why the screen is missing.

Two further runs in a **separate, privately instrumented** checkout pass
(26.453/27.272 s). That experimental binary prints only existing transport/clock
failure enums and synchronized source/decoder state; it is not the unchanged
release binary and its code is not being committed. In these successful runs,
camera and screen clock/decoder/mixer state is live; ordinary revoke closes them
without a failure code. A failure under that observer has not yet been captured.

Two further private instrumented checks also pass: combined two-source/music
output (20.698 s) and a publisher-stats run. The publisher was visible and sent
both live video tracks; this successful observation does not establish a cause
for an earlier failure. None of the private native diagnostics enter the release.

The subsequent CI `34454680494` on `1b3c1e4` ends red: 1,208 Node/browser passes,
three failures and four skips (634.980 s). Failures are the initial Compose config
fixture, Chromium identical-persona replacement, and the single-source scene's
selected output; the two-source scene passes this time. These are independent
observations, not proof of one shared cause. A separately reproduced active
video-clock lifecycle mismatch is addressed in
[native-video-clock-recovery.md](native-video-clock-recovery.md).

Separately, the grouped handoff check fails one pre-existing music AAC output
assertion. Its unchanged targeted media path, with a failure-only print of the
already computed bounded observation, passes in 20.054 s. The 15-second output
deadline, format checks and non-silence thresholds are unchanged. This does not
explain the earlier failure or turn the grouped result green.

The grouped handoff snapshot predates these test-only diagnostic additions.
No production code, permissions, codec policy, retry behavior or browser timeout
was changed by this diagnostic slice. Production rollout and the wider source
reliability acceptance remain open.

## Bounded native source snapshot in the two director fixtures

The two `native-scene-director.browser.test.js` cases now explicitly opt into
an **instrumented test binary**. All other process fixtures and release builds
keep their existing binary path. The fixture creates an owned, mode-0600 copy
of `main.go` through Go's build overlay; it inserts one observer registration
after client construction and appends the test-only implementation from
`test/helpers/native-scene-observer.go.txt`. Unexpected source shape fails the
build preparation. No production file, network endpoint, decrypt port or
operator setting is changed.

The parent can request at most two snapshots by SIGUSR1 on its own child:
before scene application, and on failed pixel verification. The reader permits
one outstanding request, 64 KiB and one second; malformed, unknown, oversized,
late, failed or missing output is unavailable, never a passing media result.
Only the instrumented child's stdout is connected; stderr is not collected.
Snapshots use a fixed schema of booleans, source-kind enums and bounded counts:

- Program and lazy decoder closed state, observed input, pending/attached decoder,
  keyframe and temporary clock wait.
- Clock binding, accepted-report count, uncertainty and its existing failure code.
- Video decoder started/closed state and existing input/timestamp queue occupancy.
- Mixer started/closed state, current-image presence and pending-frame count.

The reader rejects every additional field. No IDs, names, paths, tokens, keys,
SDP/ICE, absolute timestamps, media or caption values are emitted. Up to the
existing 80 source handles are copied under `TryLock`; individual busy sections
report their availability as false. Registry, decoder, clock and mixer locks
are never nested by the observer. It does not invoke policy, clock-mapping or
freshness methods. These are sequential observations, not an atomic causal trace.

The tests still require the original decoded image, motion, revocation and
remaining-source behavior. They label their evidence `instrumentedBinary: true`
and `productionEvidence: false`; the extra observation does not certify the
release binary or establish a cause for earlier failures. Codec, consent,
queue budgets and media deadlines remain unchanged. A successful instrumented
run alone also cannot rule out scheduling-sensitive failure.

Local verification: the Node parser/overlay/process suite passes all 11 tests,
and the actual overlay compiles with Go 1.24.13 in a network-disabled, bounded
container with read-only release sources. No local FFmpeg, audio or browser is
started. The two real browser cases remain for GitHub CI.

### First instrumented CI result and presentation check

CI `34497462247` on `79f55fc` completes with a passing single-source case and
a failing two-source case. At the latter failure, both sources have running
decoders, 21 accepted sender reports, no clock failure or uncertainty, and
started mixers with current images plus one pending frame each. Both producer
and committed HLS still contain two slate tiles while the viewer keeps decoding.
This snapshot contradicts a permanently closed decoder/clock as the explanation
for this particular failure; it does not identify a cause across all earlier runs.

The applied receipt currently proves a revision increment, not which layout
and source selection the director actually submitted. The two fixtures now query
the native scene again after that receipt and require the intended layout,
selected-source count, negotiated version and applied revision before checking
pixels. A mismatch fails at `scene-application-state`; it is not automatically
reapplied or corrected. This separates presentation-state mistakes from the
remaining render/encoder handoff. No extra media wait or retry is introduced.

### Native layout mismatch and Angular hydration boundary

CI `34499845766` on `a4325b8` fails the single-source case at the new
`scene-application-state` check: revision 2 contains one selected source, but
the native layout is `waiting-slate`, not the intended `single`. The two-source
case in that same run passes both fit changes and source revocation, including
continuing movement of the remaining source. This is evidence of an incorrect
applied presentation in the failing case, not a stalled decoder.

The component previously advertised controller-ready before its own async
refresh continuation had copied the observation into the form. A deterministic
component test fails on that prematurely ready state. The component now holds
its own pending gate through hydration: status, fieldset, refresh and every edit
handler agree on that boundary. Duplicate refreshes and apply in that window do
nothing; stale responses do not hydrate the draft. No retry, codec/clock change,
capture or longer deadline is introduced. Eighteen focused jsdom component and
controller cases plus 23 Node scene-contract/broker tests pass without local
browser or media execution. The next coupled browser CI must establish whether
this correction also resolves the observed live-fixture mismatch; earlier red
runs and the broad production acceptance remain red/open.

CI `34501460871` on `27eba11` still fails both native-layout checks: selected
counts match, but both observed layouts remain `waiting-slate`. The hydration
boundary correction is therefore **not** a proven fix for those failures.
The next test boundary checks the DOM layout immediately after selection and
again after source selection, then observes the actual outgoing HTTP apply.
Only its version, expected revision, closed layout enum and source count are
retained; request contents, identities and credentials are never printed.
Observation is limited to one matching request, 16 KiB and five seconds, with
no automatic correction. Five pure projection/assertion tests pass; the real
browser request and native scene/pixel checks remain CI work.

### Visible select value and model diverge before HTTP

CI `34502823315` on `8ab4c70` confirms that both DOM checks pass, yet the actual
HTTP apply submits `waiting-slate` with the correct version, revision and source
counts. The native agent is therefore not where these two requests lose their
intended layout.

The rendered Angular test now reproduces that mismatch without a browser or
media: start refresh, interact with the still-enabled native select before the
next render, then finish the request. The DOM displays `grid`, while the model
still contains `single`. The handler already sees the pending gate and refuses
the edit; Angular's unchanged binding cache does not restore the altered DOM
value. A second reproduction during apply produces `end-slate` versus `grid`.

Refresh and apply now synchronously render their pending state through the
component's actual `ChangeDetectorRef` before returning from the click handler.
The native fieldset is thus disabled when the handler is gated. The rendered
test fails before each correction and passes after both; all 28 focused frontend
cases and five Node observation tests pass, as do TypeScript and Angular's
no-emit template compilation. No native codec, clock, consent, deadline or media
behavior changes. The coupled CI must still prove correct submission and actual
source pixels; local reproduction alone is not a production rollout claim.

CI `34504411648` on `ede8926` now completes successfully, including both
project shards, native/Blind agents, Ananta TURN, macOS lifecycles, Docker and
Live Keycloak/TURN. The coupled single-source case passes in 35.868 seconds;
the two-source case passes in 36.733 seconds with both selected source tiles,
contain/cover changes, encoder replacements, revoked-source slate and continued
motion from the surviving source. The explicit DOM, actual HTTP submission and
native scene-state checks all remain enabled. Shard 1 reports 645 passes,
zero failures and three explicit infrastructure skips. These are synthetic,
instrumented-binary results, not a deployed Mini-PC or release-binary claim.

The subsequent run `34506245871` on `0efa1cb` has a different single-source
failure: the immediate DOM list of fit controls is empty, before HTTP apply or
native output verification. Its shard reports 650 passes, one failure and three
skips. A rendered Angular test reproduces the observation boundary without
media: after the checkbox event the model already contains the selected source,
but its fit select appears only after Angular's render. The model and eventual
`contain` value are correct. This does not establish that earlier media failures
share a cause.

The browser fixture now observes exactly the expected number of `contain` fit
controls for at most one second before the unchanged value assertion. It does
not repeat interactions, extend source leases or relax native/pixel assertions.
The local rendered reproduction passes; the real browser correction awaits CI.
Separately, related broadcast cleanup hooks share one server-close listener,
avoiding the new 11-listener warning without changing EventEmitter thresholds.
The real HTTP/JWT/P-256/source-revoke fixture checks the listener bound and
still verifies shutdown, passing in 2.146 seconds total without audio/browser.
