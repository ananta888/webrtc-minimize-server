# Separate camera/screen receive authority

## Source audit and plan: `b23de52`, 2026-09-09

MDS-13 adds a default-off `video.receive` capability; sending an avatar or screen
and receiving audio confer no visual receive rights. Publisher-owned consent
selects exact currently active camera/screen IDs, with independent capability
checks in server policy and browser key/subscription gates. Grants remain bounded
to at most four current audiovisual sources. No room actor may grant another
publisher's source; no machine may create its own receive grant.

Use a separate optional visual probe and bounded subscription/frame port. Bind
actual session/lease/generation, room, membership and receive revisions, peer,
publication ID/epoch and current track. Sampling uses only an authorized remote
decoded video track, not capture APIs, room mix, URLs, user profiles or arbitrary
tabs. Bound dimensions, bytes, frame count, interval and in-flight work. On
revocation, source/epoch change, timeout or close, stop owned decoding/rendering
resources and discard late frames. Signaling never handles raw frames or keys.

The UI offers camera and screen only when the selected machine has visual receive
capability, without changing existing audio-only editor behavior. It explicitly
states that a granted AI endpoint can decrypt/analyze selected content, not that
it is a blind relay or may record/train/use external providers. Source selection
is never a capture trigger. Automated policy/DOM fixtures remain fully headless.

Ananta owns task/analysis/provider policy; Meet exports only scoped bounded frames.
Test all capability/source combinations, key-delivery denial, selection snapshot
changes, bounded pixels, late-callback cleanup, lease/source revoke and actual
Chromium/Firefox synthetic camera/screen reception before declaring completion.
Keep the public serving build and operator trust unchanged during implementation.

## Policy, source identity and editor implementation, 2026-09-09

Server and browser receive gates now require the source-specific capability for
each of up to four explicitly selected current audiovisual publications. Only
visual-capable recipients receive the registry-issued publication epoch in a
camera/screen announcement; caller-provided epochs are discarded. Repeated
announcements preserve identity; stop/restart advances it. Audio-only signaling
retains its previous shape. A separate mesh read port checks the remote track,
publisher, descriptor, source epoch and current grant without initiating capture.

The editor conditionally adds camera/screen selection, preserves old audio-only
selection shape and rejects stale visual source IDs. Its component is deferred
inside the analysis view: the candidate first exceeded the 1.6MB initial bundle
error budget by 1.91kB; deferral restored a successful 1.59MB build without
changing the budget. The existing 1.5MB warning remains visible.

Pure capability/selection modules and a read-only source port keep policy
separate from decoding (SRP/ISP/DIP). The broad PeerMesh class remains existing
SRP debt; visual decoding belongs to a separate service/factory, not this class.
Focused policy/epoch HTTP-WebSocket tests passed27/27; full candidate frontend
tests passed825/825 in10.94s (including the subsequent visual-port candidate).
Further isolated full checks and Ananta analysis integration remain pending;
this is not public deployment or production evidence.

## Owned pixel-decoder port

`MachineVisualSurfaceFactory` owns only a clone of the admitted remote track,
a silent video element and a cleared canvas. It bounds input pixels, downsizes
without upscaling to640x360, accepts only JPEG up to98,304 bytes and explicitly
wipes late decoded byte arrays. Construction failure, abort and sink-cleanup
exceptions still release the clone; the publisher track is never stopped.
`visualOperation` bounds setup/encoding waits and disposes late results. Its
consumer owns authority and rate/count budgets separately. Fifteen focused
surface tests passed, including late Blob/array-buffer completion and partial
construction failure. This port does not itself grant permission or retain
media. JavaScript immutable strings/Blob backing storage are not claimed to be
forensically erased; references are discarded and no content is persisted.

## Bounded subscription and real browser verification

The additive `anantaMachine.visual` port exposes closed probe/source/open/frame/
close/status operations. One subscription binds all planned scope fields and the
actual publisher epoch, grant deadline and track. It permits at most three
frames, at least500ms apart, for at most10s, with one outstanding2s-bounded
operation. Current authority is checked before and after decoding and every100ms.
No chat reply or audio right is inferred. Reopen/expiry/revoke cancels the owned
decoder and fences late completions from a previous subscription.

Twenty-four focused lifecycle tests passed. Four real browser cases passed in
10.37s: Chromium and Firefox synthetic publishers, each camera and screen,
received by the isolated Chromium machine client over required SFrame. Each
verified selected-source color, actual epoch, bounded dimensions, zero machine
capture/audio sources, rate denial and post-revoke denial; no transform errors.
The initial camera test incorrectly demanded640px despite adaptive320px input;
it now asserts the actual maximum and aspect ratio without forcing upscaling.
This does not yet verify a Firefox machine receiver or Ananta analysis.
The old client probe/capabilities wire remains exact. Public serving assets and
operator trust are unchanged. Full isolated check remains required before MDS13
closure; these synthetic observations are not grounded production evidence.

## Isolated full regression, source `aeefe31`

`npm run check` completed with exit0 on2026-09-09 in a separate worktree:
844 frontend tests and851 Node tests passed, zero failed, two Node tests were
explicitly skipped. Node execution took340.58s. Production build, Go unit/vet
and static configuration/security gates passed. Fourteen external infrastructure
gates remained explicit skips; neither these skips nor the optional image-scan
skip are claimed as live verification. The public serving tree was not rebuilt.

## Next integration fixture

Source8820762/Ananta6dd94fb35: add a private stdio-only visual publisher fixture
for Ananta's packaged-Worker acceptance. Reuse the verified synthetic camera/
screen producer and real owner UI consent. The bridge accepts only fixed start,
revoke, stop commands and one fixed camera/screen test profile; it does not
accept Tasks, grants, URLs, media contents or keys through stdio. Ephemeral
TLS/auth/internal network remain owned by the existing fixture. Ananta observes
its actual Hub child and structured callback, with no application-source mounts
in the receiving Worker. This is synthetic local integration, not public trust
or production evidence.

The private integration bridge and reusable synthetic publisher helpers are now
implemented. The original four actual camera/screen browser cases still pass
(10.41s) after extraction; no production code or serving assets changed. The
bridge itself must still be exercised by the packaged Ananta acceptance test.

## Packaged Hub and browser-engine matrix

Ananta source `f223cbe53` / packaged image `bd4cc14c24a8` passed actual
camera/screen receipt, native image statistics and Hub child completion in66.58s.
The extended pair passed104.85s: regrant permits a fresh bounded assignment and
revoking it while active prevents completion. The test helper now waits for the
revoke ACK and editor reset before checking a source again; previously an old
checked DOM could skip the new checkbox event. The bridge returns bounded stage
diagnostics rather than exception text or credentials. No production rule changed.

The private browser fixture additionally selects an explicit machine engine,
default Chromium unchanged. All eight publisher/receiver Chromium/Firefox ×
camera/screen combinations passed22.03s, including decoded color, exact source
epoch, bounds, no machine capture and denial after revoke. Initial Firefox
receivers exposed the already documented ZoneAwarePromise readiness issue in
`page.waitForFunction`; the existing host-side closed-value wait now handles
both source readiness and revocation. Reports name the actual receiver engine.
The next isolated full check includes this expanded fixture matrix.

That check exposed an infrastructure-test discovery error: Node imports files
under test/helpers too, and the new visual stdio bridge executed without its
explicit packaged gate. The bridge now follows the existing opt-in convention;
activated invalid profiles still fail before allocating resources. Four receive
bridge opt-in/refusal checks passed2.73s. The failed full run is not claimed green;
the corrected committed fixture must pass the isolated check before closure.

## MDS-13 completion

Committed `d57096d` passed the isolated `npm run check` with exit0:844 frontend
tests,863 Node passes,0 failures and2 explicit Node skips; Node duration340.96s.
Build, Go and static/security gates passed. External infrastructure and optional
image scanning remain explicit skips, not claimed evidence. The eight real
browser-engine/source combinations are included. Together with the actual
packaged Ananta analysis/regrant/revoke gate, the four scoped MDS-13 criteria are
met. Only this visual receive port is complete; the surrounding dialog track,
Ananta's remaining receive work and public/production gates are not closed.
