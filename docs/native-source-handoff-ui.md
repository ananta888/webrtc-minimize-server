# Explicit source-program packager handoff

TBP-030/035, implementation in progress, 10 September 2026.

The multiple-participant source-program panel now offers an explicit successor
selection and confirmation. Only currently eligible, owner/room-consented native
packagers with sufficient rendition and selected audio-output capability appear.
The currently confirmed writer is named separately from a staged successor.
This is a disruptive manual handoff, not automatic failover or seamless playback.

The source controller obtains a fresh matching control snapshot before the CAS
request. The server's existing coordinator invalidates the old output, requests
the old native writer's stop, and requires its actual stop ACK before admitting
the successor. The source response must have exactly the next program epoch,
an increased fencing revision, the expected target and the source input mode.
Legacy responses stay separate; only a source **start**, not a source handoff,
retains the previous epoch. Optional HTTP and assignment validation are loaded
separately, without increasing the existing initial bundle budget.

The start's audio format, rendition count and hardware permission are retained.
The server remains authoritative for audio format and target admission. A new
writer initially emits a slate and silence; previous source grants/keys are not
reused. Participants must explicitly approve their current sources again.
No capture or source restart is triggered by opening the UI or by a handoff.

An observation generation prevents an earlier poll's late success or error from
replacing or stopping the new writer. Handoff and output confirmation have
separate bounded stages. Stop, Destroy, changed room/session, missing capability,
expired operation or failed confirmation revoke the controller. A lost response
is not proof of failure to start: cleanup always checks **all** assignments for
that program, even when the old assignment ID is known. An unconfirmed stop
remains visible and available for explicit retry; no automatic restart occurs.

## Evidence and limits

- 133 focused frontend checks cover the controller, source HTTP and component,
  service ownership and unchanged legacy controls. 27 server handoff/assignment
  tests and broadcast type checks pass. A final writer-label test was added
  after this group and is included in the grouped run.
- The isolated build passes in 12.733 seconds, initial size 1.59974 MB against
  the unchanged 1.60-MB hard limit. The root serving build is untouched.
- An actual Chromium/Angular workflow with two separately keyed native
  processes and the private authenticated TLS control server passes in 32.633 s.
  It cancels one handoff, confirms the next by keyboard, observes the old writer
  stopped, exactly one successor at the next epoch/higher fence and a different
  single output resource. Read-only FFmpeg/ffprobe checks decoded non-silent
  mono AAC before handoff, silence before fresh consent and non-silent mono AAC
  after explicit new consent. The UI confirms the preserved 48-kbit/s target.
  Both assignments finish stopped and output resources are removed; the room
  microphone remains running until its own explicit Stop. These short-fragment
  bitrates are not steady-state bandwidth or CBR measurements.
- The first attempt of that new test failed on clicking an already removed
  defer placeholder; only the test navigation was corrected. The existing v4
  keyboard workflow also passes (4.429 s).

The test uses separate processes on one host and a shared private origin root.
It does not establish remote-host federation, an audience player surviving an
epoch replacement, lip sync, physical acoustics or bounded disaster recovery.
Those remain separate acceptance requirements. The grouped isolated `npm run
check` finished with exit 1: 1,274 frontend tests, build (9.395 s), types,
Go unit/vet and static gates pass; Node/browser reports 1,210 passed, one failed,
four skipped in 602.356 s. The sole failure is the already existing music AAC
output test failing to observe decoded non-silent audio in its 15-second window.
Its cause is not established. The real two-packager handoff passes in 35.118 s,
including the final writer-label assertion. Both native scene cases and the
Ananta dialog cases pass in this run; the separate scene failures remain open.
External infrastructure stages were not reached and the image scan explicitly
skipped. The subsequent passive scene-output diagnostics were not in this fixed
snapshot. CI and safe deployment remain required; this is not a release pass.
No public trust, production service or Ananta repository was changed.

The preceding `3598664` CI (`34452209348`) is terminal **failure**: its main
suite failed the existing two-source scene output test while the viewer continued
decoding the slate after a scene-application receipt. Native packager, Blind
agent, both macOS and authenticated Ananta TURN jobs passed; downstream Docker
and live identity jobs were skipped. That failure is not the earlier join-form
timeout and is not explained or fixed by this handoff work.
