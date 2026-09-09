# Headless public infrastructure test boundary (MDS-08/09)

Source audit at `962f678`: the optional live Keycloak/TURN script has no overall
process deadline, uses unbounded discovery/JWKS fetches, forwards unexpected
capture calls to real devices, and includes page text/URL in a failed-login
exception. These are test-boundary defects; no live operator permission or
credential is inferred from finding them.

Keep the opt-in CLI and existing PKCE/JWKS/ticket/TURN assertions, but execute
the actual test in an owned child process group with closed stdin, bounded
lifetime and cleanup. Its output must be a closed, content-free IPC report;
raw stdout/stderr and exception/DOM/URL details are never forwarded. Missing
credentials fail before browser resources. Capture APIs fail immediately and
cannot open a permission prompt. No authentication, trust, assertion or E2EE
requirement is removed.

Separate the execution supervisor, live test and fixed report contract (SRP).
Deterministic tests must cover timeout/cancellation/failed start, malformed or
duplicate reports, raw-output rejection, owned-child cleanup and no-capture
behavior without external credentials. Existing disabled invocation remains
an explicit skip, not public evidence. A real live execution still requires
an operator-provided test identity and endpoint; relay candidates alone remain
distinct from selected-pair and delivered-payload evidence.

## Implemented boundary and verification

The original CLI now supervises a fixed internal module. It accepts no command
or shell argument, closes stdin, suppresses child stdout/stderr, and validates
an exact IPC shape before emitting a content-free result. A 120-second deadline
and cancellation terminate only its owned POSIX process group (TERM, then KILL
after 250 ms). Unsupported process-group platforms fail before launch. This
does not claim recovery after an uncatchable supervisor kill or a host crash.

Discovery/JWKS documents have a five-second deadline, a 64 KiB body ceiling,
strict UTF-8 parsing, and no redirect following. JWKS stays on the configured
issuer origin. The browser only requests the configured app/issuer origins,
blocks service workers/downloads, and rejects capture calls without invoking
devices. No DOM, URL, exception detail or credential is returned in diagnostics.
Existing OIDC, ticket, ephemeral TURN and relay-candidate assertions remain.

On 2026-09-09, `node --test --test-concurrency=1
test/live-infrastructure-boundary.test.js
test/live-infrastructure-supervisor.test.js` passed all **23 tests in 1.897 s**.
They include an actual hung Node process and an uncooperative owned descendant,
plus missing credentials, malformed/duplicate reports, failure cleanup, output
suppression, bounded HTTP and capture rejection. Linux `/proc` observation is
explicitly Linux-only; unsupported-platform checks are deterministic.

The real disabled CLI returned its explicit skip. The enabled CLI with test
credentials absent returned exit 1 / `live_credentials_missing`, without a
browser or network request. These checks are technical test observations, not
a successful public OIDC/TURN run or production evidence. No test account,
public trust profile, deployed bundle or running service was changed.

SRP improves by separating supervision, network/capture boundaries and the live
scenario. The existing sequential multi-assertion scenario is preserved; no
runtime business policy is moved into these test helpers. The broader grouped
suite follows the ongoing isolated soak instead of competing for its resources.

The subsequent [selected-pair/payload probe](live-turn-payload-probe.md) replaces
the candidate-only sub-operation. Its narrow same-browser data-channel scope
is explicit in the report; application-media, external-receiver and production
claims remain false. The original boundary results above remain historical.
