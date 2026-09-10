# Independent native AAC output selection

TBP-014/020 implementation in progress. The working tree now connects Angular,
HTTP policy, runtime/assignment ownership and the actual native encoder.
Native 0.12.0 advertises capability v5 / audio-control v3 / encoding-selection v1
only with source-program opt-in. Existing releases are unchanged. No deployment
or operator-trust change is implied; grouped verification has one unresolved
browser-startup failure and is not a release pass.

## Native contract and encoder

Additive assignment v5 requires an exact `audioOutput` object:
`codec: "aac"`, `sampleRate: 48000`, `channels: 1 | 2` and an integer
`targetBitsPerSecond` between 16,000 and 320,000 (mono ceiling 192,000).
Every rendition must have that same audio target rate, independently of its
video resolution/FPS/rate. JSON Schema checks the closed shape and bounds;
the native semantic validator additionally checks equality with all rendition
audio rates. V4 rejects the new field, including explicit null, and keeps its
stereo default. Duplicate/escaped-duplicate keys and unknown fields remain
closed. Parsing alone grants no source or writer authority.

The authenticated, locally opted-in source assignment dispatcher, owned
generation, local admission and bounded output builder carry channel choice
to every FFmpeg AAC output. Raw PCM input remains 48-kHz stereo; selecting
mono does not change capture, mixer input framing or source permissions.
The shared legacy compressed-input builder keeps stereo unchanged.

Format is pinned to the assignment. A repeated prepare cannot change channels
or rate; renewal and internal HLS rollover preserve it. A different format
requires a new output generation, not an in-place change under the old HLS init.

Additive native audio-control v3 reports actual configured channels and rendition
targets alongside the existing mix observation. Mono programs reject v2 queries
and applications before mutation, since v2 explicitly means stereo. V1 gain-only
control remains compatible and does not acquire encoding fields. V3 uses the
same CAS, bounded receipt history, lease/owner fences and revocation semantics.
The Node normalizer, raw wire parser, broker and director negotiate v3 explicitly.
The authenticated HTTP integration test covers both v4/legacy and v5/selected
output, including scope denial, capability downgrade during a query and a late
reply that cannot restore authority. The new test exposed two integration gaps:
policy denials incorrectly became HTTP 500, and the structural wire parser
omitted the v3 strategy when checking applied/rejected replies. Both are fixed;
no generic exception text or wider authority is introduced.

## Angular and handoff

The source-program start form offers the unchanged profile default plus speech
(48-kbit/s mono), balanced (96-kbit/s stereo), music (192-kbit/s stereo) and a
bounded custom choice. Output format is selected before explicit start; it is
disabled for an active program. Changing mixing/priority live does not change
AAC format. The output is copied before asynchronous work, and changes of room,
capability, confirmation, cancellation or controller generation cannot activate
an old choice. No capture or automatic source consent is added.

Only explicit start v2 emits assignment v5. Runtime-owned immutable output is
reused by standby admission and both handoff phases; client handoff data cannot
change it. Unsupported targets are rejected before stopping the old writer and
rechecked after drain. Legacy starts still use assignment v4 and existing rates.
The audio panel negotiates v3 for new agents, shows actual encoder metadata and
retains v1/v2 validation for older agents. Mono v3 never passes a stereo-only v2
reply parser.

The optional request/encoding validator and HTTP adapter are lazy-loaded rather
than raising the initial bundle limit. The first two private builds exceeded
1.60 MB by 388/507 bytes; splitting capability projection from optional parsing
passed the same cap in 11.878 s. The subsequent request-module/cancellation
refinement passed the grouped build in 9.936 s at 1.59946 MB; the serving `dist`
is unchanged. The 1.60-MB hard cap is unchanged.

## Verified component evidence

- 95 focused frontend checks (including four lazy-start cancellation regressions)
  and 47 Node policy/contract/assignment/handoff/wire checks passed.
  Both actual HTTP v4/v5 integration cases passed (0.976 s).
- Updated native source/audio/encoder/assignment/control race checks pass
  (18.607 s). Version advertisement now matches the connected implementation.
- Two actual rendered Angular/native-process gates pass in 35.495 s: speech
  selects mono at 48 kbit/s, music stereo at 192 kbit/s. Actual committed HLS
  fragments contain AAC/48-kHz/correct-channel streams and decoded non-silent
  synthetic tone. No capture before source consent; exactly one clicked
  synthetic microphone remains running when only the broadcast stops.
  The fragment probe rate is an observation of that short fragment including
  preceding silence, not a CBR or steady-state quality measurement. The separate
  native matrix below checks sustained synthetic tone at both rate extremes.
- 13 focused JSON-Schema tests pass, including shared v5 assignment/v3 audio
  fixtures, closed legacy versions, invalid/null/extra fields and channel/rate
  bounds. Initial strict-Ajv missing numeric type was corrected, not disabled.
- Focused native source/audio/encoder/assignment/control tests pass under the
  race detector (19.479 s). Full native Go unit and vet checks pass (27.466 s).
- Real FFmpeg/ffprobe gate passes in 30.808 s: mono at 16/48/192 kbit/s,
  stereo at 96/192/320 kbit/s; two independently encoded video renditions
  each carry the chosen AAC format. It decodes moving video and a known tone,
  verifies actual AAC/48-kHz/channel metadata, and checks revoke/reaping.
  The 48-kbit/s mono case also preserves identical init bytes at HLS epoch 127.

Bitrate is a **target**, not constant measured traffic. For the synthetic tone,
measured mono rates were 18,328 / 47,834 / 146,846 bit/s; stereo rates were
96,170 / 191,408 / 233,029 bit/s. High-target AAC can legitimately use less
data for simple input. These are format/transport checks, not speech/music
quality, physical echo or lip-sync acceptance.

## Grouped verification and remaining requirements

The isolated `npm run check` at `/tmp/webrtc-audio-output-check.zhenGO` finished
with exit 1: 1,243 frontend tests, build, types, Go unit/vet and static gates pass;
Node/browser tests report 1,209 passed, one failed and four skipped in 615.983 s.
The sole failure is the existing v4 keyboard UI test waiting 30 seconds for the
join form (`#display-name`), before starting a broadcast. Its unchanged focused
retry passes in 4.811 s; this does not establish the cause or turn the grouped
result green. A passive, bounded startup diagnostic is added without retries,
URLs, contents, tokens or changed timeouts. The final focused UI test and both
diagnostic redaction tests pass together in 4.966 s; no runtime change was made
for the startup failure. New real mono/stereo AAC cases, legacy
gain/mute/strategy/scene cases and Ananta dialog cases pass in the grouped
run. External infrastructure stages were not reached; image scanning explicitly
skipped. A first grouped attempt stopped earlier on a stale shared v4 capability
fixture reference; correcting it to the existing v5 fixture preserved old v4
contract coverage.

The handoff tests currently prove control-plane preservation with synthetic
agent receipts; the two new rendered cases prove real single-agent outputs.
A real multi-agent HLS format handoff is not yet proven by combining those
separate tests. Physical echo, Bluetooth, quality and long-run acceptance remain
separate TBP-014/020 requirements.

This slice is a verification candidate, not a production-ready release.
The preceding independent Ananta TLS test correction is committed
and pushed as `d8a3846`. Its CI `34414932491` passed the TURN dialog, native
packager, Blind agent and both macOS jobs, but failed four main-suite cases
(Chromium avatar stop/companion output, same-persona replacement, single-source
native scene, and an audio-strategy query returning 409). Live Keycloak/TURN
and Docker jobs were skipped downstream. These failures predate the new audio
selection work; their causes remain open and must not be relabeled as fixed.
