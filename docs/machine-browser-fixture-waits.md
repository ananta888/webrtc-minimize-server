# Private browser readiness checks

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
