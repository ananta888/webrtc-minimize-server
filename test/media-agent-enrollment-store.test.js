import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MediaAgentEnrollmentStore } from "../src/media-agent-enrollment-store.js";

function publicKey() {
  return {
    ...crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      .publicKey.export({ format: "jwk" }),
    ext: true,
  };
}

test("one-time enrollment persists only a public agent identity", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "media-agent-enrollment-"));
  const filename = path.join(directory, "agents.sqlite");
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const principal = "https://identity.test/realms/ananta|owner";
  const store = new MediaAgentEnrollmentStore({ filename, ttlMs: 60_000 });
  const enrollment = store.createEnrollment({
    principal, label: "  Arbeitszimmer   Agent ", platform: "linux", now: 1_000,
  });
  assert.equal(enrollment.label, "Arbeitszimmer Agent");
  assert.equal(store.pendingEnrollment(enrollment.token, enrollment.agentId, 1_001).ownerPrincipal, principal);
  const definition = store.completeEnrollment({
    token: enrollment.token,
    agentId: enrollment.agentId,
    publicKey: publicKey(),
    now: 1_002,
  });
  assert.equal(definition.authType, "public-key");
  assert.equal(JSON.stringify(definition).includes(enrollment.token), false);
  assert.throws(() => store.completeEnrollment({
    token: enrollment.token, agentId: enrollment.agentId, publicKey: publicKey(), now: 1_003,
  }), /invalid_agent_enrollment/);
  store.markAuthenticated(enrollment.agentId, 1_004);
  assert.equal(store.list(principal)[0].lastAuthenticatedAt, 1_004);
  store.close();

  const reopened = new MediaAgentEnrollmentStore({ filename });
  assert.equal(reopened.definitions()[0].id, enrollment.agentId);
  reopened.revoke(principal, enrollment.agentId, 1_005);
  assert.equal(reopened.definitions().length, 0);
  assert.equal(reopened.list(principal)[0].revokedAt, 1_005);
  reopened.close();
});

test("enrollment enforces expiry, principal ownership, platform, quota and rate limits", () => {
  const store = new MediaAgentEnrollmentStore({
    ttlMs: 100,
    maxAgentsPerPrincipal: 1,
    maxEnrollmentsPerHour: 2,
  });
  const principal = "issuer|owner";
  assert.throws(() => store.createEnrollment({ principal, platform: "android", now: 1_000 }), /invalid_agent_platform/);
  const expired = store.createEnrollment({ principal, platform: "linux", now: 1_000 });
  assert.throws(() => store.createEnrollment({ principal, platform: "linux", now: 1_050 }), /quota_reached/);
  assert.throws(() => store.pendingEnrollment(expired.token, expired.agentId, 1_101), /invalid_agent_enrollment/);
  const active = store.createEnrollment({ principal, platform: "windows", now: 1_101 });
  assert.throws(() => store.createEnrollment({ principal, platform: "macos", now: 1_102 }), /quota_reached/);
  store.completeEnrollment({
    token: active.token, agentId: active.agentId, publicKey: publicKey(), now: 1_102,
  });
  assert.throws(() => store.createEnrollment({ principal, platform: "linux", now: 3_700_000 }), /quota_reached/);
  assert.throws(() => store.revoke("issuer|other", active.agentId), /media_agent_not_found/);
  store.close();

  const rateStore = new MediaAgentEnrollmentStore({ maxAgentsPerPrincipal: 5, maxEnrollmentsPerHour: 2 });
  rateStore.createEnrollment({ principal, platform: "linux", now: 1_000 });
  rateStore.createEnrollment({ principal, platform: "linux", now: 1_001 });
  assert.throws(() => rateStore.createEnrollment({ principal, platform: "linux", now: 1_002 }), /rate_limited/);
  rateStore.close();
});

test("enrollment rejects unknown key fields and duplicate device keys", () => {
  const store = new MediaAgentEnrollmentStore();
  const first = store.createEnrollment({ principal: "issuer|owner", platform: "linux", now: 1_000 });
  const key = publicKey();
  assert.throws(() => store.completeEnrollment({
    token: first.token, agentId: first.agentId, publicKey: { ...key, d: "forbidden" }, now: 1_001,
  }), /invalid_agent_public_key/);
  store.completeEnrollment({ token: first.token, agentId: first.agentId, publicKey: key, now: 1_001 });
  const second = store.createEnrollment({ principal: "issuer|owner", platform: "linux", now: 1_002 });
  assert.throws(() => store.completeEnrollment({
    token: second.token, agentId: second.agentId, publicKey: key, now: 1_003,
  }), /registration_conflict/);
  store.close();
});
