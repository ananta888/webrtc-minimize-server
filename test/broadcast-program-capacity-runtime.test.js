import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { BroadcastRuntimeRegistry } from "../src/broadcast-runtime-registry.js";
import { BroadcastGrantAuthority } from "../src/broadcast-grant-authority.js";
import { broadcastGrantDeviceProofMessage } from "../src/broadcast-device-proof.js";
import { deviceFingerprint } from "../src/device-proof.js";
import { createAppServer } from "../src/server.js";
import { broadcastSubjectRef, broadcastTenantRef } from "../src/broadcast-identifiers.js";

const previewScope = owner => ({ tenantId: broadcastTenantRef(owner.issuer), principalRef: broadcastSubjectRef(owner) });

const now = 1_800_000_000_000;
function identity(subject = "owner", issuer = "https://identity.example/realms/ananta") {
  return { issuer, subject, displayName: "Synthetic owner", audience: "human", algorithm: "RS256", issuedAt: now - 1000, expiresAt: now + 60000 };
}
function fixture(limits, suppliedRuntime) {
  const runtime = suppliedRuntime || new BroadcastRuntimeRegistry({ clock: () => now, programCapacityLimits: limits,
    grantAuthority: { issue() { throw new Error("not_used"); }, issueAnonymousPlayback() {}, revokeProgramEpoch() {} } });
  let calls = 0;
  const create = (owner = identity()) => {
    const member = { id: "aaaaaaaaaaaaaaaa", principal: `${owner.issuer}|${owner.subject}`,
      roomId: "room-alpha", creator: true, deviceFingerprint: "a".repeat(43) };
    const programId = runtime.createProgram(owner, member, { requestVersion: 1, roomId: member.roomId,
      title: "Synthetic capacity", visibility: "private" }).control.programId;
    return { owner, member, programId };
  };
  const start = (program, admit = () => ({})) => runtime.prepareNativeSourceProgram(program.owner, program.member, program.programId, {
    requestVersion: 1, trigger: "user-action", inputMode: "trusted-sframe-v1",
    packagerId: "pkr_aaaaaaaaaaaaaaaa", requestedRenditions: 1, allowHardwareAcceleration: false,
  }, () => { calls++; return admit(); });
  return { runtime, create, start, calls: () => calls };
}

test("operator ENV reaches the actual composition root without limiting room membership", async t => {
  const app = createAppServer({ env: { AUTH_MODE: "disabled", PAIR_WORKSPACE_ENABLED: "false",
    BROADCAST_MAX_ACTIVE_PROGRAMS: "1" }, broadcastGrantAuthority: {
    issue() { throw new Error("not_used"); }, issueAnonymousPlayback() {}, revokeProgramEpoch() {},
  } });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const peer of [...app.registry.members("room-isolated"), ...app.registry.members("room-another")]) app.registry.leave(peer);
    for (const server of [app.webSocketServer, app.nativePackagerWebSocketServer, app.mediaAgentWebSocketServer]) {
      for (const socket of server.clients) socket.terminate();
    }
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
  });
  const f = fixture(undefined, app.broadcastRuntime), a = f.create(), b = f.create();
  f.start(a);
  for (let i = 0; i < 100; i++) assert.throws(() => f.start(b), error => error.status === 429);
  assert.equal(f.calls(), 1);
  for (let i = 0; i < 20; i++) app.registry.join("room-isolated", {}, `Synthetic ${i}`);
  assert.throws(() => app.registry.join("room-isolated", {}, "Overflow"), /room_full/);
  app.registry.join("room-another", {}, "Independent room");
  assert.equal(app.registry.roomCount, 2); assert.equal(app.registry.participantCount, 21);
  const health = await fetch(`http://127.0.0.1:${app.server.address().port}/healthz`, { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200); await health.arrayBuffer();
});

for (const scope of ["deployment", "gateway", "tenant", "principal"]) {
  test(`production native start enforces ${scope} capacity before its admission callback`, () => {
    const f = fixture({ deployment: 10, gateway: 10, tenant: 10, principal: 10, [scope]: 1 });
    const a = f.create();
    const b = f.create(scope === "principal" ? identity() : identity("second",
      ["deployment", "gateway"].includes(scope) ? "https://other.example/realm" : identity().issuer));
    assert.equal(f.runtime.programCount, 2, "drafts do not reserve running programs or room slots");
    assert.equal(f.runtime.allowsNewProgram(previewScope(b.owner)), true);
    assert.equal(f.runtime.programCount, 2, "preview allocates no program");
    f.start(a);
    assert.equal(f.runtime.allowsNewProgram(previewScope(b.owner)), false);
    assert.throws(() => f.start(b), error => error.code === "broadcast_temporarily_unavailable" && error.status === 429);
    assert.equal(f.calls(), 1, "no native allocation was attempted for the denied start");
    f.runtime.stopProgram(a.owner, a.programId);
    assert.equal(f.runtime.allowsNewProgram(previewScope(b.owner)), true);
    assert.doesNotThrow(() => f.start(b));
    assert.equal(f.calls(), 2);
    assert.equal(f.runtime.programStateCounts().preparing, 1);
  });
}

test("a rejected native admission never consumes a program slot", () => {
  const f = fixture({ deployment: 1, gateway: 1, tenant: 1, principal: 1 });
  const a = f.create(), b = f.create();
  assert.throws(() => f.start(a, () => { throw new Error("synthetic_admission_denial"); }), /synthetic_admission_denial/);
  assert.doesNotThrow(() => f.start(b));
  assert.equal(f.runtime.programStateCounts().preparing, 1);
});

for (const outcome of ["commit", "stop", "timeout", "issuer-failure"]) {
  test(`pending WHIP and native starts share a slot through ${outcome}`, { timeout: 5000 }, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const owner = identity(), signing = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const grants = new BroadcastGrantAuthority({ issuer: "https://meet.example/broadcast-grants", oidcIssuer: owner.issuer,
      oidcAudience: "human", oidcAlgorithms: ["RS256"], signingKeys: [{ kid: "synthetic", ...signing }] });
    let release, notify, calls = 0, nativeCalls = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { notify = resolve; });
    const runtime = new BroadcastRuntimeRegistry({ clock: () => now,
      programCapacityLimits: { deployment: 1, gateway: 1, tenant: 1, principal: 1 }, grantAuthority: {
        issue: async (...args) => {
          calls++; notify(); await gate;
          if (outcome === "issuer-failure") throw new Error("synthetic_issuer_failure");
          return grants.issue(...args);
        },
        issueAnonymousPlayback: (...args) => grants.issueAnonymousPlayback(...args),
        revokeGrant: (...args) => grants.revokeGrant(...args),
        revokeProgramEpoch: (...args) => grants.revokeProgramEpoch(...args),
      } });
    const device = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKey = device.publicKey.export({ format: "jwk" });
    const member = { id: "aaaaaaaaaaaaaaaa", principal: `${owner.issuer}|${owner.subject}`,
      roomId: "room-alpha", creator: true, deviceFingerprint: deviceFingerprint(publicKey) };
    const create = () => runtime.createProgram(owner, member, { requestVersion: 1, roomId: member.roomId,
      title: "Synthetic shared capacity", visibility: "private" }).control.programId;
    const a = create(), b = create();
    const whip = programId => {
      const challenge = runtime.createPublisherChallenge(owner, member, programId, {
        requestVersion: 1, action: "whip:create", sourceIds: ["src_aaaaaaaaaaaaaaaa"] });
      const nonce = crypto.randomBytes(24).toString("base64url");
      const signature = crypto.sign("sha256", Buffer.from(broadcastGrantDeviceProofMessage(challenge.proofContext, now, nonce)),
        { key: device.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
      return runtime.authorizePublisher(owner, programId, { requestVersion: 1, challengeId: challenge.challengeId,
        deviceProof: { publicKey, timestamp: now, nonce, signature } });
    };
    const native = () => runtime.prepareNativeSourceProgram(owner, member, b, { requestVersion: 1, trigger: "user-action",
      inputMode: "trusted-sframe-v1", packagerId: "pkr_aaaaaaaaaaaaaaaa", requestedRenditions: 1, allowHardwareAcceleration: false,
    }, () => { nativeCalls++; return {}; });
    const pending = whip(a); await entered;
    try {
      assert.equal(runtime.allowsNewProgram(previewScope(owner)), false, "pending publisher occupies the preview slot");
      assert.throws(native, error => error.status === 429);
      await assert.rejects(whip(b), error => error.code === "broadcast_temporarily_unavailable" && error.status === 429);
      assert.equal(calls, 1); assert.equal(nativeCalls, 0);
      if (outcome === "commit") {
        release(); const accepted = await pending;
        assert.equal(typeof accepted.accessToken, "string");
        assert.throws(native, error => error.status === 429);
        runtime.stopProgram(owner, a);
      } else {
        const rejection = assert.rejects(pending, outcome === "issuer-failure" ? /synthetic_issuer_failure/
          : error => error.code === "broadcast_not_available");
        if (outcome === "stop") runtime.stopProgram(owner, a);
        else if (outcome === "timeout") t.mock.timers.tick(5000);
        else release();
        await rejection;
      }
      assert.equal(runtime.allowsNewProgram(previewScope(owner)), true, "terminal cleanup releases preview capacity");
      assert.doesNotThrow(native);
      assert.equal(nativeCalls, 1);
      assert.equal(runtime.programStateCounts().preparing, 1);
    } finally { release(); await pending.catch(() => {}); }
  });
}
