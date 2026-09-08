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

Component verification: all 749 frontend tests passed in 9.95s; Angular template
type checking passed. Actual private Chromium/Firefox media tests and isolated
`npm run check` are pending. No serving build, public trust or operator policy
was activated by this implementation.
