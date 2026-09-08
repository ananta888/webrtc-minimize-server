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
