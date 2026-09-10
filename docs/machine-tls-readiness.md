# Bounded private Ananta TLS readiness

## Current isolated startup finding

The Ananta job of CI `34489193294` at `cae41da` failed before launching its
Chromium UDP browser: connect/refused after 99 attempts; the owned container
was running without OOM and had not announced its listener. Firefox UDP and
both TCP cases passed. The complete CI has since finished failed: one project
shard passed; the other failed both native scene-output checks.

A local **proxy-only** invocation of the unchanged fixture completed TLS
readiness and cleanup in 4.281 seconds. Its explicit launcher interception
stopped execution before any browser was started. This used ephemeral private
TURN/policy infrastructure, not a human source or production authority.
Local audio/browser tests remain paused while the reported Windows-Firefox
audio issue is investigated. The healthy local startup is neither a
reproduction nor a fix for the GitHub failure; no deadline was extended.

The private proxy now emits a fixed marker immediately on entering its
JavaScript and another after loading `node:net`, before creating the listener.
Failure-only inspection projects these as `processEntered` and
`networkModuleLoaded` (boolean, or null when logs cannot be read), alongside
the existing historical listener marker. This distinguishes missing evidence
of JavaScript entry from a later startup stall; it does not by itself explain
either condition. The two bounded read-only Docker operations, 16-line/4-KiB
limits, TLS deadline and container budgets remain unchanged. No warmup,
extra readiness retry or restart is introduced.

The actual generated proxy program is exercised in a controlled VM with
mocked network/timer ports to verify marker order, port, connection ceiling
and lifetime. Exact-line and unknown/oversized-log cases plus existing
readiness/proxy/TURN-workflow checks pass: 31 tests in 1.080 seconds, no skips.
No local browser or audio service is started by these checks. The marker
addition is not a startup fix.

CI `34490651291` on `5671aea` has now finished **failed**. Both UDP cases
failed before browser launch with connect/refused: their container state was
running, but none of the three log markers was observed. Chromium TCP also
failed before browser launch; both JavaScript-entry and network-module markers
were observed, but not the listening marker. Firefox TCP passed, including
16,000 decrypted PCM samples, chat, screen, three renewals and real TCP relay
pairs. Marker absence does not prove the process never executed, and historical
marker presence does not prove it stayed healthy. No warmup, deadline increase
or causal repair is inferred from these observations.

This is test infrastructure, not a production TLS or Hub-policy change.
CI `34413091470` at `6fdf26e` failed its Chromium TURN-UDP case before
browser launch with `test_tls_proxy_not_ready`. Firefox UDP passed;
TCP was not run. That report does not identify the underlying cause.
The run later finished **failed** overall: its main suite also failed the
single-source native scene's decoded-output assertion after a confirmed scene
selection. The two-source case passed. Live Keycloak/TURN and Docker jobs were
skipped downstream. This separate scene failure is not repaired or explained
by the private TLS readiness change.

The previous fixture used a socket inactivity timeout of 300 ms and checked
its five-second deadline only after a failed request. It could accept HTTP
200 after that deadline. Executing the unchanged probe from `6fdf26e` with
a synthetic response at 5,001 ms reproduced that late success. A socket
inactivity timeout also does not independently bound a complete request.
Neither observation proves why the earlier CI proxy was not ready.

The extracted `test/helpers/machine-tls-readiness.mjs` now enforces:

- A monotonic five-second overall budget, at most 300 ms per complete
  attempt and at most 100 read-only attempts, separated by 50 ms.
- A deadline check before accepting HTTP 200, including delayed timer
  delivery. Late callbacks cannot complete a newer attempt.
- The fixture's exact CA with certificate verification enabled. No shared
  keepalive agent, redirects, authorization requests or TLS exceptions.
- Request/response destruction and timer/socket-listener cleanup, including
  hanging requests. No retained response body or pooled proxy connection.
- Fixed diagnostics only: connect/TLS/HTTP phase, bounded attempt count and
  ready/timeout/refused/reset/certificate/http-status/transport reason.
  Certificate errors fail immediately. Error text, URLs and keys are absent.

The existing `test_tls_proxy_not_ready` error remains compatible with the
private Hub bridge. Fixture test reports can additionally include the closed
diagnostic object. Media, capture, source-consent and lease limits are unchanged.

## Verification

Ten deterministic readiness tests and eleven existing proxy tests pass:
21 total, no skips, 0.188 s. They cover hangs without socket timeout/error
events, late HTTP 200, old callbacks, certificate rejection, redirects,
transport-error redaction, HTTP stalls and resource cleanup.

The actual Chromium/Firefox consented dialog passes through authenticated
TURN-UDP in 36.946 s and TURN-TCP in 43.790 s. Each case checks 16,000
decrypted PCM samples, correlated chat, decoded screen pixels, three lease
renewals, active-receive revocation and selected relay pairs with increasing
bytes at both ends. Synthetic identities and sources only; no human capture
on the machine client and no transform errors. The unchanged frontend is
the isolated `6fdf26e`-equivalent build at
`/tmp/webrtc-native-audio-check.yNSTOP/dist/browser`.

The single grouped `npm run check` completed with **exit 0** in the separate
worktree `/tmp/webrtc-ananta-tls-check.mPmJE0` (log: `check.log`). It covers
`6fdf26e` plus the new readiness helper, its ten tests and the fixture wiring:
1,221 frontend tests and 1,189 Node/browser passes, zero failures, four explicit
Node skips; Node duration 602.138 s. Build (17.102 s), typecheck, Go unit/vet
and static gates passed. Fourteen external infrastructure gates and the
optional image canary scan were explicitly skipped. Both native scene cases
passed locally; this does not retroactively repair the failed CI run.

All three changed test/source files compare byte-for-byte with that frozen
snapshot. Only subsequent documentation and Todo evidence differ. The final
Todo gate validates all 28 documents. Production serving files (index SHA256
`2a9259b48e7e9676d8d48346247c4bd0e2bf37c1855b2fa9b8428618aa2ea783`),
active rooms, Hub trust and the Ananta repository are unchanged. The public
integration endpoint still reports `admissionEnabled: false`; public Hub/project
authorization and the separate long-run acceptance remain outstanding.
No new commit, push or deployment is part of this verification round.

## Subsequent container failure evidence (10 September)

CI `34459452182` at `3226250` finished failed solely in its Chromium TURN-UDP
setup: connect/refused after 99 attempts. Firefox UDP and all other jobs passed.
This is distinct from the prior missing permission-editor failure. The subsequent
`cb2e6e7` CI completed successfully in all eight jobs; no cancellation or restart.
That CI predates this test-only diagnostic addition.

On TLS-readiness failure only, the private fixture now inspects its own started,
not-yet-cleaned proxy container. A separate adapter runs exactly two read-only
commands, each bounded to one second, 4 KiB and SIGKILL on timeout. It projects
only status, running/OOM booleans and a bounded exit code. A fixed listener log
marker indicates a **past announcement**, not proof that the process is still
listening. Unknown, failed or oversized reads remain null. Raw Docker errors,
logs, commands, addresses, container IDs and keys are never returned. The normal
five-second TLS deadline, exact CA and media/consent limits are unchanged.

Thirty focused readiness/proxy/STUN/inspection tests pass (1.076 s). They include
an actual stuck subprocess killed by the one-second bound, partial-output
redaction and no inspection before Start or after cleanup. A deliberately exited
owned proxy (`process.exit(23)`, injected only into that test container's command)
produces the expected closed snapshot: exited, not running, no OOM, exit 23,
no listener announcement. The original readiness failure is preserved. This
host reports connect/timeout for the removed listener, rather than the CI's
connect/refused; the first manual assertion incorrectly assumed those transport
outcomes must match. That assertion was corrected, not the TLS gate or its
deadline. Both owned fixtures were cleaned up.

The actual Chromium consented TURN-UDP dialog also passes (18.430 s), including
16,000 decoded samples, chat, screen, three renewals and real UDP relay pairs.
Neither this pass nor the synthetic process fault establishes the historical
CI root cause. Initial read-only Mini-PC inspection found a clean `5602ccf`
checkout and three running `5a10338` images. The subsequent verified `cb2e6e7`
software rollout excludes this diagnostic addition; see the separate
[deployment evidence](ananta-public-rollout-20260910.md).

## Frozen grouped check of the diagnostic addition

The isolated `/tmp/webrtc-ananta-proxy-check.PZHx9r` `npm run check` completed
with **exit 1**. Its five changed TLS source/test files are byte-identical to
the corresponding working-copy files. Frontend: 1,279 tests pass; build
(15.173 s), typecheck, Go unit/vet and static gates pass. Node: 1,222 passes,
two failures, one timeout cancellation and four explicit skips (621.303 s).
The external infrastructure stage was not reached; the optional image scan
was explicitly skipped. The three unsuccessful cases are:

- Pair Dev's three-browser test: 30-second timeout, phase/cause not established.
- Firefox consented dialog: the first renewal's dynamic module fetch failed
  after successful PCM/chat/screen delivery; cause not established.
- Private reconnect quiet observation: minimum-sample assertion failed after
  205.612 ms. A subsequently added independent regression demonstrates a
  wall-clock weakness; the [monotonic-window fix](machine-reconnect-quiet-window.md)
  and its targeted tests are **not** in this frozen check.

The failed grouped check remains failed, independently of the earlier green
release CI, deployment and subsequent focused verification. Hub authorization,
joint long-run acceptance and historical media-freeze causality remain open.

One unchanged focused follow-up against the same frozen source/build passes
both other unsuccessful browser cases: Pair Dev in 2.854 s and Firefox's
consented dialog in 15.479 s (19.918 s combined, no skips). Firefox delivers
16,000 PCM samples with active SFrame and no transform errors. No source
change or timeout increase was applied to those cases. This does not establish
the cause of the earlier timeout/module-fetch failure or turn the grouped
result into a pass.
