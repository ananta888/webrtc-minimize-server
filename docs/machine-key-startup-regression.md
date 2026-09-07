# Private delayed receiver-key regression (MDS-08)

Ananta's private cross-repository screen test intermittently received RTP without
decoded video (349 packets, zero frames, 33 source pushes, connected transport).
A green isolated repeat does not identify or fix that failure. Delaying the
sender transform's first key by two seconds passed in 28.63 seconds; the sender
encoded a later third keyframe. No production crypto change is justified by
that observation alone.

Before implementation: add an explicit private-fixture option delaying only its
human receiver's first SFrame decrypt-key delivery by two seconds. The normal
ACK path and required encryption remain untouched. Hold at most one 16-byte key,
cancel/wipe it on context/all-key clear, replacement key or that Worker's
termination; do not resurrect an invalidated key. Unknown option values fail
before resources. No automatic test activation outside the opted-in root bridge.

The existing moving-screen assertion and timeout remain unchanged. A fixed
read-only bridge command exposes only scheduled/delivered/cancelled counts and
delay milliseconds; success must prove that the injection actually happened.
No key, context ID, packet, media, SDP, ICE or user content in reports. Test the
helper deterministically and run the real private composition, then `npm run
check` in an isolated build worktree. Public trust, serving assets and services
remain untouched. A failure is diagnostic evidence, not authorization to weaken
SFrame or add unbounded retries.
