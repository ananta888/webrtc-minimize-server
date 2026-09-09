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
