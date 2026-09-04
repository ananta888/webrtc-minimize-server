import fs from "node:fs";

import {
  NativePackagerEnrollmentError,
  NativePackagerEnrollmentStore,
} from "./native-packager-enrollment-store.js";

const MAX_MANIFEST_BYTES = 8 * 1024;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

if (process.argv.length !== 3 || !process.argv[2] || process.argv[2].includes("\0")) {
  fail("usage: node src/native-packager-operator-provision.js DATABASE_FILE < manifest.json");
} else {
  try {
    const raw = fs.readFileSync(0);
    if (raw.length < 2 || raw.length > MAX_MANIFEST_BYTES) {
      throw new NativePackagerEnrollmentError("invalid_native_packager_operator_provisioning");
    }
    let manifest;
    try { manifest = JSON.parse(raw.toString("utf8")); } catch {
      throw new NativePackagerEnrollmentError("invalid_native_packager_operator_provisioning");
    }
    const store = new NativePackagerEnrollmentStore({ filename: process.argv[2] });
    try {
      const result = store.completeOperatorProvisioning(manifest);
      process.stdout.write(`${JSON.stringify({
        packagerId: result.id,
        keyFingerprint: result.keyFingerprint,
      })}\n`);
    } finally {
      store.close();
    }
  } catch (error) {
    fail(error instanceof NativePackagerEnrollmentError
      ? error.code
      : "native_packager_operator_provisioning_failed");
  }
}
