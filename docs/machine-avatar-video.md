# Explicit silent avatar video

The additive `persona-video-v1` mode uses the existing machine avatar source,
camera publication ownership and 5 FPS labeled canvas. It does not use human
capture, the whole desktop, a microphone or a new media route on the server.
Ananta separately negotiates video support, resolves the current profile and
hydrates its exact admitted immutable asset. Meet does not make those Hub policy
decisions or synthesize a persona. Old image/neutral calls and the complete
`client-probe.v1` shape remain unchanged.

`anantaMachine.avatar.videoProbe()` is a separate synchronous feasibility
observation with exactly `schema`, `profile` and boolean `mp4H264`. It invokes no
source, join, publication or approval. Unsupported decoding fails without an
image, neutral or codec fallback; a true probe is not an authorization.

Video content is a closed object: `mp4` (canonical base64, at most 1,500,000
decoded bytes), SHA-256, integer `frames` (2..120), explicit `repeatMode`
(`loop` or `hold_last`), `originKind` and `classification`. Generated content
cannot claim production classification. Only the normalized silent MP4 emitted
by the Hub-admitted Ananta inspector is supported (256x256, 12 Hz, at most ten
seconds). Hash is verified before creating a decoder. Decoder dimensions and
duration must match before attaching a surface; the element remains muted,
volume zero, original blob URL, playback rate one and the selected loop mode.
Native browser decoding is not a hard memory sandbox: admission/normalization,
isolated browser and container resource limits are still required.

The renderer paints only inside the artwork region, with visible TEST/SYNTH or
IMPORTED classification underneath. Existing fixed ANANTA/KI labels and liveness
strip are preserved. Only the canvas video track is published; there is no
audio graph or raw clip track publication. This is a stored video, not a
lip-synchronization or generated talking-head implementation.

One loader permit covers hashing, the owned decoder and any still-pending native
play completion. Closing during an asynchronous operation does not release that
permit early; late work cannot attach a camera. A following `open` does not fail
with a busy error: its decoder is created only after the predecessor's native
play has settled, so there are never two decoders, and a stalled predecessor is
bounded by the unchanged two-second decode deadline. Setup is bounded to two
seconds inside the source's 110-second setup timeout and 120-second activation
lease. Each frame still requires current session, membership, generation and key
protection.

## Camera publication handover, 2026-09-21

Ananta's companion swaps clips per speech segment and state (`close(generation)`
followed by `open`), blocking its audio loop on the receipt. Each swap formerly
created a new camera track: sender slot reuse, renegotiation and a fresh SFrame
key exchange per swap, and `open` resolved only once the new track was protected
(about 200 ms locally; up to `meet_avatar_setup_timeout` under load). The
200 ms speech queue underran meanwhile.

The surface factory now parks the live camera publication on close (canvas,
capture track and ownership claim stay attached, no frame is submitted) and the
next generation adopts it: no `detachPublication`/`attachPublication`, no new
track id, no key exchange. Parking is bounded: 500 ms grace, extended only while
an image/video loader holds it for its decode, and never beyond 10 s. An
unrelated camera claimant (the MP4 publication path) takes a parked camera over
synchronously unless a successor avatar is loading. The source polls setup at
25 ms and returns to the 100 ms frame tick once open.

`test/machine-avatar-clip-churn.browser.test.js` drives companion-like swaps
inside a speech push loop: 19 generations provision exactly one camera key,
each blocking swap takes about 100 ms and the speech worklet does not underrun.
The source activation is bounded to 120 seconds or the initial verified authority
expiry, whichever comes first; the Hub must still reopen before it expires.
This follows the explicit slow-handshake policy from commit `f430a0a`.

Stop fences state first, clears retained input bytes, closes its surface and
decoder, clears the element source, revokes its owned blob URL and releases its
camera claim. Independent speech and screen ownership remain unchanged. These
are reachable-resource cleanup guarantees, not a claim to erase browser/OS
internal memory cryptographically.

SRP/DIP: pure content/probe validation, native decoder lifecycle and asynchronous
artwork composition are separate modules. The existing source remains the
authority/lifetime controller, and the surface remains publication ownership.

Initial component checkpoint: all 749 frontend tests passed in 9.95s; Angular template
type checking passed. Actual private Chromium/Firefox media tests and isolated
`npm run check` are pending. No serving build, public trust or operator policy
was activated by this implementation.

## Independent receiver verification

On 8 September 2026 the merged `011a20b` implementation passed the real
Chromium/Firefox receiver cases (5.804 / 8.755 s). Tests were then strengthened
to assert that the feasibility probe leaves capture, PeerConnections, avatar
state and membership unchanged, and to exercise `hold_last` as well as looping.
The final frame is observed repeatedly for 1.25 seconds, longer than the whole
one-second synthetic clip; an accidental return to red cannot pass as holding
the blue final frame. The independent KI liveness strip continues moving.

The strengthened cases passed (6.899 / 9.618 s) with 24 / 23 held-frame
observations and actual pulse-loss stops in 1.256 / 2.479 s. Video-to-image-to-
video switches used three source generations; a stale close did not remove the
new source. Separate speech and screen remained active after avatar stop.
Both participant contexts observed zero capture calls and no transform errors.
All 49 focused artwork/decoder/source tests passed. This is a synthetic,
explicitly authorized local transport test, not Hub/model or production evidence.
The combined isolated check subsequently passed with Exit 0: 757 frontend
tests, 790 Node passes, zero failures and two explicit Node skips (346.019 s).
Build, Go unit/vet and static gates passed; 14 external infrastructure gates
and the optional image scan were explicitly skipped. The existing uncommitted
Packager-v4 contract candidate was also present in this private checkout; it is
not part of the avatar verification commit. The serving build stayed unchanged.

### Upstream normalization boundary

A separate read-only invocation of Ananta's unchanged `9039b55d9` source used
the real `PersonaVideoInspector` and FFmpeg with a synthetic 320x180, 24-FPS
H.264 clip containing AAC. The resulting asset had exactly one H.264 video
stream, 256x256, 12 FPS, 12 decoded frames, no audio and the expected SHA-256;
the current-authority callback was checked 17 times. This bounded invocation
completed in 0.531 s without writing Ananta files or using a production identity.
The source audit also confirms strict post-normalization probing and current
profile/asset revalidation around signed hydration. This is not a new live Hub,
packaged-Worker or public authorization test.

Meet's browser validates its content hash and decoded dimensions/duration,
not the complete encoded frame table or every MP4 stream. Only the admitted
upstream normalizer establishes that stronger input profile. Browser/container
limits remain necessary; the decoder is not a bitstream security sandbox.
The local [AVS-01 component track](../todos/archive/todo.ananta-persona-video-source.json)
is complete. Overall Ananta dialogue admission,
the packaged Worker rollout, GPU/TURN/soak and Ananta MAP-20 remain separate.

## Independent Mini-PC verification

The separately authored report in `3f67510` records the following evidence
against the merged native fix `d8a67b9`. It is retained alongside the laptop
observations above; the two full-check revisions and test counts are distinct.

Verification: all 749 frontend tests and Angular template checks passed.
Actual private Chromium/Firefox receivers decoded clip motion and image/video
replacement, preserving speech/screen; controller loss stopped the avatar in
1826.62/1716.84ms. The Ananta Hub/Worker gate passed in 63.57s, with four source
generations, remote asset revocation in 314.08ms, two independent spoken replies
and zero human capture/transform errors.

The complete isolated merged-source `npm run check` at `d8a67b9` passed: 749
frontend tests, 782 Node passes, zero failures and two explicit Node skips;
Node phase 289.43s. Go, build and static gates passed. Fourteen external
infrastructure gates and optional container-image canary were visibly skipped,
not passed. The initial check's two native raw encoder failures were fixed
under TBP-016 and passed the repeat. No serving build, public trust, source
factory or operator policy was activated. AVS-01 is complete and archived;
broader Ananta MAP-20 pre-dispatch/multi-session criteria remain separate.

After combining both reports and the published native filter-graph fix, the
complete Go unit/vet gate passed again. Focused race checks passed, and the
rebuilt native test binary on FFmpeg 6.1.1 passed the actual two-rendition
encoder (4.24 s), rolling HLS window (26.03 s) and composed generation (7.72 s),
including decoded colors/audio, writer stop and resource reaping. These are
targeted post-merge checks, not a relabeling of either earlier full check.
The final merged CI and software deployment remain separate gates.

## Same-persona session isolation, 2026-09-08

`machine-same-persona-video.browser.test.js` now publishes the identical
normalized synthetic MP4 in two independent machine browser contexts, with
distinct task/runtime/session identities and source handles. Chromium and
Firefox receivers decode both red/blue phases from both publishers, plus
independent screens and fresh simultaneous speech. Replacing the first avatar
with a green image and stopping that source leaves the second generation
unchanged and advancing; speech/screens remain active. Human capture and
transform errors remain zero. The standalone pair passed in 9.33 s.

The first test attempt correctly hit `meet_avatar_busy`: the fixture tried to
open replacement artwork without closing its own active generation. The test
now follows the production close/open sequence; the source fence is unchanged.
This is synthetic policy/media with actual private browser transport, not a
claim that credentials, consent or production evidence were obtained externally.

The complete isolated check at merged source `68db657` passed: **757 frontend
tests, 788 Node passes, zero failures, two explicit Node skips**, Node phase
301.35 s. Go, build and static gates passed. Fourteen external infrastructure
gates and the optional image canary remained explicit skips, not successes.
This check includes the concurrent read-only chat fix, hold-last browser test
and native encoder correction. The private build did not replace the serving
dist or change public trust, keys or source-factory policy. MDS-08 remains open
for its broader matrix; this closes only its same-clip isolation check.

## Shared speech sample-clock sequence foundation

The current host-timed Ananta clip-swapping loop still fails strict multisegment GPU delivery under variable browser/Hub IPC. `todos/active/todo.meet-avatar-speech-sample-clock.json` tracks an additive native sequence path; current delivery is not reclassified as accepted.

`machine-avatar-sequence-contract.ts` validates a closed `ananta.meet-avatar-sequence.v1` content plan: one to five existing video clips, contiguous PCM windows, at most40seconds/480decoded frames and a128MiB logical decoded-frame ceiling. Every clip uses hold_last and its existing bounded video shape. Digest verification remains a preparation responsibility. Owned byte arrays and frozen metadata avoid caller-content mutation. Preparation has no guessed speech generation; activation binds the actual generation returned by the native speech port.

`AvatarSequenceClock` selects clip/frame windows from native played-sample counters rather than a host wall-clock estimate. It rejects backward/overbroad/inconsistent counters, source replacement, unknown states and reactivation after failure. Only exact native completion of an already opened generation may hold the final frame. These are execution-quality checks, not membership, source authorization, evidence identities or extra lifetime. Native authority and deadline checks must remain around rendering.

`AvatarSequencePreparation` is the resource owner behind small digest/decoder/frame ports. It verifies each digest before decoding and acquires only one decoder at a time. A single atlas holds the permit until close;20seconds bounds stalled preparation. Cancellation closes acquired resources and disposes late decoders/bitmaps without awaiting their arrival. The permit remains held while an unknown late resource has not settled, so a replacement cannot overlap it. Owner cancellation after successful preparation also releases the atlas. Cleanup continues after a failing resource close, and copied encoded bytes are erased.

The foundation passed97 focused Vitest checks in726ms, including existing speech-source/graph and video-loader regressions. Strict isolated TypeScript compilation passes; the Todo gate validates49documents. The actual HTML frame decoder, live surface/endpoint, Worker sequence adapter, browser matrix and actual GPU synchronization acceptance remain pending. No portable native-decoder or production-release claim is made. No source expiry, PCM queue bound, capture rule or Hub policy is changed.

SRP separates payload validation, sample-progress quality and resource ownership. DIP uses narrow decoder/frame ports; shared speech-format constants remove a lifecycle dependency while preserving old imports. The existing host-timed publisher and large Worker runtime remain explicit SRP/DIP debt, with the native sample-clock publication port as their next seam. Signaling/Hub authority remains separate from browser execution.

### Sequence decoder and authority-fenced artwork

`decodeAvatarSequenceClip` now implements the frame-decoder port with an owned muted/paused blob video. It validates dimensions, bounded duration, silent/nonlooping state and exact owned URL, seeks each requested frame midpoint sequentially, and copies a bounded256x256 ImageBitmap. It never calls play or any capture API. Source cancellation closes the video and URL; bitmap work already in flight remains owned until its late result can be disposed. Invalid shapes, positions, overlap or resource replacement fail closed. This adapter is implemented but its real-browser decoding behavior is not yet accepted; deterministic ports currently verify lifecycle and error handling.

`sequenceArtwork` joins the prepared atlas and native sample clock through the existing small artwork interface. Authority is checked before sampling, after drawing and after observation callbacks. A failed or changed generation closes the atlas permanently. Synthetic/import/test labels remain outside supplied pixels. No wall-clock-derived counters are substituted for native sample progress, and the observer cannot authorize a frame. Source lifecycle, surface publication and endpoint wiring remain their existing owners.

The focused decoder/artwork/preparation/clock plus existing video/speech regressions passed125cases in895ms; strict isolated TypeScript compilation and the49-document Todo gate pass. This is a local implementation slice, not block completion or actual GPU acceptance. The next required work is the additive bounded preparation/activation endpoint, native surface binding, Worker adapter and real shared-clock synchronization gate. SRP separates decoder IO, resource ownership and authority-fenced drawing; DIP keeps injected browser and progress ports small. The existing host-thread timing loop remains documented debt until that native path is verified.

### Pollable preparation and native sequence endpoint

The isolated machine page now exposes additive `avatar.sequenceProbe`, `prepareSequence(sourceId, content)`, `sequenceStatus(id)` and `cancelSequence(id)` methods. Preparation returns an opaque local resource counter immediately; it is not an evidence identifier or authority. The Worker can keep its Hub checkpoints active while preparation runs. Exact source/session/lease-generation/membership/expiry plus absolute and monotonic deadlines fence the retained atlas. Preparation/ready retention is at most20seconds; any changed authority discards it rather than promoting old frames.

After preparation is ready, native speech must be opened and its actual returned generation bound through `avatar.open(sourceId, "persona-sequence-v1", {id, speechGeneration})`. The controller checks live native progress before transferring the atlas to the existing source/surface lifecycle. Active retention is capped by the original scope expiry and50seconds; native source/graph limits and controller heartbeat remain in force. The source ticks this new profile at40fps for sample-driven drawing; old profiles retain5fps and their existing deadlines. A stale cleanup handle cannot cancel a current generation. Page leave/destroy also cancels unpublished preparation.

The capability probe is read-only and requires bound native speech progress, ImageBitmap support and H264 playback support; it does not imply real decoder/publication acceptance.129 targeted tests passed in999ms, including authority changes, late completion, backwards clocks, stale cleanup, source pacing and existing page lifecycle. The Angular application TypeScript check passes. Actual browser decoding/publication, Worker checkpoint integration, GPU multisegment synchronization and block-wide checks remain required before this track is done.

SRP separates preparation control from rendering and existing publication ownership; DIP uses a small preparation port and read-only speech-progress callback rather than coupling avatar and speech services. This is browser resource execution only: no Hub Task queue, policy issuer, peer list or capture path is added.

### Assigned native sample-clock Worker integration

The assigned Worker now supports the additive native sequence port under the explicit default-off `MEET_COMPANION_NATIVE_SEQUENCE=1` flag. It renders bounded clips before opening speech, keeps current Hub/source checkpoints running during pollable preparation, binds only the actual returned speech generation and validates per-segment played-sample quality receipts. Selected native failures never silently fall back to the old host-timed path. Explicit avatar withdrawal may still retire optional avatar output while bounded authorized audio continues. Active sequences defer lease replacement without extending the original Task or source deadline.

Native quality requires actual renderer observations for every sample window and exact completed speech, with the unchanged41667us bound. One-frame final tails are balanced into two valid clips without exceeding120 frames per clip. Separate browser adaptation and sequence publication modules protect SRP and narrow injected ports protect DIP; the large existing runtime composition remains documented debt. No Hub task, policy or Registry ownership moves into the Worker.

65 targeted Worker/source/timeline tests pass in8.38seconds;61 frontend sequence tests pass in602ms and Angular application TypeScript passes. The60-source packaged Worker passes its package gate in4.26seconds. The first installed native CPU-tone gate failed at room join after61.01seconds, before native decoding/publication. This is partial implementation with an open installed acceptance gate, not productive migration or GPU/lipsync release evidence.

A bounded diagnostic repeat localized the initial native join failure to empty sequence cleanup returning false, which the existing page lifecycle correctly treated as an unconfirmed stop. Unscoped cleanup now confirms that no resource remains; unknown targeted handles still fail. The page-admission/controller lifecycle regression passes28cases in723ms. Actual installed publication acceptance is still pending.

After that correction, the installed native CPU-tone gate passes in83.13seconds: three native decoded publications complete, six Hub test runs succeed and no Legacy callback is used. Source cancellation terminates the assigned session cleanly. This establishes actual installed browser decoding/publication for this private Chromium fixture, with synthetic model/tool inputs and CPU tone. It does not establish actual GPU, broader withdrawal cases, portable browser support or productive lipsync/release admission.

The combined installed native sequence gate now passes in236.00seconds with the pinned actual GPU LLM and native GPU TTS (CPU fallback disabled). Three complete utterances contain241664/124672/394240 samples, including two multisegment publications. Maximum native renderer start-sample drift is20000us under the unchanged41667us bound. All six Hub-issued test model/tool runs succeed; Legacy calls remain zero, private Task cache is shared and removed after cancellation. All1782frontend tests also pass in14.41seconds. Native source-withdrawal matrix and block verification remain pending. Scope remains synthetic project/repository/tool data plus the local avatar renderer: configured MuseTalk, productive release and portable browser support are not established. Earlier host-timed failures remain historical observations, superseded only for this explicitly selected native path.

Nine installed native source-withdrawal cases pass in695.18seconds with actual SQL Hub/Worker/Chromium execution and synthetic model/CPU-tone inputs, including four-second active speech and killed speech preparation. All use zero Legacy callbacks. A separate explicit test-only `MEET_COMPANION_INTEGRATED_GPU_WITHDRAWAL=1` additionally selects assigned speech-mid-speech for the actual model/GPU fixture. That gate must observe exactly one completed native GPU utterance longer than10seconds and an unchanged early retirement boundary before half its PCM is submitted; any later second utterance or short substitute fails. Normal actual GPU acceptance still requires all three complete utterances.21 fixture validation tests pass in3.68seconds; the new actual hardware withdrawal result remains pending.

The remaining five normal/cancellation/deadline cases passed; the first crash result was spoiled only by optional diagnostics attempting exec in the intentionally stopped container. Diagnostics now preserve Hub SQL results and explicitly report unavailable browser observation; two regression tests pass. The isolated actual crash/deadline/reconciliation case passes106.49seconds. All16current-image native lifecycle cases are individually verified across batches.

The first actual GPU withdrawal attempt failed197.73seconds at model inference before any TTS, during the broader native suite; contention is not proven as its cause. After the broad suite ended and a coded early model-error diagnostic was added, the isolated hardware gate passes123.98seconds. Actual native TTS produced260608samples (>10s) in44.54seconds. Current Hub speech withdrawal stopped PCM before half was submitted; exactly one utterance was produced, all subsequent model replies did not resume speech, all six Hub test runs succeed and the private cache is removed. This verifies actual long GPU withdrawal while preserving all original limits.

Full repository prepare passes1782frontend/build/static/leakage/Go unit-vet checks. The Node suite finishes1796pass/1fail/5skip in877.816seconds; a separate native two-source audio-broadcast test fails after screen-audio revoke waiting15seconds for renewed output-ready. Infrastructure was not reached. Therefore full block completion remains open despite the verified native Companion path. Missing MuseTalk and productive release/latency work remain explicit.

The third full Node check reports1800pass/1fail/5skip in849.756seconds. Passive projections keep source authority/generation/publication stable; a separate native incoming microphone clock closes with expiry code3 and the output correctly becomes silence. This does not invalidate the verified Companion own-speech sample-clock path, but keeps the required repository block gate open. A private test-only source_clock.go overlay now captures pre-close accepted/offered SenderReport counts and report-versus-quarantine expiry booleans in a closed v2 snapshot (v1 remains accepted unchanged). It samples no new time or authority, exports no IDs/NTP/RTP/SSRC/content and keeps the12second clock policy unchanged.9unit tests pass82.698ms; five paired actual cases pass210.746seconds, with no expiry subtype observed in that successful run. No release source or production policy changed.

Final complete `npm run check` exits0:1782frontend tests,1803Node passes/0fail/5explicit skips in847.965seconds; build/static/leakage/Go unit-vet pass.14optional live-infrastructure gates remain explicitly skipped, not accepted. The closed native sequence track is now locally complete with all16installed lifecycle cases and actual GPU multisegment/withdrawal acceptance. Earlier unrelated incoming-clock failures remain retained and unexplained, not claimed fixed. Parent Meet scope still requires configured MuseTalk, latency tuning and productive rollout/release admission; default-off opt-ins and original limits remain unchanged.
