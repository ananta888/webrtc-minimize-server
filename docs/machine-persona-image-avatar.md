# Independent persona image source

The additive `persona-image-v1` variant uses the existing isolated avatar port:

```js
await window.anantaMachine.avatar.open(sourceId, "persona-image-v1", {png, sha256});
```

The existing explicit `neutral-ai-v1` invocation is unchanged and rejects an
image argument. Image mode requires an image and never substitutes the neutral
symbol on failure. Both require current `avatar.publish`, exact session/lease/
membership, protected camera ownership and generation-bound controller pulses.
There is no new Signaling content route, capture call, model or asset policy.

The image input is closed: canonical base64, at most 5 MiB, exact lowercase
SHA-256, normalized non-interlaced 8-bit RGBA PNG, dimensions 1..1024. Only
IHDR/IDAT/IEND are allowed, with no animation, metadata, URLs or trailing bytes.
Chunk bounds and dimensions are checked before hash/decode; actual decoded
dimensions must match. The browser decoder additionally checks the PNG content.
Images are fitted into a 160×128 box; the fixed ANANTA header, large KI mark and
low-rate liveness indicator cannot be overwritten by caller pixels. This is a
static approved image presentation, not a human camera or lip-sync renderer.

One hash/decode operation has a one-second budget. A stalled unabortable browser
decoder retains its sole permit until it actually settles, even after source
timeout/cancel; repeated opens cannot accumulate decoders. Late bitmaps are
closed and never attach. The source generation and current authority are checked
again before attachment. Canvas, bitmap and camera ownership are released on
failure/stop. The existing 30-second activation, 2500-ms controller heartbeat,
100-ms watchdog and concrete SFrame readiness remain unchanged.

Lifecycle, image validation/loading, artwork layout and publication resources
are separate small ports (SRP/DIP). No asset reference is a Meet grant. Ananta
must separately authorize and revalidate its immutable image/profile projection;
that Hub callback/CAS integration is not implemented by this browser port.

## Verification

28 source/image/surface tests passed (918 ms), including one added artwork
cleanup/label-order test after the full frontend batch. Real Chromium and
Firefox receiver cases passed in 6680.82 ms: red image decoded, camera explicitly
removed, blue replacement decoded beside non-silent PCM and green screen,
stale-generation close rejected, old red image did not return, moving indicator
and KI glyphs observed, wrong digest rejected with no camera, capture and
transform error counters zero. The fixtures generate minimal deterministic PNG
bytes; unit-only fake decoders are explicitly distinguished from these real
browser decodes.

`npm run check` passed: 568 frontend tests, 501 Node checks (499 passed, zero
failed, two skipped), Node duration 66368.84 ms. Build, typecheck, Go and
configuration/TODO/security gates passed. Existing soft initial-bundle warning
at 1.58 MiB remains; the hard budget is unchanged and the machine route remains
lazy. Optional external infrastructure and image-canary gates remain explicit
skips. No productive deployment or production release evidence is claimed.
