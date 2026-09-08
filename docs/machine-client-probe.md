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
