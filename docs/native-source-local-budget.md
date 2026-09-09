# Local source-program capacity

`NATIVE_PACKAGER_SOURCE_BUDGET` selects a fixed, local native-packager budget.
The default is `compact-v1`; unknown values fail startup. Compose forwards the
selection explicitly. This is not a source grant, v4 activation switch, or
claim that the host can sustain the maximum load. The separate
[native v4 control opt-in](native-source-control.md) is disabled by default;
agent version, public emitter and capability promotion remain unchanged pending
recovery and ingress acceptance. Legacy single-publisher assignments keep their
existing behavior.

| Profile | Decoder processes | Decoder buffers | PCM mixer | RGBA compositor | Raw output ceiling | HLS stage | Decoder output ceiling |
|---|---:|---:|---:|---:|---:|---:|---|
| compact-v1 | 8 | 128 MiB | 2 MiB | 32 MiB | 64 MiB | 32 MiB | 640 × 360 |
| standard-v1 | 24 | 384 MiB | 8 MiB | 128 MiB | 96 MiB | 64 MiB | 960 × 540 |
| expanded-v1 | 80 | 1536 MiB | 14 MiB | 256 MiB | 128 MiB | 128 MiB | 1280 × 720 |

All ceilings apply together, not alternatively. For example, 80 source slots
do not promise 80 simultaneously decoded videos. The room still has at most
20 publishers and four publication kinds each. A decoder reservation stays
charged until both startup-buffer erasure and process reaping complete.
The compositor and audio mixer independently reject additions exceeding their
own pools. The encoder itself is additional to the decoder process count.

These values bound the corresponding owned media buffers/output stage, **not**
total process RSS, codec-internal allocation, kernel pipes, transport assembly,
resampler storage, CPU/GPU demand or network upload. Existing owners retain
their separate bounds. Deployment-level memory/CPU isolation remains necessary;
no hardware-dependent throughput or QoS guarantee follows from profile selection.

## Admission and ownership

The local adapter validates the closed v4 assignment before arithmetic. Canvas
width, height and FPS are the respective maxima of the requested renditions.
Both the summed rendition pixel rate and the resulting canvas pixel rate must
fit `NATIVE_PACKAGER_MAX_PIXELS_PER_SECOND`; their maxima can differ. The
rendition count must fit `NATIVE_PACKAGER_MAX_RENDITIONS`.

Raw pools are allocated to exactly `min(16, queueFrames) × 3840` PCM bytes plus
`min(8, queueFrames) × canvasWidth × canvasHeight × 4` RGBA bytes, checked against
the selected ceiling. The runtime requires at least two queue frames even
though the broader wire contract permits one. Such an assignment is rejected,
not silently rewritten. Rendition dimensions, rates, codec and bitrates are
never downgraded to make admission pass.

Decoder outputs use the smaller of the program canvas and the selected local
width/height ceilings, with the existing contain/pad filter preserving source
aspect ratio. Thus compact mode can upscale source pixels into a larger output;
select a larger local budget when source detail matters. This does not change
the publisher's capture configuration or authorize another Simulcast layer.
The existing shared clock retains its 14,400-sample / 300-ms alignment delay.

The adapter forwards only local capacity to the existing fenced owner. That
owner still validates authenticated control, actual device, consented room,
tenant/epochs, codecs, expiry and exact retry identity, and supplies paths and
lifecycle callbacks itself. Assignment JSON cannot provide allocation budgets,
executable paths or directories. Changing the configured local budget is not
a live resize: a retry with different effective budgets is rejected.

## Verification scope

Focused tests cover profile parsing, all three profiles reaching the real owner,
immutable wire profiles, retry identity/deadlines, scope/capability rejection
before construction, independent canvas/sum ceilings, raw pool accounting and
dual-owner quota release. The existing real VP8/Opus-to-HLS assignment gate now
uses this adapter rather than an injected test allocation budget, including
renewals, prepare retries and revoke/reaping.

Those codec inputs are synthetic and already decrypted. They are not evidence
for public v4 dispatch, multi-publisher RTP/SFrame ingress, generation recovery,
discontinuity or public Approve/Renew; those remain required next steps.

On 8 September 2026 the focused native race matrix passed three times
(16.929 s) together with Vet. The separate actual-codec gate passed in 7.66 s:
low rendition four red/six blue frames, medium eight red/twelve blue frames,
decoded 700-Hz audio, three writer renewals/prepare retries, terminal revoke and
reaping. No synthetic test budget is injected into that owned program path.

The isolated `npm run check` at `76e8866` plus this adapter completed with exit
0: 757 frontend tests, 794 Node passes, zero failures and two explicit Node
skips (423.830 s for Node). The owned HLS gate passed again in 7.579 s.
Build, Go unit/Vet and static gates passed; 14 external infrastructure gates
and the optional image scan were visibly skipped. All changed runtime/test
and Compose/example files byte-match the checked snapshot. The laptop's
serving build was not replaced. The separately verified production rollout
`76e8866` includes the earlier retry work, not this new budget adapter.
