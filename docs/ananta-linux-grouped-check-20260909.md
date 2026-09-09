# Linux grouped integration checkpoint, 2026-09-09

An isolated clean worktree at Meet `ebd78bed6013471ad0eec6d52adfbbbb56293b6c`
completed `npm run check` with exit 0. The serving `dist` and public container
were not rebuilt or replaced by this verification.

- 1,142 frontend tests across 140 files passed.
- The production build passed in 7.994 seconds with the existing bundle warning.
- Go origin/native unit and vet gates passed; native package 20.791 seconds.
  The separately executed native race matrix passed in 42.388 seconds.
- Node/browser suite: 1,070 cases, 1,066 passed, zero failed/cancelled, four
  explicit skips, duration 380.153 seconds (6 min 20 s).
- Todo/workflow/deployment/license/type/security checks passed. The optional
  container-image archive scan was explicitly unavailable.
- All 14 external infrastructure scripts reached their explicit opt-in skip
  paths; this check did not authenticate against public OIDC or enable trust.

The four Node skips were the two private TURN payload opt-ins, legacy v1 GPU
MP4 publication, and real Windows PowerShell installer parsing. The private
TURN function had already passed separately for UDP/TCP at the earlier
`91bc248` snapshot; that earlier result is not relabeled as a new run here.
Additional script-level opt-in diagnostics, including compositor soak, do not
become long-run evidence merely because their containing script exits cleanly.

Actual Human-Meet/Pair/Chromium/Firefox regressions passed. Both independent
speech cases completed 66,150 played samples: Chromium 4.298 seconds, Firefox
5.340 seconds, sustained decoded remote audio, zero capture and transform
errors. Actual browser-to-native 401-frame VP8/Opus and paired sender-report
checks also passed (paired maximum observed deltas 28.1 / 38.9 ms). These are
synthetic-policy, local transport observations, not a public production release.
The previously intermittent speech failure was not reproduced in this run;
this is not a claim that its cause on another machine was fixed.

The preceding combined check at `2d39a17` failed before the Go source key
announcement. The [same-process network fixture correction](native-source-loopback-observation.md)
and explicit repetition/race results are recorded separately. No observation
deadline, source freshness bound, lease or production ICE policy was enlarged.

The matching ongoing private two-hour Ananta reference uses root `63f602b8f`
and this fixed Meet snapshot with the rebuilt cadence Worker. That run has a
separate Hub reservation and is not complete just because this check passed.
The RTX 3080 on this Linux host became unavailable after a kernel-reported
bus loss at 14:37; new GPU verification requires restored hardware. Existing
GPU proofs remain historical and revision-scoped. Public admission remains
disabled on the observed older deployment; no rollout or task closure follows
automatically from this checkpoint.
