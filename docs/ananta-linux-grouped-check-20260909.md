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

At this first checkpoint the private two-hour Ananta reference used root
`63f602b8f` and this fixed Meet snapshot with the rebuilt cadence Worker.
It subsequently failed after 88 minutes at the unchanged 750-ms screen
freshness fence; the passing grouped check did not establish a soak pass.
The RTX 3080 on this Linux host became unavailable after a kernel-reported
bus loss at 14:37; new GPU verification requires restored hardware. Existing
GPU proofs remain historical and revision-scoped. Public admission remains
disabled on the observed older deployment; no rollout or task closure follows
automatically from this checkpoint.

## Updated checkpoint: c4ef486

After integrating the incoming scene-director, bounded join/renewal and separate
source-clock changes, another isolated clean `npm run check` completed with
exit 0 at `c4ef486`. The new closed Docker pool/cleanup diagnostics are included.

- 1,188 frontend tests across 143 files passed in 12.18 seconds.
- Private production build passed in 8.084 seconds; serving assets unchanged.
- Go origin/native unit/vet and the static/type/security/Todo gates passed.
- Node/browser: 1,092 cases, 1,088 passed, zero failed/cancelled, four explicit
  skips, 391.134 seconds (6 min 31 s). All 14 external scripts reached their
  explicit skip paths. Image-archive scan remained unavailable.
- Actual Chromium/Firefox dialog, native source/paired sender-report and
  compositor checks passed. Paired maximum A/V deltas were 46.3 / 30.5 ms.

Ananta independently reproduced the late-completion scheduling defect under
the fixed actual-browser `paired-idle-450-v1` fault: old pump failed in 33.361
seconds; corrected pump passed the whole five-minute reference in 315.847
seconds (`afc5eeb7c` / Meet `ebd78be`, Hub TEST run
`RUN_f168a00e2c54f42d27cfc6b14f1a0faf`). All 20 deliberate waits completed,
with 295 active seconds, four leases, six screen checks and automatic removal
of the exact four-container fixture network. This is a scoped synthetic fault
comparison, not a current GPU, public or normal two-hour pass.

The installed two-Worker reference and broader Ananta regression follow this
updated Meet checkpoint. MDS-08 remains open; no public trust/deployment change,
new account access, GPU recovery or historical-failure erasure is implied.
