import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { NativePackagerEnrollmentStore } from "../src/native-packager-enrollment-store.js";

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
