# Self-contained native source transport reference

The 2026-09-09 combined check at `2d39a17` failed before the VP8 source key
announcement. Ten targeted repetitions then produced nine failures across
twenty VP8/Opus cases in 48.731 seconds. Fail-only diagnostics in another
three repetitions observed both peers in `connecting` / ICE `checking`, no
data channel, no control errors and a still-live source receiver. This was
before key installation, decryption or frame decoding.

The Linux test host had 92 network interfaces and 30 IPv4 addresses. The
same-process transport test inherited unrestricted host candidate discovery;
it was therefore not a self-contained local protocol reference. It now reuses
the existing test-only loopback API (previously used for key-only boundaries):
actual UDP4/DTLS/SCTP/SRTP with loopback-only candidates. The test additionally
rejects an SDP with missing, malformed or non-loopback candidates.

Production codec/interceptor construction and the 256-KiB SCTP budget are
retained. No production API, ICE configuration, three-second observation
deadline, four-/five-second source lease, key policy or RTP assertion changed.
All 401 encrypted frames per codec, replay/corruption rejection, key ACK,
feedback flood bounds and terminal cleanup remain exercised. Failure diagnostics
contain only elapsed time, closed state enums, booleans and counts, not SDP,
candidate addresses, identifiers or key material.

Ten repetitions of both corrected real transport cases and the candidate
boundary test passed in 9.055 seconds. This demonstrates the local protocol
fixture under its explicit network boundary, not a public/NAT/TURN/browser
reference or a diagnosis of every host ICE path. Separate browser and network
gates keep their existing real network configuration. The earlier combined
failure is retained; the next grouped check is a separate result.

The subsequent native race matrix found the same unrestricted-fixture setup
in `TestNativeMediaReceivesBrowserRTP` and its early-ICE counterpart: both
expired before connection with zero signaling-stage errors (matrix 60.737 s;
crypto package passed in 2.177 s). Despite the first test's name, its browser
role is another native Pion peer, not Chromium or Firefox. These two cases now
reuse the same adapter and assert gathered loopback candidates **after** the
connection, preserving the actual early-candidate/answer race. Configuration-only
ICE tests and real browser gates retain the production API. Native race/vet and
the grouped check are being repeated on this corrected test boundary.

The corrected complete native `go test -race -timeout=180s ./...` passed:
main package 42.388 seconds, crypto package reused its unchanged successful
cache entry. `go vet ./...` passed as well. This does not retroactively change
the two earlier failed checks or replace the remaining combined browser suite.

SRP/DIP: reuse the focused test-network adapter rather than add fixture flags
to production media construction. The existing long sequential source test
still combines handshake, RTP and lifecycle assertions; extraction of scenario
helpers remains test-maintenance debt, not a reason to duplicate the adapter.
