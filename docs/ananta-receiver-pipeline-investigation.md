# Private Ananta receiver pipeline investigation

The post-restart Ananta reference `RUN_9c1e519283f6ad02421b85b96d0a4e86`
at Ananta `5a7be27f5` / Meet `c4ef486` failed after 2161.131 controller seconds.
The retained receiver property shows connected/stable ICE, 589 video packets,
zero decoded/keyframes/PLI/NACK, video width/ready state zero and no structural
transform failure. The last source sample was active at generation 145,
sequence 47. These separately sampled observations do not prove a cause.

## Fast isolation profiles

The existing source-churn test still defaults to 18 activations. Explicit
`MEET_TEST_SCREEN_CHURN=extended` selects 80 with one real renewal;
`lease-churn` selects 80 with 39 real renewals. Only these closed profiles are
accepted. Each activation keeps the same frame cadence, 1.5-second decoded
pixel check and single-transceiver/SDP bounds. The extended test's own outer
bound is 150 seconds; source/lease authority is not lengthened.

The active audio/chat/screen regression similarly retains three ordinary
renewals. `MEET_TEST_DIALOG_RENEWALS=extended` selects 39 renewals with a
300-second outer test bound, unchanged real source/receive/decoder limits and
unchanged initial publisher consent. It checks actual PCM, correlated chat,
screen pixels, stale handles and final revocation, not merely lease receipts.

Against the same private `c4ef486` frontend bytes:

- Chromium: 80 sources / one renewal passed in 98.233 seconds.
- Chromium: 80 sources / 39 renewals passed in 98.630 seconds.
- Firefox: 80 sources / 39 renewals passed in 100.039 seconds.
- Chromium: 40 active audio/chat/screen phases / 39 renewals passed in 61.391
  seconds. Every phase had at least 16,000 decoded PCM samples, with retained
  consent and correct final revocation.
- Firefox: the same 40 active phases / 39 renewals passed in 66.197 seconds,
  again with at least 16,000 PCM samples per phase and final revocation.

These are local synthetic technical observations, not Hub-reserved new runs,
an elapsed two-hour test, GPU/public acceptance or a proven freeze repair.

### Browser-runtime comparison boundary

These fast tests use the companion's default native launcher and installed
Playwright 1.62.1. Its manifest selects Chromium 151.0.7922.34 / Firefox 153.0;
read-only inspection confirms the current local Chromium binary reports that
151 version. The exact Ananta browser image `5d4be51c5dda` instead reports
Playwright 1.58.0 and headless Chromium 145.0.7632.6. This is a current technical
inspection, not a retroactively reserved version receipt for past native tests.
Equal frontend bytes do not make these the same browser runtime, so the native
passes do not exclude a Chromium-145-specific failure.

The existing `machine-peer-driver.mjs` adapter intentionally requires the
matching 1.58 remote client. Do not silently downgrade app dependencies, connect
the 1.62 client to that server, upgrade an active test image or infer a repair
from this version difference. After the frozen diagnostic finishes, prefer a
short same-runtime reproduction and explicitly bound version comparisons with
unchanged source/authority/media limits before another long acceptance.

## Test-only pipeline probe

With the explicit `MEET_TEST_SFRAME_PIPELINE_PROBE=1` diagnostic opt-in,
the private Ananta stdio bridge instruments only its test receiver's served
SFrame Worker asset, through a bounded fixture route. Public assets on disk,
production Worker code and runtime crypto contracts are unchanged. This is an
instrumented diagnostic, not byte-identical uninjected browser execution.
The injected source is part of the test-source snapshot for subsequent runs.

The probe counts actual existing TransformStream input and enqueue operations,
silent drops, thrown transforms and pipe completion/rejection. It retains only
the last sixteen lifecycle rows, and reads at most four owned page Workers
under a one-second collection deadline. Collection returns only the last four
rows per Worker with a 6,000-character envelope ceiling, fitting the private
bridge's existing 8-KiB line budget alongside receiver stats. Key setup/clear **command counts** are
observations of messages, not a claim that crypto accepted a key. No media,
context IDs, key IDs, key bytes, messages, SDP or ICE addresses enter reports.
Enqueue counts are not decoded-frame or native-writable acceptance counts.

No extra data streams, retries, artificial frames, policies or periodic browser
RPCs are added. Existing transform and pipe exceptions propagate unchanged.
Instrumentation does add callback/microtask overhead; an eventual causal fix
must also pass the normal uninjected reference. Unavailable probes stay unknown.

Deterministic tests exercise native Web Streams, unchanged frame/error identity,
drops, writable rejection, bounded history, content/key noninspection and
collection timeout. Real Chromium and Firefox tests decoded the source with the
probe installed and no device capture, in 7.812 combined seconds. The initial
new browser test had a nonexistent helper import; that test wiring error was
corrected before these successful runs, not counted as a product fix.
The final bounded-collection checks passed nine cases in 1.153 seconds and
both browser cases in 7.738 seconds. Ananta's explicit diagnostic profiles
additionally require actual probe-observed receiver keyframe delivery at startup;
an uninstrumented old companion cannot silently pass the diagnostic profile.

SRP/DIP: observation is isolated in a test-only helper composed into the existing
fixture. The broad fixture/PeerMesh composition debt is preserved; neither
observer nor fixture becomes a Hub or signaling policy owner.

## Preserved Mini-PC work and current integration check

The three Mini-PC commits `e6e038f`, `37d837d` and `5602ccf` were discovered
before deployment and merged into the laptop's `406f95d` work without rewriting
their history. The sole conflict was independent MDS-08 evidence; both sides
were retained. No Mini-PC checkout, public service, Ananta repository or trust
configuration was changed. The public service was still `5a10338` with one
participant when inspected, so no deployment restart was attempted.

On the merged test sources and the unchanged isolated `406f95d` application
bundle, all nine observer tests passed in 1.092 seconds and both actual
Chromium/Firefox probe cases passed in 9.733 seconds. The explicit extended
active-dialog profile then passed both cases in 135.178 seconds: Chromium
65.987 seconds, Firefox 68.251 seconds, 40 phases and 39 renewals each. Each
phase delivered 16,000 decoded PCM samples, correlated chat and the expected
screen color; initial consent remained unchanged and final revocation held.
No human capture was invoked by the machine. These short local tests still use
the current native browser runtime, not the pinned Chromium-145 Ananta image.
They neither repair nor complete the failed long reference.

The previous complete project check covers `406f95d` before these test-only
additions. The merged revision's CI remains a separate required result, not an
inferred pass from the earlier build or these focused checks.
