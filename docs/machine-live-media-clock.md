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
