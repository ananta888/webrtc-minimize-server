import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createAppServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { BroadcastRuntimeRegistry } from "../src/broadcast-runtime-registry.js";
import { BroadcastGrantAuthority } from "../src/broadcast-grant-authority.js";
import { broadcastGrantDeviceProofMessage } from "../src/broadcast-device-proof.js";
import { deviceFingerprint } from "../src/device-proof.js";

for (const target of ["another-owned-program", "nonexistent-program"]) {
  test(`publisher HTTP path rejects ${target} before consuming a challenge, issuing a grant or starting a program`, async t => {
    const now = Date.now(), origin = "https://synthetic-meet.example.test";
    const owner = { issuer: "https://identity.example/realms/ananta", subject: "synthetic-owner", displayName: "Synthetic owner",
      audience: "human", algorithm: "RS256", issuedAt: now - 1000, expiresAt: now + 60000 };
    const signing = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const grants = new BroadcastGrantAuthority({ issuer: origin + "/broadcast-grants", oidcIssuer: owner.issuer,
      oidcAudience: "human", oidcAlgorithms: ["RS256"], signingKeys: [{ kid: "synthetic", ...signing }] });
    let issued = 0;
    const runtime = new BroadcastRuntimeRegistry({ clock: () => now, programCapacityLimits: { principal: 1 }, grantAuthority: {
      issue: async (...args) => { issued++; return grants.issue(...args); },
      issueAnonymousPlayback: (...args) => grants.issueAnonymousPlayback(...args),
      revokeGrant: (...args) => grants.revokeGrant(...args),
      revokeProgramEpoch: (...args) => grants.revokeProgramEpoch(...args),
    } });
    const device = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKey = device.publicKey.export({ format: "jwk" });
    const member = { principal: `${owner.issuer}|${owner.subject}`, roomId: "room-synthetic", creator: true,
      deviceFingerprint: deviceFingerprint(publicKey) };
    const create = () => runtime.createProgram(owner, member, { requestVersion: 1, roomId: member.roomId,
      title: "Synthetic program", visibility: "private" }).control.programId;
    const programId = create(), otherId = target === "another-owned-program" ? create() : "prg_aaaaaaaaaaaaaaaa";
    const challenge = runtime.createPublisherChallenge(owner, member, programId, { requestVersion: 1,
      action: "whip:create", sourceIds: ["src_aaaaaaaaaaaaaaaa"] });
    const nonce = crypto.randomBytes(24).toString("base64url");
    const signature = crypto.sign("sha256", Buffer.from(broadcastGrantDeviceProofMessage(challenge.proofContext, now, nonce)),
      { key: device.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    const input = { requestVersion: 1, challengeId: challenge.challengeId, deviceProof: { publicKey, timestamp: now, nonce, signature } };
    const app = createAppServer({ config: loadConfig({ PUBLIC_ORIGIN: origin, AUTH_MODE: "required", PAIR_WORKSPACE_ENABLED: "false",
      OIDC_ISSUER: owner.issuer, OIDC_AUDIENCE: "human", OIDC_CLIENT_ID: "synthetic-browser" }),
      broadcastRuntime: runtime, oidcVerifier: { async verify(token) {
        assert.ok(["synthetic-owner", "synthetic-unrelated"].includes(token));
        return token === "synthetic-owner" ? owner : { ...owner, subject: "synthetic-unrelated" };
      } } });
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      for (const server of [app.webSocketServer, app.nativePackagerWebSocketServer, app.mediaAgentWebSocketServer]) {
        for (const socket of server.clients) socket.terminate();
      }
      app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    });
    const authorize = async (id, token = "synthetic-owner") => {
      const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/broadcasts/${id}/publisher-authorizations`, {
        method: "POST", headers: { origin, authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(input), signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, body: await response.json() };
    };
    const before = runtime.programStateCounts();
    const denied = await authorize(otherId);
    assert.equal(denied.status, 404);
    assert.equal(issued, 0, "wrong path cannot allocate a publisher grant");
    assert.deepEqual(runtime.programStateCounts(), before);
    assert.equal(runtime.challengeCount, 1, "wrong path cannot consume another program's challenge");
    assert.equal(JSON.stringify(denied.body).includes(programId), false);
    assert.deepEqual(await authorize(programId, "synthetic-unrelated"), denied, "wrong principal receives the same non-enumerable denial");
    for (const invalid of [undefined, null, {}, "", programId + "\n"]) {
      await assert.rejects(runtime.authorizePublisher(owner, invalid, input), error => error.status === 404);
    }
    assert.equal(issued, 0); assert.equal(runtime.challengeCount, 1);
    const accepted = await authorize(programId);
    assert.equal(accepted.status, 201); assert.equal(accepted.body.program.programId, programId);
    assert.equal(typeof accepted.body.accessToken, "string");
    assert.equal(issued, 1); assert.equal(runtime.programStateCounts().preparing, 1);
    assert.equal(runtime.challengeCount, 0);
    assert.equal((await authorize(programId)).status, 404, "correct route retains one-time challenge semantics");
    assert.equal(issued, 1);
  });
}
