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
