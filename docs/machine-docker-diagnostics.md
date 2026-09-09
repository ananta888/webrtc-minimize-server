# Closed private Docker failure diagnostics

MDS-08: the Linux Ananta paired-idle reference failed before media because all
Docker predefined address pools were fully subnetted. The existing Docker helper
classified this as unknown, and the single-Hub bridge discarded even the bounded
operation/status/reason projection. This hid the actionable infrastructure cause.

The test-only classifier now recognizes `network_pool_exhausted` and
`network_busy` (active endpoints/containers). A shared strict parser lets both
private bridges report only an allowlisted operation, canonical status 0..255
or `unknown`, and a fixed reason. No stderr, command arguments, cause, network
name, temporary TURN secret or arbitrary error text is forwarded. This avoids
duplicated diagnostic contracts while preserving the runner's bounded execution.

This does not allocate alternate subnets, retry browser tests, prune networks or
change production runtime/trust. Ananta separately fixes its parent-owned
browser-before-network teardown and pins the exact private network identity for
cleanup after an early bridge exit. Older failed runs stay failed.

Deterministic tests cover all 440 allowed operation/status/reason combinations,
actual known error strings with a secret canary, malformed/out-of-range status,
prefixes, suffixes and unknown fields. The 26 focused Docker/TLS/STUN/TURN
checks passed in 0.251 seconds; both bridge syntax checks and all 28 Todo
documents passed. Grouped verification remains separate.
