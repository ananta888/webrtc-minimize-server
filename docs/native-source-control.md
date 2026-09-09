# Native source-program control (opt-in)

`NATIVE_PACKAGER_SOURCE_PROGRAMS=disabled|enabled` is a **local operator opt-in**,
default `disabled`. Unknown values fail startup. Compose forwards it explicitly.
It is separate from `NATIVE_PACKAGER_SOURCE_BUDGET`: capacity is not permission.
No environment, server policy or Ananta trust is activated by this implementation.

The production server still emits only assignment v1/v2/v3, and the agent still
advertises version 0.8.0. Enabling this switch alone cannot create a broadcast
source request or publisher grant. Public v4 emission/capability promotion,
source recovery/discontinuity and public Approve/Renew remain required work.
The switch is intended for the bounded integration path until those are ready.

## Wire and ownership

The existing outbound WSS connection uses normal certificate/hostname validation
and TLS 1.2 minimum. The agent responds to the server challenge using its current
P-256 identity. Source-program commands require the matching authenticated
response, current consented room, exact device, tenant/epochs/leases, probed
encoders and local resource ceilings. Neither a valid parse nor a room consent
alone authorizes decrypting another publisher's source.
The authenticated response is accepted exactly once per connection; it is not
a session renewal. A duplicate closes the connection. Context cancellation is
checked around reads and again after the first authentication store, so an
in-flight handshake cannot overwrite the cancellation fence.

The control decoder recognizes v4 only through the explicit opt-in and validates
the complete closed v4 contract, freshness and 64-KiB budget. It retains an owned
copy of wire bytes in a separate slot; v4 never populates the legacy publisher
slot. Its timestamps and permission are checked again at actual admission, so
time spent queued does not extend an expired command. The legacy decoder itself
remains closed to v4. Unknown versions, field aliases, duplicate fields and extra
fields cannot create an alternate source path.

One worker per connection performs construction and prepare retries. At most
eight further messages can wait (at most nine 64-KiB source messages owned by
worker plus queue); no goroutine is created per queued request. Socket reading
continues during construction, allowing room revocation, renewals and stop.
Overflow and worker errors close the connection fail-closed. Pending wire buffers
are erased when consumed or on shutdown; this is not a claim to erase every
runtime copy of parsed metadata or already transmitted credentials.

Session invalidation and the exact owner's nonblocking fence precede cleanup.
Stop acknowledges only after owned resources have actually finished reaping.
If stop arrives before the queued prepare has reserved an owner, the unknown
assignment causes connection closure instead of a fabricated stop ACK; queued
work cannot subsequently resurrect that session. A held constructor cannot hide
room revocation, but final cleanup must still wait for it to return. No registry
lock is held across codec construction or waiting for process exit.

## Output status

| Status | Evidence / meaning |
|---|---|
| `ready / CAPABILITY_READY` | The authorized bounded local generation exists; initial status was sent. |
| `starting / PROGRAM_STARTING` | Ordered transition toward output readiness. |
| `running / OUTPUT_READY` | The generation's guarded HLS output is actually ready. This can still be slate/silence. |
| `stopped / STOP_COMPLETE` | The explicitly stopped owner and its resources finished cleanup. |

Only after the initial ready send completes does a one-shot observer wait for
the generation's actual output-ready signal. It rechecks current permission and
output lifecycle. Existing status serialization orders it with retries, health
changes and stop; repeated prepare cannot attach more observers, reset the
encoder, change deadlines or heal a later degraded status. A failed status send
invalidates the program. Output readiness proves neither source reception nor
ASR/dialog activity, and carries no media/key material in the control plane.

## Verification

Native unit/race tests cover opt-in parsing, strict routing, owned wire bytes,
legacy isolation, missing authentication, ordered readiness, duplicate observers,
late readiness after revoke, status-write failure, queue capacity, held
construction, immediate room/session fencing and queued-byte cleanup.

`TestLiveTrustedSourceControlSocket` uses an ephemeral TLS server and a client
trust store containing only that fixture certificate. The production dialer
retains its unchanged system trust. The fixture verifies the actual P-256 proof,
uses the real connection loop, local budgets and FFmpeg/HLS generation, observes
ordered ready/starting/running messages, prepares an exactly owned source receiver,
performs three renewals with prepare retries, and checks cleanup after explicit
stop, remote disconnect and local cancel. Disabled mode and an absent authenticated
response are denied before allocating a program. A duplicate authenticated
response closes and reaps an already running program. It joins the existing Node
native-codec gate and skips explicitly without required opt-in/infrastructure.

This is synthetic control/source policy and real **slate HLS**, not an actual
publisher's RTP/SFrame-to-broadcast proof. Existing VP8/Opus/HLS and browser-source
gates provide separate evidence; the complete multi-publisher workflow must still
connect those boundaries with recovery and public consent before promotion.

On 2026-09-09 the isolated aggregate check on `95875db` plus this control slice
completed successfully: 874 frontend tests, 880 Node passes, zero failures and
two explicit Node skips (Node 462.522 s). Build, types, Go unit/vet and static
gates passed; the 14 external infrastructure opt-ins remained explicitly skipped.
The focused control/assignment race matrix passed three repetitions (16.856 s).
The separate real TLS/P-256/HLS control gate passed (42.453 s including shared
native compilation). Root serving assets were not rebuilt. The subsequent
`cfca893` receiver-observation test-only change passed its 12 focused checks;
it was not part of that aggregate snapshot. Later chat changes are separate.
