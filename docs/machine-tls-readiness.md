# Bounded private Ananta TLS readiness

## First native-adapter CI probe lost to the apt mirror (11 September)

`d14e9d8` and `e4963d1` were pushed 23 seconds apart, so the workflow's
`cancel-in-progress` grouping produced one run, [CI 34578116825](https://github.com/ananta888/webrtc-minimize-server/actions/runs/34578116825),
for the native adapter. All other jobs passed. The Ananta job was cancelled by
its own ten-minute limit inside "Provide a synthetic Firefox audio clock":
dependencies and browsers had installed in 44 seconds, but the Azure Ubuntu
mirror stalled twice for about five minutes each (`Ign:2 libfftw3-single3`
at 08:18:25, `Ign:3 liborc-0.4-0t64` at 08:23:24). The build, the native
image and both dialog tests were skipped. **The native-v1 proxy therefore has
no CI observation yet**; this sample says nothing about it.

The two apt-backed steps now carry their own step limits (four and two
minutes) and each `apt-get` call uses `Acquire::Retries=2` with 20-second
transfer timeouts, so a hung mirror fails the named step early and visibly
rather than silently consuming the readiness budget. The job limit, the
five-second TLS deadline, container limits and the dialog tests are
unchanged; this does not add a retry of the proxy or of any browser test.
The next completed run of the same job is the first actual native-adapter
probe.

## Explicit native test-proxy adapter (11 September)

`MEET_TEST_PROXY_ENGINE=native-v1` selects a small statically linked Go
byte-forwarder in `test/fixtures/machine-tls-proxy/`; the default remains the
existing Node fixture. Unknown profiles fail before Docker side effects. The
separate Ananta TURN job builds and selects this native image, then runs the
**unchanged** Chromium/Firefox UDP and TCP dialog tests. Go unit/vet checks
are included in the ordinary project gate. This is test infrastructure only.

The observed native executable is 2,150,584 bytes. Its image pins both existing
Node/Alpine runtime-base and Go-builder digests; compilation has no network,
CGO or third-party modules. `GOMAXPROCS=1` prevents inheriting the host's full
CPU parallelism. The image retains existing shell/proc tools for the same
failure-only reader, but Node is not started as the forwarding process.
This removes that runtime's startup from this fixture; it does not prove the
cause of its historical I/O stalls or guarantee cold-cache startup latency.

Unchanged boundaries:

- The exact owned internal Docker network, private IPv4 gateway and one
  validated target port; listener port 443, no host ports, mounts or DNS.
- Read-only container, 128 MiB, 0.5 CPU, 32 PIDs, dropped capabilities except
  `NET_BIND_SERVICE`, and no-new-privileges.
- Exactly 16 or 32 accepted client sessions; excess clients close promptly
  and at most eight fixed capacity markers are logged.
- 120-second traffic-idle timeout, 180–7,380-second process lifetime, and
  cleanup of both stream directions on disconnect, SIGTERM or expiry.
- The existing five-second TLS readiness deadline, ephemeral CA, authenticated
  TURN, actual SFrame decoding, source consent, chat/screen and renewal checks.

The proxy does not parse HTTP, terminate TLS, decode media or receive frame
keys. Two fixed 32-KiB copy buffers per session provide backpressure rather
than unbounded queues. Arguments are closed and canonical; public addresses,
DNS names, IPv6, unknown connection limits and extra arguments are rejected.
Its fixed entry/network/listener markers use the existing observation shape;
with this profile, entry/network markers refer to Go startup, not JavaScript.
Missing or old markers still cannot manufacture readiness.

There is no warmup, cache flush, enlarged readiness budget, fixture retry or
relaxed media assertion. Both old and native startup can succeed locally; the
Node TURN job also passed on `f10f295`. The failing snapshot on `f465e1d`
therefore motivates a smaller owned helper, not a claim of a reproduced or
permanently fixed kernel failure. The new adapter still requires its own CI
and common production-gate evidence.

Local verification: 39 Node adapter/workflow/diagnostic/TLS checks passed in
1.067 seconds. Go unit/race/vet passed, including five final race-enabled
repetitions in 2.653 seconds; real loopback tests cover binary integrity,
capacity, idle/lifetime/cancel and unavailable backend. A read observation
timeout is explicitly not accepted as evidence that the proxy closed a socket.
The actual final image passed both real browser cases over TCP (36.049 seconds)
and UDP (35.674 seconds), with 16,000 decrypted PCM samples, chat, own screen,
three renewals, required active SFrame without transform errors and forced
relay pairs in each case. These are isolated synthetic-policy tests, not
productive Hub authorization or a WAN/long-duration gate. No host audio
settings, production service, Ananta source or serving assets were changed.

## First failing I/O sample (11 September)

The Ananta job of [CI 34576055134](https://github.com/ananta888/webrtc-minimize-server/actions/runs/34576055134)
at `f465e1d` now includes the expanded reader. Chromium TURN-UDP again failed
before browser launch after 97 refused connections. The owned PID1 was in `D`
with seven threads, 4,611 minor and 527 major faults, 50,769,920 read bytes and
62 read calls. Block-I/O ticks, CPU throttle and OOM counters were zero.
Both JavaScript entry and network-module markers were present, but not the
listener marker; the allowlisted wait symbol was unknown (`null`). Firefox
UDP and both TCP cases passed. The complete CI was still running when this
sample was recorded.

This establishes actual storage-read activity, not its duration or a causal
explanation of the blocked startup. It does not justify a warmup, enlarged
deadline, raw stack inspection, extra capabilities or relaxed media checks.
The next investigation should isolate the private proxy startup under the
same time/resource/network limits, rather than merely collect the same
readiness outcome again. No production TLS failure or repair is inferred.

The previous `c882ea3` run 34574944778 finished failed: alongside the older
Chromium UDP startup fault, project shard 1 failed the unprocessed calibration
of the screen-first/unprocessed audio case **before** applying either strategy.
That shard had 853 passes, one failure and two skips in 493.871 seconds. This
separate calibration gate remains open; no tolerance was changed here.

## Blocked PID1 follow-up (11 September)

CI `34573639631` at `17ef2db` finished with all other jobs successful;
only Chromium TURN-UDP failed before browser startup. The failure snapshot
showed PID1 in `D`, one thread, no CPU throttling/OOM counters and no observed
JavaScript-entry marker. Firefox UDP and both TCP dialogs passed. `D` alone
does not establish a disk, entropy, memory or scheduling cause.

The failure-only reader now includes minor/major faults, block-I/O wait ticks,
process `read_bytes` and read-call counts. A fourth bounded read accesses only
the same owned container's `/proc/1/wchan`. Only a fixed list of known wait
symbols can be emitted; unknown symbols, addresses, offsets, zero and denied
reads become `null`. No stack, mappings, command line, environment, host PID
or extra Linux capability is accessed. All four calls retain the individual
one-second/4-KiB limits; the wait-symbol projection itself is limited to 128
bytes. Thus failure inspection can add at most four per-call timeout budgets,
after the original readiness failure, never extend readiness into success.

The [Linux proc documentation](https://docs.kernel.org/filesystems/proc.html)
defines the fixed stat offsets, I/O counters and wait symbol. Faults and I/O
counters are cumulative; zero is not evidence against pending I/O, and missing
fields are not invented zeros. Wait symbols depend on kernel configuration
and access restrictions; a single snapshot is not a causal diagnosis.
No fixture restart, warmup, larger readiness deadline or policy change is
introduced. A failing CI sample is still required to select a causal repair.

The 35 focused parser, redaction, exact-target, real timeout and unchanged
TLS/proxy tests pass (1.074 seconds). A real owned proxy-only socket probe,
without a browser or media, verified forwarding and the expanded projection:
sleeping PID1, seven threads, 6,275 minor faults, zero major faults/block-I/O
ticks/storage-read bytes, 88 read calls and `do_epoll_wait`. The proxy, STUN
fixture and private network were cleaned up. This healthy local snapshot is
not a reproduction or repair of the CI startup failure. No current production
configuration, host audio or browser session was modified.

## Current failure-only resource observation (11 September)

[CI 34548642305](https://github.com/ananta888/webrtc-minimize-server/actions/runs/34548642305)
at `2ae0445` finished failed solely in the separate Chromium TURN-UDP startup:
98 refused connections, container running, no observed JavaScript-entry or
listener marker. Firefox UDP and both TCP cases passed. Both complete project
shards passed (1,629 Node/browser passes, five explicit skips), as did native,
blind-agent, both macOS, production-image and live Keycloak/TURN jobs.
The earlier intermittent native audio failures did not recur in this run;
that does not prove their full historical cause or permanent resolution.

Failure inspection now adds one bounded `docker exec` to read exactly
`/proc/1/stat`, `cpu.stat` and `memory.events` of its own started proxy.
It exposes only PID1 state, user/system ticks, thread count and fixed numeric
CPU/memory counters; executable names, PIDs, addresses, commands, environment,
unknown fields and raw records never leave the adapter. The Linux documentation
defines the [process fields](https://docs.kernel.org/filesystems/proc.html)
and [cgroup counters](https://docs.kernel.org/admin-guide/cgroup-v2.html).
Process ticks are not converted to elapsed time; CPU counters cover the cgroup,
including the small diagnostic reader. A single snapshot is not causal proof.

Each of the now three failure-only Docker calls remains limited to one second
and 4 KiB, with a killed CLI on timeout. Unsupported, inaccessible or malformed
records remain unknown. Duplicate or invalid counters never become zeros.
No readiness retry, warmup, restart, timeout or resource-limit increase was
introduced. The five-second readiness contract and original media/consent
deadlines are unchanged. A failed read does not replace the original TLS error.

Thirty-two focused tests pass (1.087 s), including fixed targets, redaction,
numeric bounds and existing deadline/cleanup checks. An actual owned proxy-only
run, without browser or capture, returned seven Node threads, sleeping state,
CPU counters and zero OOM/throttle counters; its own proxy/STUN/network cleanup
completed. That healthy local run is neither a reproduction nor a repair of
the GitHub startup fault. The new projection still needs a failing CI sample.

## Initial isolated startup finding (10 September)

The Ananta job of CI `34489193294` at `cae41da` failed before launching its
Chromium UDP browser: connect/refused after 99 attempts; the owned container
was running without OOM and had not announced its listener. Firefox UDP and
both TCP cases passed. The complete CI has since finished failed: one project
shard passed; the other failed both native scene-output checks.

A local **proxy-only** invocation of the unchanged fixture completed TLS
readiness and cleanup in 4.281 seconds. Its explicit launcher interception
stopped execution before any browser was started. This used ephemeral private
TURN/policy infrastructure, not a human source or production authority.
Local audio/browser tests were paused then while the reported Windows-Firefox
audio issue was investigated; the user has since reported recovery. No host
audio settings were changed in the current investigation. The healthy local startup is neither a
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
