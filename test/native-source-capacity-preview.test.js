import assert from "node:assert/strict";
import test from "node:test";
import { previewNativeSourceCapacity } from "../src/native-source-capacity-preview.js";
import { NativePackagerAssignmentRegistry } from "../src/native-packager-assignment.js";
import { broadcastSubjectRef, broadcastTenantRef } from "../src/broadcast-identifiers.js";
import { createAppServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { AuthenticationError } from "../src/oidc-verifier.js";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
const validateResponse = new Ajv2020({ strict: true }).compile(JSON.parse(readFileSync(
  new URL("../contracts/native-packager/capacity-preview.v1.schema.json", import.meta.url), "utf8")));

function fixture(limits = {}, scopedResourceLimits) {
  const now = Date.now(), identity = { issuer: "https://id.example/realms/test", subject: "owner", expiresAt: now + 60000 };
  const principal = `${identity.issuer}|${identity.subject}`, packagerId = "pkr_aaaaaaaaaaaaaaaa";
  const member = { id: "0123456789abcdef", principal, authenticated: true, creator: true,
    roomId: "room-alpha", deviceFingerprint: "a".repeat(43) };
  const input = { requestVersion: 1, trigger: "user-action", roomId: member.roomId,
    deviceFingerprint: member.deviceFingerprint, packagerId, requestedRenditions: 3, allowHardwareAcceleration: false };
  const capability = { capabilityVersion: 5, sourcePrograms: true, sourceAudioControlVersion: 3, sourceAudioEncodingVersion: 1,
    agentId: packagerId, tenantId: broadcastTenantRef(identity.issuer), ownerSubjectRef: broadcastSubjectRef(identity),
    deviceRef: "dev_aaaaaaaaaaaaaaaa", agentVersion: "1.0.0", ffmpegVersion: "6.1.1", videoEncoders: ["libx264", "h264_nvenc"],
    audioEncoders: ["aac"], hardwareClass: "large", cpuClass: "high", gpuClass: "dedicated", uploadClass: "over-15mbit",
    energyClass: "ac", health: "healthy", maximumRenditions: 3, maximumPixelsPerSecond: 1280 * 720 * 30,
    consentedRoomIds: [member.roomId], observedAt: now, expiresAt: now + 30000 };
  let available = true;
  const candidate = { id: packagerId, online: true, capability, generation: Object.freeze({}) };
  const controlRegistry = { candidate(owner, id) {
    if (owner !== principal || id !== packagerId) throw new AuthenticationError("not_owned");
    return candidate;
  }, sourceContext(owner, id) { return this.candidate(owner, id); } };
  const assignments = new NativePackagerAssignmentRegistry({ controlRegistry, resourceLimits: limits, scopedResourceLimits,
    sourceProgramMembership: (owner, room, id) => available && owner === principal && room === member.roomId && id === member.id ? 1 : 0,
    idFactory() { throw new Error("preview_must_not_allocate"); },
    iceServersForPackager() { throw new Error("preview_must_not_issue_credentials"); } });
  const preview = (changes = {}) => previewNativeSourceCapacity(identity, member, { ...input, ...changes }, assignments, now);
  return { now, identity, member, input, capability, candidate, assignments, preview, revoke() { available = false; } };
}

test("preview uses real cumulative ladder admission and budgets without allocating or leaking authority", () => {
  const f = fixture(), before = f.assignments.resourceCounts(f.now);
  for (let i = 0; i < 20; i++) {
    const result = f.preview();
    assert.equal(validateResponse(result), true, JSON.stringify(validateResponse.errors));
    assert.equal(result.schema, "ananta.native-capacity-preview.v1");
    assert.equal(result.reserved, false); assert.equal(result.reduced, true);
    assert.equal(result.costStatus, "unknown"); assert.equal(result.expiresAt, f.now + 5000);
    assert.deepEqual(result.renditions.map(r => r.id), ["low", "medium"]);
    assert.deepEqual(result.demand, { cpuUnits: 16, memoryMiB: 320, encoderSlots: 2, gpuSlots: 0, egressBitsPerSecond: 2024000 });
    assert.doesNotMatch(JSON.stringify(result), /prg_|res_|lea_|asn_|tn_|sub_|dev_|pkr_|token|credential|room-alpha/);
  }
  assert.deepEqual(f.assignments.resourceCounts(f.now), before);
  assert.equal(f.assignments.activeForPackager(f.input.packagerId), null);
});

test("explicit output strategies and hardware use actual server selection", () => {
  const f = fixture();
  const result = f.preview({ requestVersion: 3, audioOutput: { codec: "aac", sampleRate: 48000, channels: 1, targetBitsPerSecond: 48000 },
    videoOutput: { profile: "economy-v1" }, allowHardwareAcceleration: true });
  assert.equal(result.renditions.length, 3); assert.equal(result.reduced, false);
  assert.equal(result.videoEncoder, "h264_nvenc"); assert.equal(result.demand.gpuSlots, 3);
  assert.equal(result.renditions[0].width, 426); assert.equal(result.renditions[2].audioBitsPerSecond, 48000);
  assert.equal(f.preview({ requestVersion: 3, audioOutput: null, videoOutput: { profile: "screen-v1" } }).renditions.length, 3);
});

for (const scope of ["deployment", "tenant", "principal"]) test(`preview enforces current ${scope} budgets`, () => {
  const f = scope === "deployment" ? fixture({ encoderSlots: 0 }) : fixture({}, { [scope]: { encoderSlots: 0 } });
  assert.throws(() => f.preview(), error => error.code === "broadcast_temporarily_unavailable" && error.status === 429);
});

test("membership, ownership, expiration, consent and capability are not inferred from a preview request", () => {
  for (const change of ["creator", "fingerprint", "principal", "room", "machine", "anonymous", "expired", "consent", "offline", "scope", "source"]) {
    const f = fixture();
    if (change === "creator") f.member.creator = false;
    if (change === "fingerprint") f.member.deviceFingerprint = "b".repeat(43);
    if (change === "principal") f.member.principal += "other";
    if (change === "room") f.member.roomId = "room-other";
    if (change === "machine") f.member.machine = true;
    if (change === "anonymous") f.member.authenticated = false;
    if (change === "expired") f.identity.expiresAt = f.now;
    if (change === "consent") f.capability.consentedRoomIds = [];
    if (change === "offline") f.candidate.online = false;
    if (change === "scope") f.capability.tenantId = "tn_bbbbbbbbbbbbbbbb";
    if (change === "source") f.revoke();
    assert.throws(() => f.preview(), undefined, change);
  }
});

test("closed versions reject unknown authority fields and unsupported output choices", () => {
  const f = fixture();
  for (const changes of [{ tenantId: f.capability.tenantId }, { programId: "prg_aaaaaaaaaaaaaaaa" }, { requestVersion: 4 },
    { requestedRenditions: 0 }, { requestedRenditions: 4 }, { trigger: "remote" }, { deviceFingerprint: null },
    { audioOutput: null }, { requestVersion: 2, audioOutput: null },
    { requestVersion: 3, audioOutput: null, videoOutput: { profile: "unknown" } }]) assert.throws(() => f.preview(changes));
  f.identity.expiresAt = f.now + 10; assert.equal(f.preview().expiresAt, f.now + 10);
});

test("HTTP preview is authenticated, origin-checked, bounded, rate-limited and does not create programs", { timeout: 8000 }, async t => {
  const f = fixture();
  // Real HTTP and admission registries; synthetic verified-identity/membership fixtures (not a JWKS or browser gate).
  const config = { ...loadConfig({ AUTH_MODE: "required", PAIR_WORKSPACE_ENABLED: "false", KEYCLOAK_ORIGIN: "https://id.example",
    KEYCLOAK_REALM: "test", OIDC_CLIENT_ID: "human", OIDC_AUDIENCE: "human", PUBLIC_ORIGIN: "https://meet.example" }),
    nativePackagerSelfServiceEnabled: true };
  const app = createAppServer({ config, nativePackagerAssignments: f.assignments,
    nativePackagerInstallerService: {}, nativePackagerEnrollmentStore: { definitions: () => [] },
    oidcVerifier: { verify: async token => { if (token !== "synthetic-owner") throw new AuthenticationError("invalid_token"); return f.identity; } },
    broadcastGrantAuthority: { issue() { throw new Error("must_not_issue_grant"); }, issueAnonymousPlayback() {}, revokeProgramEpoch() {} } });
  const peer = app.registry.join(f.member.roomId, {}, "Synthetic", f.now, { principal: f.member.principal,
    deviceFingerprint: f.member.deviceFingerprint, authenticated: true }).peer;
  f.member.id = peer.id;
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { app.registry.leave(peer); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  const url = `http://127.0.0.1:${app.server.address().port}/api/broadcasts/native-capacity-preview`;
  const headers = { authorization: "Bearer synthetic-owner", origin: config.publicOrigin, "content-type": "application/json" };
  const post = (body = f.input, options = {}) => fetch(url, { method: "POST", headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000), ...options });
  assert.equal((await post(f.input, { headers: { ...headers, authorization: "" } })).status, 401);
  assert.equal((await post(f.input, { headers: { ...headers, authorization: "Bearer rejected" } })).status, 401);
  assert.equal((await post(f.input, { headers: { ...headers, origin: "https://foreign.example" } })).status, 404);
  assert.equal((await post(f.input, { headers: { ...headers, "content-type": "text/plain" } })).status, 404);
  assert.equal((await fetch(url, { headers, signal: AbortSignal.timeout(4000) })).status, 404);
  assert.equal((await fetch(`${url}?unexpected=1`, { method: "POST", headers, body: JSON.stringify(f.input), signal: AbortSignal.timeout(4000) })).status, 404);
  assert.equal((await post({ ...f.input, programId: "prg_aaaaaaaaaaaaaaaa" })).status, 400);
  assert.equal((await post({ ...f.input, deviceFingerprint: "b".repeat(43) })).status, 403);
  assert.equal((await post({ ...f.input, extra: "x".repeat(17000) })).status, 400);
  const result = await post(); assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store"); assert.equal((await result.json()).reserved, false);
  for (let i = 0; i < 8; i++) assert.equal((await post()).status, 200);
  const limited = await post(); assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, "broadcast_temporarily_unavailable");
  assert.equal(app.broadcastRuntime.programCount, 0);
  assert.equal(f.assignments.activeForPackager(f.input.packagerId), null);
});
