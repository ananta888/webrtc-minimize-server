# Two-machine publisher isolation (MDS-08 / Ananta MAP-28)

Source baseline `c3e378a`: existing machine browser tests cover one admitted
machine and one receiver. The production admission/session/source contracts
are separately bound, but simultaneous publishers have not been verified.

Add a bounded private fixture extension for exactly one additional machine,
with a separate browser context and independent synthetic subject, task,
runtime and session. Reuse the same ephemeral trusted issuer and required
SFrame policy. The fixture owns all cleanup; no production server, serving
build, operator key or user profile changes.

Verify two distinct persona images and screen colors at one Chromium/Firefox
receiver while both real audio tracks carry samples. Reject cross-session
source opening. Removing one machine must leave the other machine's correctly
attributed media working. Tests are entirely headless and bounded; synthetic
audio is generated locally, never captured from devices. Keep identifiers and
contents inside private assertions; reports contain only closed numeric/state
observations. Use a dedicated multi-publisher observer/scenario (SRP), not
another mode in the single-dialog bridge.

This browser-only gate is a single-host technical observation. Ananta's
separate Hub/two-Worker-container/role-assignment gate is still required; no
production release, GPU concurrency, public TURN or completed MAP-28 claim
follows from the browser gate alone. Run targeted Chromium/Firefox checks and
the isolated complete check, preserving and fixing any reproducible failures.

## First implementation check

The new Chromium/Firefox three-context matrix passed both cases in 7.568 s.
The receiver decoded red and blue persona images with separately attributed
red/green screens and one active speech track per publisher. Server-assigned
peer IDs, authenticated principals and device fingerprints were distinct;
foreign screen source IDs were rejected. After one machine left, its media
disappeared and the survivor published blue/green media with active audio
under freshly opened source generations. Zero capture calls and transform
errors were observed. This tests recovery after the membership fence, not
uninterrupted playback across a room epoch change. The first test attempt
incorrectly read a nonexistent `status().peerId`; the fixture now resolves
the actual newly admitted member from its own server registry without adding
an application API. No production code or test deadline was changed.

The subsequent six-case Chromium/Firefox regression (multi-publisher, persona
image replacement and stale screen decoder) passed in 18.649 s. The isolated
complete `npm run check` at `af582c0` then passed: 665 frontend tests, build,
security, Go unit/vet and 745 Node tests; zero Node failures and two explicit
Node skips, 204.507 s for the Node stage. Fourteen opt-in external-infrastructure
gates were explicitly skipped, not verified. The run used the separately
extracted local Go 1.24.13 / FFmpeg 8.0.1 tooling profile. Previous intermittent
browser/Docker-fallback failures are not claimed causally fixed by this pass.

Ananta's two-Worker-container gate remains pending. Its source audit also found
the missing Hub selection of independently assigned Worker destinations; that
implementation is tracked in Ananta's MAP-28 contract.

## Real Hub / two packaged Worker bridge

The dedicated private `machine-multi-hub-bridge.mjs` observes two real Ananta
Worker containers rather than joining synthetic in-process Worker doubles.
It matches the actual admitted members to two Hub role-derived principals,
requires distinct device identities, attributes moving screens individually,
and verifies independent task cancellation and survivor recovery. It accepts
expected subjects and a small closed command set, never grants or policy
overrides. Root-side containers use an immutable installed Worker image with
no Worker source or Hub package mounts. This remains a single-host synthetic
policy screen/lifecycle gate, not two-container audio/persona evidence.

A real failure exposed the old private forwarder's 16-connection ceiling:
one recorded connection-drop event corresponded to a reset Hub TLS backchannel
and a correctly terminated Worker. The first isolated green repeat did not
explain the failure. The two-Worker fixture now explicitly chooses a bounded
32-connection profile; all existing callers retain 16. CPU/RAM/network/TLS,
admission, SFrame and stop deadlines are unchanged. A saturated diagnostic
counter retains at most eight fixed capacity events, no traffic contents.
The gate requires zero drops. Six deterministic proxy checks passed; the first
corrected real gates passed in 41.83 s and 41.27 s, both with zero connection
drops; the second no longer installs the temporary global HTTP diagnostic
wrapper. Full isolated regression follows before
push. No unrelated intermittent single-Worker failure is claimed fixed.

The isolated complete check at `e7c2344` (including upstream `5e002cf`) has
now passed: 665 frontend tests, build/security/Go unit+vet, 752 Node tests,
zero failures and two explicit Node skips, 241.028 s for the Node stage.
Fourteen opt-in external infrastructure gates remain skipped, not verified.
The check used the separate local Go 1.24.13 / FFmpeg 8.0.1 tooling profile;
no serving build or service was replaced.

Next, extend the observation-only two-Worker bridge with separate media commands
for exact per-principal persona pixels and simultaneous decoded audio, automatic
receiver-owned chat consent/input, and independent avatar revocation. Reuse the
existing per-connection multi-publisher observer; media/Hub policy remains in
Ananta. Root's separate scenario supplies explicitly synthetic PCM through real
Hub child tasks and respects the existing chat cooldown. No device capture,
synthetic model-success claim, policy override, raw media/identity export or
new Worker scheduler. The default screen-only gate remains supported.

The separate media command helper now implements those observations. Fresh PCM
is sampled from both associated peer connections in the same callback and must
be active for three consecutive observations; historical peak counters cannot
prove simultaneous speech. The existing Chromium/Firefox matrix also checks
fresh audio and denies foreign screen, speech and avatar source identities.
The receiver uses its ordinary consent UI and verifies the selected peer's
grant, with no policy overrides or human intervention. A private closed command
step/publisher-index diagnostic contains no UI text, grants, keys or media.

Ananta's first packaged media pass took 69.90 s; 49 root fixture tests and five
bridge unit checks passed. A subsequent combined root run passed screen-only
but failed during consent, so acceptance is still in progress. Its passive
Worker chat-ready marker observes unchanged native behavior, not an admission
bypass. Independent image withdrawal and source ownership remain separate
from model inference, public TURN, production evidence and speaker fairness.

The remaining consent failure reproduced at the second checkbox before either
Worker failed. The fixture now observes Angular's completed target/reset render
before emitting another input event; no policy, grant or input is replayed.
The membership-loss observation after the earlier bridge failure was cleanup,
not a demonstrated production session fault.

After that correction Ananta's combined packaged matrix passed both cases in
103.64 s (screen-only 42.234 s, persona/speech 61.045 s including fixture
lifecycle), with two independent child replies, three fresh simultaneous audio
observations, independent avatar revocation and zero remaining Worker containers.
The isolated full companion check remains required before pushing this slice.

The first isolated full check at `b0d6c10` passed 665 frontend tests, build and
static/security gates, then failed the native packager's pre-existing key-only
fixture at `source_transport_boundary_test.go:193`: no initial key announcement
within three seconds, before its media-shape stimulus. Ten isolated repetitions
reproduced two failures (41.671 s total). No source-media success or complete
regression result follows from that run. Next preserve fixed connection/channel/
receiver states and signaling error counters only on fixture failure, then
isolate and correct the cause without widening the timeout or replaying keys.
No SDP, candidate addresses, source IDs, keys or error strings may enter the
diagnostic. This is test observation, not a production transport change.

Failure-only diagnostics reproduced another startup failure in ten runs
(33.664 s): local ICE remained `checking`, remote ICE was `connected`, both
connections were still `connecting`, no data channel was attached, receiver
authority remained alive and no SDP/candidate operation failed. Thus the test
had not reached key admission; teardown and decoder changes are not its cause.
The key-only fixture currently discovers every host/Docker interface. Restrict
only this same-process fixture to real IPv4 loopback UDP candidates, preserving
the production API's codecs/interceptors, SCTP memory cap and three-second
deadline. Assert its gathered candidates are loopback; do not change production
ICE, TURN, browser or media fixtures. Verify repeated actual handshakes and all
negative channel/sequence cases before another isolated full check. This does
not claim to repair arbitrary host-network ICE establishment.

The key-only fixture now applies an explicit loopback UDP setting to the same
production codec/interceptor API before creating either PeerConnection, with
the existing 256-KiB SCTP receive limit. Its gathered SDP is checked locally for
host-only IPv4 loopback candidates (never logged). The first fixture-only
attempt omitted Pion's initialized logger factory and failed immediately; that
configuration error was corrected explicitly, not attributed to transport.
All twenty repeated five-case real handshakes and candidate-boundary checks
then passed in 2.656 s, versus three reproduced host-interface startup failures
in the two earlier ten-run batches. The complete packager Go suite passed in
17.426 s plus 0.234 s for the SFrame package. Race/vet and isolated full checks
follow; no test deadline, production network or cryptographic policy changed.
