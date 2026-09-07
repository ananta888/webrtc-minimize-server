# Independent neutral avatar port

MDS-11 adds `window.anantaMachine.avatar` to the isolated machine page. The
existing coupled MP4 API and conservative capabilities response are unchanged.
The server already recognizes `avatar.publish`; neither a new trust grant nor
a human capture permission is implied by this client adapter.

`open("avatar:" + hubSessionId, "neutral-ai-v1")` requires current verified
membership, the exact machine session/lease and `avatar.publish`. It returns
`ananta.meet-avatar-source.v1`, profile, generation, width/height 256, fps 5 and
absolute expiry only after its concrete camera track is SFrame-protected and
the first requested source frame succeeds. No text, URL or image argument is
accepted. The fixed drawing includes `ANANTA / KI` and a moving liveness bar;
it is not lip sync, a persona asset or a real camera image.

`status()` reports closed/opening/open/waiting/failed, generation, requested
frame count and expiry. Frames requested are not a remote-delivery guarantee.
`close(generation)` returns false for a stale or malformed generation and never
removes a newer activation. Argument-free close is reserved for whole-session
cleanup in the same isolated controller context.

## Bounds and responsibility

- Maximum 30 seconds including 10-second setup; no self-renewal or hidden
  retries. Session/lease/membership/capability changes and backwards clocks fence
  the source within a 100-ms watchdog interval (subject to browser scheduling).
- Maximum five newly requested frames/second, only from the owned canvas.
  When another publication briefly renegotiates SFrame readiness, the source
  enters `waiting` and requests **no frames**. Identical authority and restored
  concrete protection may resume within two seconds; otherwise it fails closed.
  Neither the overall deadline nor the membership binding is extended.
- Camera ownership is independent of PCM microphone and screen. The legacy
  camera+microphone claim remains atomic and cannot displace these owners.
- Close/Leave releases the exact camera claim, synthetic track, canvas and
  timers. Partial setup and cleanup exceptions cannot retain ownership or
  detach a later source. Required-SFrame never falls back to plaintext.

Lifecycle is a small domain object with authority/surface ports; the canvas
factory owns browser resources; the session service projects existing verified
authority. This preserves SRP/ISP/DIP without adding orchestration to Meet or
expanding the large PeerMesh service. The existing machine page remains only
the composition boundary, not the owner of Hub policy.

## Verification

Source/adapter units cover exact profile, bounds, rate, quiescence/rekey,
revocation, setup/cleanup failures and ownership. The browser test uses two
isolated identities with real ephemeral admission, required-SFrame and decoded
face/label pixels plus a changing indicator. Concurrent synthetic PCM and
screen remain active after avatar-only stop; a real server lease renewal fences
the old source and an old close cannot affect its replacement. All capture
calls are counted and forbidden in this test.

These are private technical/synthetic observations. The neutral port does not
complete Ananta's independent Hub controls, approved image/profile switching,
public TURN, long-running soak or production release gates.
