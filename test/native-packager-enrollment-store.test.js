import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  NativePackagerEnrollmentStore,
  nativePackagerOperatorProvisioningMessage,
} from "../src/native-packager-enrollment-store.js";

function publicKey() {
  return { ...crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "jwk" }), ext: true };
}

test("native packager enrollment is one-time, owner-bound and stores only a public key", () => {
  const store = new NativePackagerEnrollmentStore({ ttlMs: 60_000 });
  const ownerPrincipal = "https://identity.test/realms/ananta|owner";
  const enrollment = store.createEnrollment({ ownerPrincipal, label: "  Mini PC  ", platform: "linux", now: 1_000 });
  assert.match(enrollment.packagerId, /^pkr_/);
  assert.equal(enrollment.label, "Mini PC");
  const definition = store.complete({
    enrollmentToken: enrollment.enrollmentToken,
    packagerId: enrollment.packagerId,
    publicKey: publicKey(),
    now: 1_001,
  });
  assert.equal(definition.ownerPrincipal, ownerPrincipal);
  assert.equal(Object.hasOwn(definition, "enrollmentToken"), false);
  assert.throws(() => store.complete({
    enrollmentToken: enrollment.enrollmentToken,
    packagerId: enrollment.packagerId,
    publicKey: publicKey(),
    now: 1_002,
  }), /invalid_native_packager_enrollment/);
  assert.equal(store.list(ownerPrincipal)[0].id, enrollment.packagerId);
  store.revoke(ownerPrincipal, enrollment.packagerId, 1_003);
  assert.equal(store.definitions().length, 0);
  assert.throws(() => store.revoke("issuer|other", enrollment.packagerId), /native_packager_not_found/);
  store.close();
});

test("native packager enrollment rejects expiry, private key fields and quota overflow", () => {
  const store = new NativePackagerEnrollmentStore({ ttlMs: 100, maximumPerPrincipal: 1 });
  const ownerPrincipal = "issuer|owner";
  const enrollment = store.createEnrollment({ ownerPrincipal, platform: "linux", now: 1_000 });
  assert.throws(() => store.pending(enrollment.enrollmentToken, enrollment.packagerId, 1_101), /invalid_native_packager_enrollment/);
  assert.throws(() => store.createEnrollment({ ownerPrincipal, platform: "linux", now: 1_050 }), /quota_reached/);
  const fresh = store.createEnrollment({ ownerPrincipal, platform: "linux", now: 1_101 });
  assert.throws(() => store.complete({
    enrollmentToken: fresh.enrollmentToken,
    packagerId: fresh.packagerId,
    publicKey: { ...publicKey(), d: "forbidden" },
    now: 1_102,
  }), /invalid_native_packager_public_key/);
  store.close();
});

test("operator provisioning proves local key possession without an OIDC token", () => {
  const store = new NativePackagerEnrollmentStore({ maximumPerPrincipal: 2 });
  const { privateKey, publicKey: generatedPublicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const manifest = {
    version: 1,
    type: "native-packager-operator-provisioning",
    packagerId: "pkr_operator0123456789",
    ownerPrincipal: "https://identity.test/realms/ananta|owner",
    label: "Mini-PC Broadcast-Packager",
    platform: "linux",
    publicKey: { ...generatedPublicKey.export({ format: "jwk" }), ext: true },
  };
  const proof = crypto.sign("sha256", Buffer.from(nativePackagerOperatorProvisioningMessage(manifest)), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  const registered = store.completeOperatorProvisioning({ ...manifest, proof }, 2_000);
  assert.equal(registered.ownerPrincipal, manifest.ownerPrincipal);
  assert.equal(store.list(manifest.ownerPrincipal)[0].label, manifest.label);
  assert.throws(() => store.completeOperatorProvisioning({ ...manifest, packagerId: "pkr_tampered012345678", proof }, 2_001),
    /invalid_native_packager_operator_proof/);
  assert.throws(() => store.completeOperatorProvisioning({ ...manifest, proof, unexpected: true }, 2_002),
    /invalid_native_packager_operator_provisioning/);
  store.close();
});
