# Actual screen decoder occupancy (MDS-05/08)

Source audit before correction: the screen source's activation `busy` flag is
cleared by stop/reopen and timeout, but a native `createImageBitmap` promise is
not thereby cancelled. Current tests settle the old decoder before pushing a
new frame, so they do not detect overlapping native work across generations.

Keep actual decode occupancy separate. While it remains outstanding, reject a
new source activation with fixed `meet_screen_decoder_busy` before creating a
new surface/track. The original source still stops immediately and input bytes
are wiped; only actual native settlement releases occupancy. Dispose late
bitmaps without drawing. A never-settling decoder must not permit unlimited
reopen/decode attempts. No queue, new capture right or expanded time budget.

Reproduce first with deterministic pending promises, then cover close/reopen,
timeout/reopen, late resolution/rejection and synchronous decode failure. Real
Chromium/Firefox screen/companion-source/renewal behavior and isolated `npm run
check` remain required. This is native resource lifetime versus source generation
(SRP) through the existing small decode port (DIP), not a transport crypto fix.
Public services, trust and serving assets remain unchanged.
