# Bounded TURN payload probe (MDS-08/09)

Source audit `2ce5e2c`: the live infrastructure gate proves authenticated TURN
candidate gathering, but creates no counterpart and cannot prove selected-pair
or payload transport. Keep the newly bounded, secret-free supervisor and the
existing OIDC/session/ephemeral-credential checks.

Replace each candidate-only probe with two owned native peer connections,
both forced to relay. Exchange a fresh fixed-size synthetic data-channel probe
and exact echo, then require current selected relay pairs and connected
DTLS/SCTP on both sides. Do not accept nomination or candidate gathering alone.
The browser sub-operation has its own fixed deadline and always closes its
owned channels/connections. No real media, room payload, capture, identities,
keys, SDP or ICE values are returned.

The report must explicitly label this as same-browser synthetic data-channel
transport: not an independent external receiver, application SFrame/media
delivery, a machine-dialog acceptance or production release evidence. Preserve
failed/absent credential behavior and the whole-process deadline.

Use injectable peer/deadline seams for deterministic refusal, timeout, echo,
stats and cleanup tests. Then run the exact browser function against the
existing private authenticated TURN fixture, separately from the current
long Ananta soak. No public deployment, trust or operator-account change is
authorized by this test implementation.

## Implemented local boundary

`live-relay-payload.mjs` is a self-contained browser function with injectable
peer/nonce/deadline seams for deterministic tests. The public gate invokes its
fixed 25-second profile with authorized ephemeral session credentials. Both
owned peers require relay policy, current selected pair IDs, connected
DTLS/SCTP, relay candidates and positive bidirectional counters. Only after an
exact fresh 32-byte nonce/echo does it report two selected pairs and 32 payload
bytes in each direction. No SDP, candidate address, credential or nonce is
returned. Cleanup failure cannot return passed; late offer completion cannot
start new negotiation after closure.

The supervisor requires the exact numeric row fields and labels results
`payloadScope: same-browser-synthetic-datachannel`,
`externalReceiverVerified: false`, `applicationMediaVerified: false` and
`productionReleaseEvidence: false`. `selectedPairAndPayloadVerified` is true
only on successful completion of this narrow probe; a failed or missing-input
run keeps it false. The fixed whole-process budget and capture guard remain.

On 2026-09-09, **46 targeted tests passed in 2.453 seconds**, covering the new
probe plus existing supervisor, capture/network boundary and selected-relay
stats checks. The real enabled CLI without credentials still returns bounded
exit 1 before browser/network work. These are implementation checks, not a
successful native or public TURN run.

The explicit `RUN_PRIVATE_TURN_PROBE=1` browser test exercises the exact function
against private authenticated UDP and TCP TURN using the existing owned fixture.
It additionally checks zero capture, closed connections and zero proxy drops.
Its native execution was deferred until the concurrent Ananta soak ended;
the full grouped check also follows that milestone. SRP keeps this
transport observation separate from OIDC, Hub admission and application media.

## Actual private UDP/TCP execution

After the independent Ananta soak failed at 2732.759 seconds, the exact probe
was run from a clean `91bc248` worktree and a fresh private frontend build
(9.184 seconds; existing 1.50-MB warning, unchanged hard budget). Both native
cases passed in **10.619 seconds total**: UDP 4.629 seconds, TCP 5.352 seconds.
Each observed two actual selected relay pairs, exact 32-byte payload/echo,
zero captures, zero proxy drops and closed owned peer connections. Credentials
came from the fixture's real synthetic-authorized session response; no public
account or TURN secret was used. The existing private Coturn fixture owns all
ports, credentials, containers and network cleanup.

This is actual local authenticated TURN data-channel transport, explicitly a
same-browser test with synthetic identities. It does not exercise the public
OIDC realm, deployed machine trust, application SFrame/media, an independent
external receiver or the two-hour machine-dialog acceptance. The full combined
check on this updated candidate remains separate.
