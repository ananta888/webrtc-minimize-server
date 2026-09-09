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
