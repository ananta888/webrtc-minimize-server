# Two-machine publisher isolation (MDS-08 / Ananta MAP-28)

Source baseline `c3e378a`: existing machine browser tests cover one admitted
machine and one receiver. The production admission/session/source contracts
are separately bound, but simultaneous publishers have not been verified.

Add a bounded private fixture extension for exactly one additional machine,
with a separate browser context and independent synthetic subject, task,
runtime and session. Reuse the same ephemeral trusted issuer and required
SFrame policy. The fixture owns all cleanup; no production server, serving
build, operator key or user profile changes.

Verify two distinct persona images and screen colors at one Chromium/Firefox
receiver while both real audio tracks carry samples. Reject cross-session
source opening. Removing one machine must leave the other machine's correctly
attributed media working. Tests are entirely headless and bounded; synthetic
audio is generated locally, never captured from devices. Keep identifiers and
contents inside private assertions; reports contain only closed numeric/state
observations. Use a dedicated multi-publisher observer/scenario (SRP), not
another mode in the single-dialog bridge.

This browser-only gate is a single-host technical observation. Ananta's
separate Hub/two-Worker-container/role-assignment gate is still required; no
production release, GPU concurrency, public TURN or completed MAP-28 claim
follows from the browser gate alone. Run targeted Chromium/Firefox checks and
the isolated complete check, preserving and fixing any reproducible failures.

## First implementation check

The new Chromium/Firefox three-context matrix passed both cases in 7.568 s.
The receiver decoded red and blue persona images with separately attributed
red/green screens and one active speech track per publisher. Server-assigned
peer IDs, authenticated principals and device fingerprints were distinct;
foreign screen source IDs were rejected. After one machine left, its media
disappeared and the survivor published blue/green media with active audio
under freshly opened source generations. Zero capture calls and transform
errors were observed. This tests recovery after the membership fence, not
uninterrupted playback across a room epoch change. The first test attempt
incorrectly read a nonexistent `status().peerId`; the fixture now resolves
the actual newly admitted member from its own server registry without adding
an application API. No production code or test deadline was changed.

The full isolated check and Ananta multi-container gate remain pending.
