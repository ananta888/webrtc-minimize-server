# Optional isolated private test peer

The Ananta two-hour fixture attempt at root `8b305d95a` / Meet `91d9203`
failed before its long phase with repeated Chromium `ERR_NETWORK_CHANGED` on
the host-side bootstrap page. It remains a failed test, not evidence for the
cause of older decoder or startup incidents.

The private Hub stdio bridge optionally requests an isolated Chromium browser
from its owning test controller (`MEET_ISOLATED_PEER_BROWSER=1`). The controller
owns container creation, exact network/CA verification, immutable image choice,
resource accounting and cleanup. Meet receives one bounded response and connects
once to the returned endpoint on the requested private subnet. It accepts no
Task, grant, policy change, media input or pre-existing user browser. Unexpected
engines, malformed/duplicate replies, EOF, deadline and foreign endpoints fail;
there is no silent host-launch fallback. Existing ordinary fixtures retain
their original launch path, navigation limits and media assertions.

For the existing Ananta sandbox image, the controller supplies its installed
matching Playwright 1.58 Node client path and binds actual dependency bytes into
its test run. The adapter checks package name/version before loading. This is
only an explicit test dependency; Meet's normal 1.62 dependency and production
code are unchanged. Missing configuration fails before navigation.

The Python fixture includes this extra browser's processes in its existing
soak resource observations. Network-namespace isolation is not exclusive CPU,
memory, GPU, public TURN or multi-host acceptance. Twenty-three bounded Node
handshake/navigation tests passed in 1.636 seconds; the actual joint short and
long gates remain the next verification. No serving build, trust or deployment
is changed by these test helpers.

Two subsequent native short attempts failed separately: the first reached chat
and screen before Ananta's timing fence rejected a source (49.81 seconds); the
second timed out in automated consent setup (41.20 seconds). Consent now reports
the fixed operation stage, without exception text, selectors, identifiers or
policy values. No timeout, approval requirement or assertion is relaxed. These
failures are not successful isolation or soak acceptance.

The private bridge also exposes the fixed `fixture_resources` observation:
own-room member/machine counts and the existing capped TLS-proxy connection-drop
count. It returns no membership identifiers, network addresses, keys or contents,
and accepts no arguments or mutations. This helps distinguish peer startup
failure from insufficient test-proxy capacity without enlarging any limit.

The next joint run at Ananta `1b2206db2` / Meet `c575830` failed in34.03 seconds:
seven blocked Worker module requests matched seven actual proxy-capacity drops,
and the room retained only its human test receiver. The shared fixture had also
created an unused local machine page even though Ananta owns the real machine
browser. The Hub bridge now selects `externalMachine: true`, creating only its
real receiver context and refusing extra local machine contexts. Other browser
fixtures retain their existing default. The16-connection proxy ceiling, request
timeouts and security policies are unchanged. A real receiver-only browser check
and a new joint run verify this fix; no long-run pass is inferred from it.

Receiver-only/native and existing proxy checks passed together:16 tests in
1.651 seconds, including one actual cryptographically authenticated synthetic
receiver, exactly one browser context, no capture calls and no local machine
navigation. The existing proxy limits and negative cases remain covered.

The receiver-only joint repeat loaded all Worker modules without request errors,
but then failed its real20-second join in34.36 seconds with two further proxy
capacity drops. Removing the unused context was necessary resource hygiene,
not a complete capacity fix. The Hub bridge now explicitly uses the existing
32-connection multi-client test profile: receiver browser, Worker browser and
Worker's separate restricted `route.fetch` HTTP client share this forwarder.
The default remains16 for ordinary fixtures; proxy memory/CPU/PID limits,
application room/source capacities, request/join/consent deadlines and security
checks remain unchanged. This new declared test profile requires another native
run; previous failed runs are not reclassified.

## Joint short and grouped verification

The32-connection bridge passed the full Ananta short scenario in29.32 seconds
at Meet `66b6055`, then again in28.21 seconds at the integrated `21cff89` with
Ananta `478bfac39`. Actual chat, moving owned screen, pause/resume, private-marker
stop and cancellation remained enabled; source timing was explicitly negotiated.
Both were pre-reserved Hub TEST runs, never production-release evidence.

The isolated full `npm run check` at `21cff89` completed with exit0:
1085 frontend tests in13.14 seconds, production build in8.060 seconds, Go and
static/security/configuration gates passed; Node stage1008 passed/0failed/2skips
in380.582 seconds. Fourteen external infrastructure gates and the optional image
archive scan were explicit skips. The source build's existing initial-bundle
budget warning remains; no serving build or running deployment was changed.

The separate Ananta two-hour-profile attempt finished failed in39.95 seconds
at the750-ms screen freshness fence (observed gap1,096,801 microseconds), while
the large frontend stage was running. This is neither a two-hour success nor
proof of a causal scheduling diagnosis. Ananta adds passive bounded scheduling
observations and separates the next timed soak from large suites.

`scripts/live-machine-dialog-audio-chat-soak.mjs` is an additional skip-by-default
harness for PCM, chat ACK and screen together. It starts only with
`MACHINE_AUDIO_CHAT_SOAK_SECONDS=300..7200` and is not a two-hour or Hub-trust
result. MDS-08/09 and the public operator/trust/evidence acceptance remain open.
