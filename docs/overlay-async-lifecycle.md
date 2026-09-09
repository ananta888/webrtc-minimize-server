# Async overlay ownership and session retirement

MDS-06, source audit `c49e8dc`, 9 September 2026.

The opaque overlay carries SFrame key messages as encrypted peer traffic. Its
WebCrypto promises are asynchronous: checking membership only before an import,
derivation or receive does not authorize a later completion after Leave,
replacement, route change or reinitialization.

Deterministic tests holding actual WebCrypto results reproduced these defects:
late initialization/import could restore retired state; an older import or ECDH
derivation could overwrite newer key state; delayed decrypt could deliver data
after retirement. Two concurrent copies could also pass the replay check before
either completed digest verification. This is evidence for these races, not an
established cause of the earlier sporadic SFrame `pending` startup or source
clock discrepancies.

## Implemented boundary

- Overlay lifetime and exact key identities fence every async key operation.
  Only the latest import for a peer may commit. Retiring/replacing a key clears
  its cached derived key, affected resumable ciphertext and partial plaintext.
- Encrypt/decrypt/digest completions recheck their captured lifetime and key
  identities. A late operation cannot repopulate a cache, return ciphertext,
  forward a packet or deliver plaintext. Digest completion rechecks replay
  before claiming a packet, so concurrent copies cannot both deliver.
- Owned plaintext chunks are wiped after encryption, successful assembly,
  expiry, peer removal or destruction, including plaintext returned by a late
  decrypt. WebCrypto promises themselves are not cancellable; garbage collection
  and forensic memory erasure are not promised.
- The mesh rechecks its identity, overlay generation, membership and exact peer
  objects after async work. Send/receive also bind the route epoch. Peer-key
  import remains membership-bound, not unnecessarily tied to route-only changes.
  Stale delivery is wiped before ACK, media-key handling or application delivery.

These checks are local lifecycle fences, not new membership authority. Server
policy, source consent, SFrame ACKs, wire contracts and no-capture defaults are
unchanged. The small crypto owner stays separate from mesh policy; the existing
broad PeerMesh composition remains SRP debt, with its async scope predicate an
extraction point rather than a new global peer registry.

## Verification

The initial 15 WebCrypto race tests failed; 17 of 18 new mesh tests failed while
the unchanged current-operation case passed. After implementation, all 53
focused overlay, mesh, exact-key-ACK and SFrame-revocation tests passed in
1.56 seconds. These use actual cryptography with controlled completion order,
not a claim about live RTP delivery. The isolated production build, actual
browser regression and combined check follow before release consideration.
No serving build, deployment, Hub trust or Ananta repository was changed.
