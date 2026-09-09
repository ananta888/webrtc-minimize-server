# Explicit early audio-segment completion

## Source audit and plan (2026-09-09)

Source `0915ad9` already exposes bounded, publication-bound audio open/poll/ACK
and one source-bound reply. Ananta `730bdda73` binds optional local ASR profiles
to normal Hub Tasks and uses fixed 1–10 second windows. The browser still lacks
a safe early endpoint for a Worker-selected speech/silence boundary.

Add an optional `audio.segmentProbe()` returning a closed
`sample-boundary-v1` support document, and `audio.finish(subscriptionId,
endSample)`. This changes no legacy probe fields or default window behavior.
Finish requires the exact current subscription, unchanged receive/session/source
authority, an integer 100-ms boundary of at least one second, and equality with
the last acknowledged sample. It cannot manufacture a consumed range, finish
another subscription, extend a deadline or confer send permission.

Before completion, stop the audio graph and wipe every queued sample after the
boundary. Late callbacks are also wiped. Keep only current bounded subscription
authority and the existing one-reply fence; revocation or expiry still closes
everything. No ASR, transcript, SFrame key, media storage or raw-media route is
added to Meet. Source capture remains synthetic/explicit in tests; no person
must approve or interact to unblock them.

Verify exact/idempotent finish, early/unknown/stale/unacknowledged boundaries,
queue/late-callback erasure, no reply without send rights and source revocation.
Then run actual decoded audio through Chromium/Firefox synthetic identities and
an isolated full check. MDS-03 stays open until all its acceptance criteria are
reviewed. The serving build, public service and operator trust remain untouched.
