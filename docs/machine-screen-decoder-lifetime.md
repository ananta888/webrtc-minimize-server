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

## Implemented regression (2026-09-08)

The pre-fix regression failed exactly at premature reopen (one failed, eight
passed). Actual decoder occupancy now survives source close and the one-second
observation timeout; only native resolution/rejection or synchronous failure
releases it. Stop wipes the owned input byte array immediately. Late completion
cannot draw into or clear another generation's frame. No native cancellation or
complete browser/GPU memory-erasure guarantee is claimed.

Twelve source tests plus thirteen existing avatar-source tests passed in 790 ms;
Angular application typechecking passed. A fresh private production build passed
the serial Chromium/Firefox matrix (four cases, 25.89 s): each engine rejects
eight reopen attempts while one actual browser bitmap is held, closes that late
bitmap exactly once and decodes a fresh green screen. The existing simultaneous
avatar/speech/screen matrix also passed three real lease renewals per engine,
with three stable transceiver slots and zero capture or transform errors.

These are synthetic private transport/resource tests, not production evidence.
The joint Hub/Worker delayed-decoder gate and isolated full repository check
remain pending at this implementation checkpoint. MDS-05/08 remain open for
their broader acceptance criteria.
