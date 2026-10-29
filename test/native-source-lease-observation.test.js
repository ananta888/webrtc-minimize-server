import assert from "node:assert/strict";
import test from "node:test";
import { recordSourceLease } from "./helpers/native-source-lease-observation.mjs";

test("source lease observations preserve deadlines and stop reason without authority or identities", () => {
  const rows = [];
  recordSourceLease(rows, { version: 1, type: "trusted-source-publisher-lease", lease: {
    revision: 3, expiresAt: 4000, consent: { expiresAt: 8000, consentId: "private" }, publisherPeerId: "private" } }, 2000);
  recordSourceLease(rows, { version: 1, type: "trusted-source-publisher-stop", leaseRevision: 3,
    expiresAt: 4000, reasonCode: "SOURCE_AUTHORITY_LOST", sourceLeaseId: "private" }, 4500);
  assert.deepEqual(rows, [{ outcome: "lease", revision: 3, remainingMs: 2000, consentRemainingMs: 6000 },
    { outcome: "stop", revision: 3, remainingMs: -500, code: "SOURCE_AUTHORITY_LOST" }]);
  assert.ok(rows.every(Object.isFrozen));
});

test("source observation rejects invalid clocks, malformed leases and arbitrary diagnostic text", () => {
  const rows = [], lease = { version: 1, type: "trusted-source-publisher-lease",
    lease: { revision: 1, expiresAt: 4000, consent: { expiresAt: 8000 } } };
  for (const now of [NaN, Infinity, 0, -1, 1.2]) recordSourceLease(rows, lease, now);
  for (const value of [{ ...lease, version: 2 }, { ...lease, lease: {} },
    { version: 1, type: "trusted-source-publisher-stop", leaseRevision: 1, expiresAt: 4000, reasonCode: "secret" }]) {
    recordSourceLease(rows, value, 1000);
  }
  assert.deepEqual(rows, []);
  for (let i = 1; i <= 100; i++) recordSourceLease(rows, { ...lease, lease: { ...lease.lease, revision: i } }, 1000);
  assert.equal(rows.length, 32);
  assert.equal(rows[0].revision, 69);
});
