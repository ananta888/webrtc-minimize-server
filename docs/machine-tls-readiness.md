# Bounded private Ananta TLS readiness

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
