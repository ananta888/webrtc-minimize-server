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
