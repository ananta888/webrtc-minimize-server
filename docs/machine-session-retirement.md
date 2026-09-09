# Exact Hub-owned session retirement

MDS-06 / Ananta MAP-11 source audit, 2026-09-09 (`b11d749`). Renewals
preserve one membership and reject duplicate v2 Task occupancy, but Ananta
cannot obtain a positive bounded acknowledgement that an old session was
retired before an explicitly authorized reconnect. This slice adds retirement,
not automatic rejoin, trust configuration or any grant/receive-policy issuer.

`POST /api/machine/sessions/retire` uses the same current verified v2 Hub
grant and closed `{roomId, sessionId, nonce}` body as the existing control
backchannels. A present record must match every immutable binding field.
Retirement first invokes a narrow synchronous membership-detachment port;
only a confirmed detachment permits removal of the lease and a receipt.
An exception/unconfirmed detachment must not free task occupancy. Socket close
alone is insufficient because room cleanup is otherwise asynchronous.

An already absent ID is idempotent but proves no previous ownership. The
receipt binds the caller identity and request nonce, not an invented historical
record. The Hub must already possess its independently validated original
membership, enforce an attempt budget/current assignment and wait for bounded
source cleanup before a new grant. Retirement cannot create a new peer, expand
capabilities, transfer consent, lengthen the original task or reopen old input.

Tests must cover exact-scope rejection without mutation, failed detach, ticket
and renewal replay, late retirement of an old ID after replacement, ordinary
lease compatibility and actual authenticated HTTP/WebSocket removal. All test
identities are synthetic. No public deployment or production evidence claim.

SRP/ISP: session ownership stays in `MachineSessionLeases`; membership teardown
is injected as one narrow port from the existing owning server. The broad HTTP
dispatcher remains existing SRP debt; no Worker or peer scheduler is introduced.

## Retirement-port verification

The receipt is implemented as `ananta.meet-session-retired.v1` with exactly
`schema`, `nonce`, `sessionId`, `binding` and `retired: true`. Attached sessions
require the new synchronous detach port; unattached tickets can be retired
without creating membership. No fallback treats WebSocket closure as confirmed
registry removal. Existing authorization/observation/renewal contracts retain
their shapes and behavior.

61 targeted lease/retirement/observation/task-occupancy/trust checks passed in
0.832 seconds on 2026-09-09. The actual signed HTTP/WebSocket case verifies
two independent tasks, exact old-peer removal, an independently admitted new
device for the same task, denial of old authorization, and harmless late old-ID
retirement without touching the replacement or other task. All traffic is
private loopback with ephemeral synthetic Ed25519/P-256 identities, not public
TLS/receiver stop or automatic Hub reconnect evidence. Log:
`/tmp/ananta-meet-retirement-final.log`.

The preceding full isolated `npm run check` at `b11d749` passed 874 frontend
tests, build/typecheck/security/Go and 896 Node checks (351.836 s, zero failures,
two explicit skips); 14 external opt-in gates remained skipped. Concurrent
upstream `f714942` and `8a5fdd2` were subsequently preserved while rebasing only
three unpublished local commits. Both sets of TODO notes were retained;
48 focused chat/floor helper checks passed after integration. That earlier
aggregate does not cover this retirement implementation. The next combined
regression must include it before the recovery track is completed.

## Packaged multimedia recovery follow-up

The private two-Worker fixture now samples silence across all receiver audio
tracks, including retired connections no longer associated with visible video.
After interrupting active synthetic speech, two new memberships restore the
same pinned personas and moving screens. Receive consent must be newly granted
before a second correlated answer; neither the old input nor audio is replayed.
The third interruption exhausts the original Hub attempt budget. The fixture
navigates back from Chat to Live before observing the participant counter; no
person is required and no production UI, consent or policy behavior is changed.

Actual Ananta Hub/immutable Worker image `e0cea0174a7e` with Meet `87b1a0f`
frontend and these test adapters passed in 57.78 seconds: recoveries
6,524.61/6,010.07 ms, exhausted stop 437.82 ms, independent survivor and final
revocation, zero human capture/transform/proxy errors. Prior Hub control delay
and the independent third-departure fixture failure remain documented in
Ananta's `docs/contracts/meet-control-refresh-latency.md`. The Hub used its
explicit eight-connection SQLite pool, without cached authority or relaxed
freshness. Twenty-two targeted helper checks passed in 0.531 seconds.

These are private synthetic-policy technical observations, not public TURN,
multi-host, two-hour soak or production release evidence. A combined isolated
repository check remains required before closing the lifecycle milestone.

The isolated combined check at `12235df` subsequently completed with 914
frontend tests passed, successful type/build/Go/static checks, and 945 Node
tests passed, one failed and two skipped in 380.403 seconds. The failure is
the six-human Chromium trusted-relay topology wait before camera capture,
not the packaged reconnect test. The infrastructure tail was not reached.
MDS-08 retains this compatibility failure; bounded failure-only eligibility
counts and browser mode enums are being added before targeted reproduction.
No topology or permission rule is relaxed and this aggregate is not green.

Targeted diagnosis reproduced the failure four times (33.287/33.141/33.206/
33.005 s). Both browser checkbox events and outgoing consent messages were
observed, but server `rate_limited` errors accompanied missing registry consent.
The host had 94 interfaces / 31 IPv4 interface addresses. For this single-host
six-peer test only, Chromium now uses
`--force-webrtc-ip-handling-policy=default_public_and_private_interfaces` to
avoid enumerating every Docker bridge. This preserves private-IP connectivity
on the default interface; see the
[Chromium IP-handling policy](https://chromium.googlesource.com/chromium/src/+/376fc41e87a058f7a7b300b0ec3a4982b4ec0960/components/policy/resources/templates/policy_definitions/Miscellaneous/WebRtcIPHandling.yaml).
The unchanged 240-message/10-second server ceiling and real explicit consent
then passed the entire relay/camera/adaptive-tier/mosaic case in 6.920 seconds.
No host interface, runtime policy, timeout or serving build was changed. This
is a bounded fixture network profile, not a claim about unrestricted host
candidate storms or public NAT interoperability. Combined confirmation follows.
