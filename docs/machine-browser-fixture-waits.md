# Private browser readiness checks

## Isolated current-build selection

`machineBrowserFixture(t, { publicDir: absoluteBrowserDirectory })` can serve an
explicit build without replacing `dist/browser`. The private bridges, short
browser tests and opt-in soak also accept `MEET_TEST_PUBLIC_DIR` through this
fixture; an explicit option takes precedence. This is a local test-runner input,
not a production environment setting or an HTTP/stdio command.

For example, from this repository:

```bash
meet_fixture_build=$(mktemp -d /tmp/webrtc-machine-build.XXXXXX)
npx ng build --configuration production --output-path "$meet_fixture_build"
MEET_TEST_PUBLIC_DIR="$meet_fixture_build/browser" node --test test/machine-avatar.browser.e2e.test.js
```

Use the same environment when launching the private Hub bridge from an external
test runner. Keep this directory unchanged for the lifetime of the run. The
fixture validates an absolute directory, a bounded regular `index.html` and its
local JavaScript entry files before creating TLS, Docker or browser resources.
Invalid or incomplete explicit selection returns `test_public_dir_invalid`;
there is no fallback to potentially stale `dist`. Without explicit selection,
the existing server default is unchanged. This validates asset availability,
not source freshness: record the checkout revision and build command alongside
the test evidence. The Angular-only command above covers machine media fixtures;
it does not run the separate Vosk worker extraction needed for caption tests.

No running application or existing output directory is restarted, overwritten
or removed. The temporary build is caller-owned and is not deleted by fixture
cleanup. A passing current-build short test does not retrospectively pass an
old-build failure or replace the separate multi-renewal/long-duration matrix.

The short avatar matrix now checks three real lease renewals in the same room
membership and PeerConnection. After each renewal it reauthorizes all three
synthetic publications and checks moving remote avatar pixels/label, decoded
screen pixels alternating red/green/red (a stale green frame cannot pass) and
new non-silent audio windows, with active SFrame and exactly
three reusable transceivers. A stale avatar generation cannot close its
successor. This closes the former test gap where only a local `open` state was
asserted after renewal. Chromium and Firefox passed the isolated current-build
matrix in 21.98 seconds on 2026-09-07, with zero capture/transform errors. It is
not a reproduction or clearance of the separate approximately 202-second
cross-repository failure and does not substitute for the long-duration gate.

## Bounded browser observations

The neutral-avatar matrix exposed an interaction between Firefox automation and
Angular's ZoneAwarePromise: `page.waitForFunction` returned a serialized pending
promise (`__zone_symbol__state: null`) before the predicate was satisfied. This
is not application readiness. Separate subsequent evaluations could still have
valid media, but the wait itself could not certify the claimed condition.

`test/helpers/machine-browser-wait.mjs` now polls synchronous JSON observations
from Node, with an independent host deadline (maximum 30 seconds). The default
acceptor requires exactly `true`. Pixel/audio snapshots use explicit structural
and numeric acceptors and return that same observed value, not a later sample.
Promise-shaped objects fail closed even with a permissive custom acceptor.
Errors are not retried. Timeout/cancel stops polling; a late pending read cannot
start another iteration. No application Promise, Angular global or media policy
is replaced, and the helper performs no browser operation beyond its supplied
read-only predicate.

Bootstrap uses this wait port within its existing shared 30-second deadline and
two-attempt exact-network-change policy. An interrupted bootstrap aborts its
old readiness poll. The human room-ID wait and receiver speech/neutral-avatar
checks use the same helper. Chromium machine operations retain their existing
source contracts. Six helper tests cover strict values, accepted snapshots,
promise rejection, hung reads, cancellation, errors and budget validation;
eleven navigation tests retain the separate retry/deadline assertions.

The earlier failed avatar attempts remain failed observations. The corrected
private matrix separately rechecks actual Firefox and Chromium face/label
pixels, moving indicator and non-silent audio after avatar stop, plus the
existing complete 66,150-sample speech scenarios. No remote sample-exactness or
production readiness is inferred from this test-driver correction.

The subsequent full check found the same early-wait issue in the existing
Firefox caption-catalog test (zero model requests observed immediately after
the explicit load click). Its four UI waits now use actual synchronous values
too; the fixed request-count assertion and deliberately aborted model response
remain unchanged. Capture functions now throw in that fixture rather than
delegating an accidental call to a real browser permission prompt.
