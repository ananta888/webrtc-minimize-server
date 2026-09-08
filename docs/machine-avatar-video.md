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
permit early; late work cannot attach a camera. Repeated blocked attempts do not
enqueue more decoders. Setup is bounded to two seconds inside the unchanged
source's 2.5-second controller watchdog and 30-second activation lease. Each
frame still requires current session, membership, generation and key protection.

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
