# Read-only machine client capability probe

Source audit: Meet `9de2fa4`, Ananta `3676a9f70`. The legacy
`capabilities()` result deliberately describes the initial MP4 contract and is
not a current dialog readiness report. Keep that v1 result unchanged; add a
separate closed `probe()` / `ananta.meet-client-probe.v1` result.

The probe describes only the installed isolated-browser client: secure context,
the existing encoded-transform support predicate, VP8 and Opus send/receive
codec availability, and implemented versioned machine ports. Codec queries
are bounded to the browser's local `getCapabilities` API; exceptions return
unsupported. No capture, permission request, PeerConnection, key generation,
network request, model call or publication may occur. Return fixed booleans and
version names, never device lists, SDP, addresses, browser versions or identity.

This is feasibility, not a grant, authenticated runtime attestation, completed
SFrame/ACK negotiation or delivered media. Required SFrame, exact envelope,
current per-source grants and all existing watchdogs remain mandatory. Ananta's
Hub still selects the fixed installed browser execution profile; its Worker
checks feasibility before handing a grant to that browser and cannot fall back
to native, LiveKit or plaintext. No compatible native machine publisher is
claimed by this probe.

Compatibility is explicit: old `capabilities()` and closed assignment v1 remain
unchanged. Absence of the additive probe is the legacy fixed-browser path, not
a successful probe result. A present malformed/unknown/unsupported result must
fail closed; it must never be treated as a missing legacy API. Validate the
exact shape and only the ports/codecs required by the closed assignment.

Implement a pure projection with injected capability ports, separate from the
Angular component and encryption controller (SRP/DIP). Preserve the component's
existing broad API composition debt; no new policy or browser scheduler belongs
there. Verify deterministic negative/mutation/no-side-effect cases, actual
Chromium/Firefox probes without capture, Ananta's strict consumer and bounded
session cleanup, then an isolated `npm run check` and private Hub dialog.
Public TURN, native interoperability and production release remain separate.

## Implementation under verification

`machine-client-probe.ts` projects the fixed browser/schema/envelope, strict
secure-context and existing transform-support predicates, independent VP8/Opus
send/receive availability and eight installed port booleans. The schema fixes
their API generation: session, initial MP4, chat, audio, screen, screen-audio,
speech and avatar. It checks every required method's presence without calling
one. Runtime exceptions and missing methods yield only `false`; local codec
lists are capped at 128 entries. Every returned level is independently frozen.

The component adds only `probe()` and keeps the exact legacy `capabilities()`
projection. Eleven focused frontend checks passed (1.23 s invocation): closed
output, immutable copies, missing/broken ports, strict predicates, directional
codecs, errors and no effects. The real no-join Chromium/Firefox gate, strict
Ananta consumer integration and isolated full check remain pending.

## Complete isolated regression

The isolated `025d9ae` full check passed: **676 frontend tests, 762 Node tests,
zero failures, two explicit Node skips**, plus production build, static/security
checks and complete Go unit/vet gates. The Node stage took **241.610 s**; external
live infrastructure gates remain explicitly skipped, not verified.

The new real Chromium and Firefox cases load the actual built machine page,
confirm all fixed ports and directional codec predicates, and check frozen
copies plus exact unchanged legacy output. Neither probe joins a room, creates
a PeerConnection/WebSocket, captures media, enumerates devices, generates keys
or invokes HTTP. Synchronous effect sentinels are scoped to the actual probe
calls so unrelated bootstrap requests cannot falsify the result. Removing
encoded-transform support yields false without changing rights or selecting a
native/plaintext fallback. This is actual local browser feasibility, not media
delivery or production identity evidence. Ananta's packaged Worker integration
is the next gate.

Ananta's fresh complete image `01db5060da48dd832588c84e00e2454b6792020a8236657ed1936f7df33de984`
then passed both actual Hub/two-packaged-Worker cases against this build in
105.70 s: independent screens, persona images, overlapping speech and scoped
revocation/stop, with no application source mounts. The probe slice is integrated.
A separate selected-voice GPU dialog generated both answers but later stopped
on stale Hub control state; Ananta tracks correlated latency diagnosis under
MAP-11/24. This does not invalidate the probe result, nor does the successful
probe close that runtime problem or any public/native/production gate.
