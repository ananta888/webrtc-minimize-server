# Independent live source timing

MDS-01 / Ananta MAP-24, source audit `49495e5` and `f67ac9533`.
Existing speech sample progress, silent video decoder and canvas publications
have independent lifetimes but no shared timing projection. Add a pure local
timeline before composing its source adapters and optional machine-page port.

The closed `ananta.meet-media-timing.v1` projection matches Ananta's contract:
fixed `independent-owned-live-v1` profile, `browser-performance-v1` timebase,
membership epoch, integer microsecond observation time and at most speech,
avatar and screen observations. Each source has its own generation, state,
measurement kind, start/position/observation timestamps, origin/position and
independently recomputable drift. Canvas submission has null media position
and drift; it must never be labelled delivered RTP or decoded receiver timing.

Bound drift to 500 ms and observation age to 750 ms after first readiness.
Reject regressed clocks and positions, retain failed observations, retire old
generation callbacks and never rebase a running generation. Held decoded video
keeps its last media timestamp and needs fresh rendering observations. New
membership resets only local timing ownership, not Hub authority or consent.
The fixed profile is independent persona video with speech, not semantic
lip synchronization. No quality observation extends a source lease, the
2.5-second authority freshness limit or the original Task deadline.

Implement timeline math with an injected monotonic clock and narrow source
observation leases; integrate source ownership separately. The machine port
is opt-in and cannot open sources or confer media permissions. Legacy probe
and source receipt shapes remain unchanged. Ananta must explicitly negotiate
support and enforce its own independent Worker-clock fence.

Tests cover exact shared positive/negative projections, stale clocks, drift,
late callbacks, source replacement, PCM underflow and video loop/hold. Actual
Chromium/Firefox source and receiver observations and installed GPU/TTS checks
are separate acceptance gates. Neither virtual-clock tests nor canvas
submission counts are live delivery or production release evidence.

SRP/DIP: pure timing, source lifecycle, browser transport and Hub admission
remain separate. The existing broad machine page is preserved composition
debt, not a place for another scheduler or policy owner.

The pure timeline is implemented and 21 virtual-clock tests pass; together
with the newly integrated eight upstream page-lifecycle tests, 29 checks passed
in 0.928 seconds. It owns at most three source entries, 4,096 generations per
kind and a 24-hour integer clock range. Failed cleanup cannot erase a failed
row, and failure before first readiness cannot manufacture a healthy snapshot.
This is not yet connected to the machine API or sources. Both upstream and
local TODO notes were preserved when integrating `01669c9`; 27 reconnect/relay
helper checks passed in 0.549 seconds after integration. The preceding full
aggregate applies to `49495e5`, not to the subsequent merged source revision.

## Source integration and browser scope

The opt-in page service now observes actual Worklet PCM progress, frame
submissions from owned canvases, and video compositor PTS from
[`requestVideoFrameCallback`](https://wicg.github.io/video-rvfc/). The latter
is a best-effort source observation, not receiver RTP delivery. Unknown full
loop counts are rejected rather than estimated. A final held frame retains its
last decoded position while the owned canvas continues its liveness rendering.
Existing source receipts and the legacy client probe remain unchanged.

The separate timing probe reports native decoded-video and canvas-submission
support without opening a source. Timing can start only before sources open;
the profile excludes coupled legacy MP4 and screen audio while enabled. Leave
cleans timing ownership; there is no live switch to disable a failed fence.
The 100-ms local watchdog cannot extend source leases or Hub freshness.

The first actual Chromium publisher / Firefox receiver passed in 9.399 s:
29 samples, peak source drift 157,099 us video / 9,400 us PCM and intentionally
stale screen stopped after 768.50 ms. The attempted Firefox publisher failed
at the existing canvas adapter before publication: its actual canvas track has
no `requestFrame`, and `CanvasCaptureMediaStreamTrack` is absent. The prototype
probe now declares this unsupported and rejects timing activation explicitly;
there is no automatic-capture fallback. The installed Ananta Worker remains a
Chromium publisher. The receiver matrix covers Chromium and Firefox, with an
additional Firefox-publisher negative feasibility test. This limitation is not
labelled full Firefox source support.

356 focused frontend tests passed in 2.73 s; initial new fake-clock fixture
ordering and a compile-time mismatch between boolean screen status and other
source state strings were corrected. Current typecheck and private production
build pass. Worker negotiation, shared contracts and hardware/receiver quality
acceptance remain separate; no production release or semantic lip-sync claim.

The corrected supported-browser matrix passed all three cases in 20.769 s:
Chromium publisher to Chromium / Firefox receiver in 8.434 / 9.707 s, plus
explicit Firefox publisher rejection in 1.985 s without join or source effects.
Each positive case sampled all three clocks 30 times, observed multiple real
clip loops and the stable held blue receiver frame, and received synthetic
speech and screen pixels. Peak video drift was 147,600 / 144,000 us and PCM
drift 8,200 us in both. Unrefreshed screen publication stopped at 799.87 /
790.14 ms while held avatar remained independent; close could not erase the
failed timing row. Zero human capture or transform errors. Log:
`/tmp/ananta-meet-media-timing-browser-matrix.log`. These are source-clock and
actual-decode observations, not measured end-to-end A/V alignment or GPU proof.

## Combined regression follow-up

The isolated full check at `38e7f35` passed 965 frontend tests and build/type,
static/security and Go checks, but its Node stage ended with 968 passed, five
failed and two skipped in 405.678 seconds. The infrastructure tail was not
reached. The three new timing browser cases passed again. The five failures
were existing Chromium avatar-video/avatar-renewal waits and Firefox active
audio-receive, same-persona and repeated-screen waits. Their causes are not yet
established; this aggregate is failed, not a completion gate.

An independent upstream screen/audio cleanup change (`92b19a1`) was subsequently
integrated, retaining both its small screen endpoint and the opt-in timing
restriction. Its own prior aggregate already records an avatar-video failure.
370 machine frontend tests passed after integration in 2.87 s. Next use a fresh
private build and the five affected cases with the available bounded failure
diagnostics. Do not infer a runtime fix from a green repeat or blame host load
without a corresponding observation. No serving build or trust changed.

All five affected cases passed on `95d0d4e` in a serial focused repeat (66.583 s),
without another simultaneous heavy gate. That is repeatability information,
not a causal fix or a green aggregate. A timer-created `waitFixtureValue` error
previously lost the awaiting fixture's call site. The test-only helper now
captures that stack before polling, preserving the unchanged deadline/message
without serializing page values. Seven deterministic helper checks passed in
0.430 s, including the retained phase and absence of private predicate values.

A complete Node-stage repeat at `28eff78` with the private `95d0d4e` browser
build passed: 977 tests, zero failures, two explicit skips, 383.400 seconds.
It includes all five formerly failing machine cases and the three timing
browser cases. This is the Node aggregate, not another complete `npm run check`,
and does not establish the causes of previous failures. The last native encoder
tail overlapped the independently owned Ananta GPU component probe; browser
machine cases ran before that probe. Neither serving files nor trust changed.
Subsequent upstream `d2c4e0a` was fast-forwarded only after the run completed;
its broadcast/source and speech-fixture changes are not covered by this result.

## Authority-failure diagnosis (9 September 2026)

The later combined native UI batch passed 1,067 frontend and 981 Node tests,
but failed one Firefox timing case (two explicit skips; Node 428.821 seconds).
The failure can occur before the avatar replacement, during hold-last, or after
the deliberately stale screen stop. A missing timing row is not itself proof
of clock drift: ordinary source cleanup removes a row, whereas timing-owned
failure preserves its failed row.

Three targeted diagnostic runs reproduced the failure. The source emitted
`meet_avatar_authority_expired`; in two runs speech also emitted
`meet_speech_authority_changed`. The observed session still had over 110 seconds
remaining, controller pulses had gaps around one second, and the signaling
observation retained membership epoch 2 with two peers, without a departure.
These observations narrow the investigation but do not prove its cause.

Avatar and speech now attach a fixed internal `Error.cause` category to their
existing authority errors. The original scope, generation, backward-clock,
idle, activation and controller checks remain enforced; no values or authority
objects are retained in errors, and wire status contracts are unchanged.
Eleven new reason assertions first failed, then all 46 source tests passed.

The private timing fixture records at most 64 allowlisted error codes/causes
and 32 count/epoch-only membership events. Native error construction, subclasses,
causes and thrown identity are preserved; ErrorOptions getters are not invoked
twice. No exception is suppressed. Arbitrary messages, stacks, IDs, SDP, ICE,
images and PCM are excluded. The temporary Date.now probe was removed: the final
fixture leaves application clocks untouched and relies on the exact internal
reason instead. Opening production pages installs none of these observers.

The final focused matrix passed nine tests in 21.539 seconds, including both
browser timing cases and the unsupported Firefox publisher case; each timed
case observed 30 samples and stopped the stale screen within 800 ms. Earlier
reproductions remain failures, and these passes do not establish a causal fix.
The next aggregate uses the new closed reason trace if the fault recurs.

The subsequent isolated complete `npm run check` passed with exit 0: 1,078
frontend tests and 989 Node/browser tests, zero failures and two explicit Node
skips (447.381 seconds). Both timing engines, human-consented audio/chat/screen
with three renewals, and native source-publisher media cases passed. Build,
typecheck, Go and static gates passed; the initial bundle warning remains.
Fourteen opt-in external infrastructure gates and the optional image scan were
explicitly skipped, not treated as live evidence. Runtime/test files matched
the checked isolated snapshot; the serving build and trust were unchanged.
This is a successful aggregate, not proof that the earlier intermittent
authority failure has been causally fixed. The internal reason/trace changes
are the implementation delivered by this diagnostic round.

The `faf3c39` follow-up reproduced `controller-expired` before the first
one-second fixture pulse. The private failure trace now includes bounded
relative wall time alongside monotonic elapsed time and the combined clock-read
span. It changes neither clock and stores no absolute timestamp. Nine focused
diagnostic tests pass, including forward/backward wall steps, invalid readings,
sampling delays and unchanged native exception construction. Three bounded
Chromium repeats passed (9.280/9.347/8.862 seconds); no anomaly was reproduced,
so neither a clock cause nor a runtime fix is claimed. The series is finished.

Separately, CI34348135945 at `faf3c39` failed its TURN job on
`test_tls_proxy_not_ready` before launching Chromium (6.674 seconds); the Firefox
case passed. This does not establish a TURN transport or cleanup regression.
No deadline or source-authority guard has been relaxed in response.

## Integrated own-source batch

The isolated complete check at `e7d39e3` failed: 1,095 frontend tests passed;
the Node stage had 1,011 passes, two failures and two explicit skips in
470.322 seconds. Build, types, Go and static/security gates passed. The external
infrastructure tail was not reached; the optional image scan was skipped.
The later rebase onto documentation-only `962f678` retained identical runtime
and test bytes at `129afa1`; it does not turn this aggregate green.

The combined human-consented machine dialog passed with Chromium and Firefox
in 14.850/16.950 seconds: 16,000 actual PCM samples, chat, owned screen and three
renewals each. Both source-timing cases also passed. The failures were separate:

- The Chromium-to-Firefox SFrame test remained pending before its counter-350
  assertion: 298 encoded frames, zero sent packets, no reported transform errors.
- The Chromium avatar-video test lost companion audio at line 77 after its
  intentional controller-pulse stop. Avatar expiry is expected in that phase;
  continued independent audio is the failed requirement. The trace recorded
  speech `progress-expired` at 5,227 ms monotonic / 7,574 ms wall time and avatar
  `controller-expired` at 5,271 / 7,618 ms, with zero rounded clock-read span.
  Both pairs differ by 2,347 ms. This is a measured relative-clock discrepancy,
  not proof of an OS clock step, scheduling cause or production fix.

No clock or deadline was changed. Serving files, trust and deployment remain
unchanged; MDS-08 and the joint long-run acceptance remain open.

## Independent host-clock observation

The later overlay-lifecycle candidate `c537188` passed both timing cases but
failed Firefox avatar-video hold. Its source trace recorded speech progress
expiry at 2,459 ms monotonic / 4,640 ms wall and controller expiry at 2,501 /
4,681 ms (zero rounded read span). The session was still joined; this is not
evidence that overlay key fencing caused the failure.

A separate passive Node process then sampled host wall and monotonic time 900
times over 90,250 monotonic milliseconds. The relative difference ranged from
0 to 7,035 ms; maximum clock-read span was 1 ms. No clock was rewritten. The
host reports WSL and enabled, synchronized NTP. Thus a discrepancy was observed
outside the browser as well. Its exact OS, suspend or synchronization mechanism
is not established, and this later observation alone cannot prove the cause of
all historical source failures. Log: `/tmp/webrtc-host-clock-observation.log`.

Do not weaken source freshness or absolute grant expiry based on this result.
Further diagnosis must distinguish a wall-clock correction from actual missing
controller activity or suspended execution; a monotonic-only freshness policy
must not silently extend authority through sleep or loss of the controller.
