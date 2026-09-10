# Native source output failure boundaries

TBP-030/014, 10 September 2026. No causal runtime fix is claimed.

The existing two-source scene test failed in CI `34452209348` on `3598664`:
the viewer continued decoding but never displayed both selected source tiles.
A scene-application receipt is not proof of decoded source delivery.

A new failure-only test probe reads the private fixture's already existing HLS
producer and committed fragments through bounded regular-file readers. A local
FFmpeg process accepts only a pipe input, decodes one frame and returns two RGB
samples. Only fixed `red`, `blue`, `slate` or `other` classifications escape the
probe; no pixels, decoder stderr, keys or identifiers are returned. Missing,
oversized or invalid inputs return null. Each decoder has a five-second limit.
This is test instrumentation, not a native control endpoint or production API.

Six focused tests pass, including actual encoded red/blue H264 tiles. The first
probe implementation scaled subsampled YUV before RGB conversion and mislabeled
the red tile; the synthetic test caught it. Conversion to RGB **before** scaling
fixes this probe, without changing classification thresholds or application code.

The real two-source test then reproduces the failure in 32.360 seconds:
both producer and committed output contain `[red, slate]`. The current single
pixel viewer observation happens to sample the dark divider. The important
evidence is the two-tile native output: the screen is already absent before the
audience path. This narrows the investigation to source input/composition but
does not establish why the screen is missing.

Two further runs in a **separate, privately instrumented** checkout pass
(26.453/27.272 s). That experimental binary prints only existing transport/clock
failure enums and synchronized source/decoder state; it is not the unchanged
release binary and its code is not being committed. In these successful runs,
camera and screen clock/decoder/mixer state is live; ordinary revoke closes them
without a failure code. A failure under that observer has not yet been captured.

Two further private instrumented checks also pass: combined two-source/music
output (20.698 s) and a publisher-stats run. The publisher was visible and sent
both live video tracks; this successful observation does not establish a cause
for an earlier failure. None of the private native diagnostics enter the release.

The subsequent CI `34454680494` on `1b3c1e4` ends red: 1,208 Node/browser passes,
three failures and four skips (634.980 s). Failures are the initial Compose config
fixture, Chromium identical-persona replacement, and the single-source scene's
selected output; the two-source scene passes this time. These are independent
observations, not proof of one shared cause. A separately reproduced active
video-clock lifecycle mismatch is addressed in
[native-video-clock-recovery.md](native-video-clock-recovery.md).

Separately, the grouped handoff check fails one pre-existing music AAC output
assertion. Its unchanged targeted media path, with a failure-only print of the
already computed bounded observation, passes in 20.054 s. The 15-second output
deadline, format checks and non-silence thresholds are unchanged. This does not
explain the earlier failure or turn the grouped result green.

The grouped handoff snapshot predates these test-only diagnostic additions.
No production code, permissions, codec policy, retry behavior or browser timeout
was changed by this diagnostic slice. Production rollout and the wider source
reliability acceptance remain open.
