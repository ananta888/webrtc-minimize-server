# Private packaged audio reception gate

The Ananta gate now sends a locally synthesized, bounded WAV through an actual
test-owned microphone or screen-audio publication, required SFrame and the
packaged receiving Worker's local CUDA ASR. The Node bridge accepts only fixed
source/grant/speak/revoke/stop commands; no request can supply media, grants,
Tasks, provider URLs or keys. Test-runner environment selects the local synthetic
WAV and ephemeral Hub public key. Files are regular, non-symlink, RIFF/WAVE and
at most400,000 bytes; browser decoding further limits channels and duration.

Only the synthetic owner page's capture functions are replaced. A visible UI
action starts the synthetic stream; screen audio additionally uses the actual
settings checkbox. The receiving machine never captures a human device. The
utterance begins once after the real Hub child admission, with a fixed one-second
lead-in; this avoids testing a random cut through a looping phrase. UI regrant
waits for the real revoke receipt and editor reset. Source factory, UI selection
and stdio lifecycle remain separate responsibilities.

On2026-09-09 the first complete microphone/screen-audio pair passed109.35s in
Ananta, exactly128,000 samples each, at least three of four fixed spoken words,
no reply publication or transcript persistence. This is synthetic, single-host
technical observation, not public infrastructure or production evidence. The
test found missing Ananta child Worker assignment; Ananta corrected that Hub
binding and is testing repeated grants/active cancellation with a new image.

Both receive bridges require their explicit packaged gate environment variable.
Without opt-in ordinary Node test discovery imports them without running
infrastructure. Four discovery/invalid-profile checks passed2.73s. This fixes
the newly added visual bridge's unintended execution in the isolated full check;
it does not skip an activated gate or weaken failure handling.

## Renewed and revoked live reception

Ananta `c72f8162f` / immutable Worker image `55ec55247f2e` passed the final
microphone/screen-audio pair in159.93s. Both performed real local CUDA recognition,
then a separately regranted active receive Task was revoked without another
accepted transcript. The microphone additionally received a new-generation Hub
assignment after actual Meet lease renewal; Hub audio pause terminated that child
while the parent dialog remained active. The fixture now emits at most three
single utterances, one per explicit grant, after the original Hub reservation
budget; silence after an ended utterance is not assumed to make a current remote
source available. One interim run failed before admission during private human
page navigation; bridges now forward the existing closed startup observation,
never URLs, tokens or arbitrary exception text.

Ten malformed-file/source and explicit bridge opt-in checks passed2.53s. The
isolated committed `d57096d` full check passed844 frontend/863 Node tests with0
failures,2 explicit Node skips and unchanged external infrastructure skips.
The four bounded MDS-03 receive-port criteria are met together with the earlier
real decoded PCM/early-segment/revoke and deterministic buffer/authority tests.
This closes that port, not the wider dialog track or production deployment.
