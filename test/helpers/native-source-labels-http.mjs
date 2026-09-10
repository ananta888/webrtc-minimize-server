import assert from "node:assert/strict";
import fs from "node:fs";
import Ajv from "ajv/dist/2020.js";

const validate = new Ajv({ strict: true }).compile(JSON.parse(fs.readFileSync(
  new URL("../../contracts/native-packager/source-labels-response.v1.schema.json", import.meta.url))));

/** Actual HTTP/JWT, registries and source ACK; no native media or browser claim. */
export async function exerciseNativeSourceLabelsHttp({ base, token, publisherToken, config, f, control, lease, peerId }) {
  const input = { requestVersion: 1, deviceFingerprint: f.owner.deviceFingerprint,
    expectedProgramRevision: control.programRevision, expectedProgramEpoch: control.programEpoch,
    expectedPackagerId: f.packagerId, expectedAssignmentId: lease.assignmentId, expectedFencingRevision: lease.fencingRevision,
    sourceLeaseIds: [lease.sourceLeaseId] };
  const url = `${base}/api/broadcasts/${f.programId}/native-source-labels`;
  const headers = { origin: config.publicOrigin, "content-type": "application/json", authorization: `Bearer ${token}` };
  const post = (body = input, options = {}) => fetch(url, { method: "POST", headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000), ...options });
  const response = await post(); assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const value = await response.json(); assert.ok(validate(value), JSON.stringify(validate.errors));
  assert.deepEqual(value.bindings, [{ sourceLeaseId: lease.sourceLeaseId, publisherPeerId: peerId, sourceKind: "camera" }]);
  for (const patch of [{ unexpected: true }, { requestVersion: 2 }, { sourceLeaseIds: [lease.sourceLeaseId, lease.sourceLeaseId] },
    { sourceLeaseIds: Array(81).fill(lease.sourceLeaseId) }, { deviceFingerprint: "wrong" }]) {
    assert.equal((await post({ ...input, ...patch })).status, 400);
  }
  for (const patch of [{ expectedProgramRevision: control.programRevision + 1 }, { expectedProgramEpoch: control.programEpoch + 1 },
    { expectedPackagerId: "pkr_bbbbbbbbbbbbbbbb" }, { expectedAssignmentId: "asn_bbbbbbbbbbbbbbbb" },
    { expectedFencingRevision: lease.fencingRevision + 1 }]) assert.equal((await post({ ...input, ...patch })).status, 409);
  assert.equal((await post({ ...input, deviceFingerprint: "z".repeat(43) })).status, 403);
  assert.equal((await post({ ...input, deviceFingerprint: f.input.deviceFingerprint }, {
    headers: { ...headers, authorization: `Bearer ${publisherToken}` },
  })).status, 404, "valid publisher identity and membership do not disclose another owner's program");
  assert.equal((await post(input, { headers: { ...headers, authorization: "Bearer invalid" } })).status, 401);
  assert.equal((await post(input, { headers: { ...headers, origin: "https://foreign.example" } })).status, 404);
  assert.equal((await post(input, { headers: { ...headers, "content-type": "text/plain" } })).status, 404);
  assert.equal((await post(input, { method: "GET", body: undefined })).status, 404);
  assert.equal((await fetch(url + "?token=forbidden", { method: "POST", headers, body: JSON.stringify(input) })).status, 404);
  assert.equal((await post(input, { body: "{" })).status, 400);
  assert.equal((await post({ ...input, unexpected: "a".repeat(17000) })).status, 400);
  const unknown = await post({ ...input, sourceLeaseIds: ["sls_bbbbbbbbbbbbbbbb"] });
  assert.equal(unknown.status, 200); assert.deepEqual((await unknown.json()).bindings, []);
  return async () => {
    const revoked = await post(); assert.equal(revoked.status, 200);
    assert.deepEqual((await revoked.json()).bindings, [], "revoked publisher is not displayed using cached metadata");
    let limited = false;
    for (let i = 0; i < 21; i++) {
      const reply = await post();
      if (reply.status === 429) { limited = true; break; }
      assert.equal(reply.status, 200);
    }
    assert.equal(limited, true, "actual route enforces bounded membership-scoped lookup rate");
  };
}
