# Isolated browser build for machine integration tests

The private machine browser fixture accepts `MEET_TEST_PUBLIC_DIR`, or its
`publicDir` argument, as an absolute local directory containing `index.html`.
It validates this before creating TLS, network or browser resources. Unset
preserves the existing `dist/browser` default. This is test-only configuration;
it does not change the production server configuration or trust policy.

For example, create a private temporary directory and build with
`ng build --configuration production --output-path <private-directory>`.
Run Ananta's gate with `MEET_TEST_PUBLIC_DIR=<private-directory>/browser`.
This Angular-only build suffices for the machine media fixture; it is not a
complete Vosk/production deployment build. Never overwrite a serving `dist`
just to prepare an integration test. For the complete repository check use a
separate checkout/worktree, where `npm run check` can generate its own assets.

Ananta's three-renewal gate exposed a stale local bundle from before sender-slot
reuse. Three old-build attempts failed around 202 seconds with missing remote
avatar. A fresh isolated build passed three renewals and four spoken replies;
the entire gate still failed in 235.94 seconds on the fifth PCM reply. A later
diagnostic identified an underrun during a 287.9-ms Python/browser RPC. That
producer-cadence work remains in Ananta; do not infer a new Meet transport fix
or a complete dialog/soak/production acceptance from this fixture change.

The initial directory helper and its test were consolidated into the concurrently
published `machineFixtureAssets` validator and its five asset/HTTP tests. It
additionally checks bounded index content and its local JavaScript entry files;
the shared fixture uses that single validation path before creating resources.
The Ananta preflight additionally rejects obviously stale builds by timestamp;
that conservative check is not cryptographic build provenance. No media,
credential, participant identity or production authorization is generated here.

The complete Node matrix now defaults to two concurrent test processes. Two
default-concurrency full checks each produced the same Chromium avatar/churn
timeouts (524 passed, two failed, three skipped); all four affected Chromium
and Firefox cases passed serially. The complete two-process matrix passed
526 tests with three existing skips in 128.40 seconds. This bounds aggregate
browser contention without omitting tests or relaxing any media deadline.
It is a test-runner resource budget, not a production transport correction.
