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

## Implemented and focused verification

The optional probe and finish methods are now exposed. Exact repeats at the
same acknowledged boundary are idempotent until the one reply is consumed;
different/stale/unacknowledged boundaries fail. Completion stops the graph,
wipes later queued and late callback bytes and keeps current authority checks.
A graph-close failure terminates the subscription, never authorizes a fallback.

41 focused frontend tests passed, including ten new segment/probe/boundary
cases and existing graph/client-probe regressions. A separate production Angular
build passed (the existing initial-bundle size warning remains). Real Chromium
and Firefox synthetic receive-only sessions each decoded 17,600 samples, then
finished at 1.1 seconds of a ten-second maximum: 16,985 / 16,971 nonzero samples,
no remaining chunks, exact idempotent finish, chat send denied, and finish denied
after source revocation. Required-SFrame stayed active with no transform errors
and no machine capture calls. The two browser cases took 7.744 seconds total.
The isolated `npm run check` at source `b23de52` subsequently passed: 775
frontend tests, 825 Node passes, zero failures, two explicit Node skips;
Node duration 330.898 seconds. Build, Go unit/vet and static gates passed.
Fourteen external infrastructure gates and the optional image scan remained
explicit skips. The check ran in a detached private worktree, not the serving
directory. This is not production release evidence or closure of all MDS tasks.
