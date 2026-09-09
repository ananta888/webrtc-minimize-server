import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import Ajv from "ajv/dist/2020.js";
import { SignJWT, createLocalJWKSet, exportJWK } from "jose";
import { chromium } from "playwright";
import { machineFixtureAssets } from "./helpers/machine-fixture-assets.mjs";
import { BroadcastSourceRequests } from "../src/broadcast-source-requests.js";
import { BroadcastRuntimeRegistry } from "../src/broadcast-runtime-registry.js";
import { RoomRegistry } from "../src/room-registry.js";
import { createAppServer } from "../src/server.js";
import { createOidcVerifier } from "../src/oidc-verifier.js";

const ajv = new Ajv({ strict: true });
const requestSchema = ajv.compile(JSON.parse(await fs.readFile(new URL("../contracts/broadcast-source-requests/request.v1.schema.json", import.meta.url))));
const responseSchema = ajv.compile(JSON.parse(await fs.readFile(new URL("../contracts/broadcast-source-requests/response.v1.schema.json", import.meta.url))));
const issuer = "https://synthetic-identity.example/realm/test";

function fixture() {
  let now = Date.now(), sequence = 0;
  const identities = { owner: { issuer, subject: "owner", displayName: "Synthetic owner" },
    target: { issuer, subject: "target" }, other: { issuer, subject: "other" } };
  const rooms = new RoomRegistry();
  const peers = Object.fromEntries(Object.entries(identities).map(([role, identity], i) => [role,
    rooms.join("room-alpha", {}, role, now, { authenticated: true, principal: `${issuer}|${identity.subject}`,
      deviceFingerprint: String.fromCharCode(97 + i).repeat(43) }).peer]));
  const runtime = new BroadcastRuntimeRegistry({ clock: () => now, grantAuthority: {
    issue() {}, issueAnonymousPlayback() {}, revokeProgramEpoch() {},
  } });
  const programId = runtime.createProgram(identities.owner, peers.owner, {
    requestVersion: 1, roomId: "room-alpha", title: "Synthetic private program", visibility: "private",
  }, now).control.programId;
  // Admission is a fixed test port; the real runtime still owns state and writer fencing.
  const prepared = runtime.prepareNativePublisher(identities.owner, peers.owner, programId, {
    requestVersion: 1, trigger: "user-action", packagerId: "pkr_aaaaaaaaaaaaaaaa",
    sourceIds: ["src_aaaaaaaaaaaaaaaa"], requestedRenditions: 1, allowHardwareAcceleration: false,
  }, request => request, now);
  runtime.markNativeOutputReady(prepared.admission.resourceRef, "pkr_aaaaaaaaaaaaaaaa", prepared.lease.fencingRevision, now);
  const requests = new BroadcastSourceRequests({ members: room => rooms.members(room),
    program: (...args) => runtime.nativeSourceRequestContext(...args), clock: () => now,
    idFactory: () => `bsr_${String(++sequence).padStart(24, "0")}` });
  const context = runtime.nativeSourceRequestContext(identities.owner, peers.owner, programId, now);
  const input = (role, action, extra = {}) => ({ requestVersion: 1, action, roomId: "room-alpha",
    deviceFingerprint: peers[role].deviceFingerprint, ...(action === "list" ? {} : { trigger: "user-action" }),
    ...(["create", "create-own"].includes(action) ? { programId, expectedProgramRevision: context.programRevision,
      expectedProgramEpoch: context.programEpoch, ...(action === "create" ? { targetPeerId: peers.target.id } : {}), sourceKind: "camera" } : {}), ...extra });
  const execute = (role, action, extra) => {
    const value = input(role, action, extra);
    assert.equal(requestSchema(value), true, JSON.stringify(requestSchema.errors));
    const result = requests.execute(identities[role], value);
    assert.equal(responseSchema(result), true, JSON.stringify(responseSchema.errors));
    return result.requests;
  };
  return { rooms, peers, identities, runtime, programId, context, input, execute, requests, now: () => now,
    advance: ms => { now += ms; } };
}

test("real program invitations are scoped metadata and support decline/cancel without changing its writer", () => {
  const f = fixture(), before = f.runtime.nativeControl(f.identities.owner, f.peers.owner, f.programId);
  const [created] = f.execute("owner", "create");
  assert.equal(created.authority, "none"); assert.equal(created.state, "pending");
  assert.deepEqual(f.execute("target", "list"), [created]);
  assert.deepEqual(f.execute("other", "list"), []);
  assert.throws(() => f.execute("other", "decline", { requestId: created.requestId }), /unavailable/);
  assert.throws(() => f.execute("owner", "decline", { requestId: created.requestId }), /unavailable/);
  assert.throws(() => f.execute("target", "cancel", { requestId: created.requestId }), /unavailable/);
  assert.equal(f.execute("target", "decline", { requestId: created.requestId })[0].state, "declined");
  assert.equal(f.execute("target", "decline", { requestId: created.requestId })[0].state, "declined");
  const [next] = f.execute("owner", "create", { sourceKind: "screen" });
  assert.equal(f.execute("owner", "cancel", { requestId: next.requestId })[0].state, "cancelled");
  assert.deepEqual(f.runtime.nativeControl(f.identities.owner, f.peers.owner, f.programId), before);
  assert.equal(JSON.stringify(created).includes("fingerprint"), false);
  assert.equal(JSON.stringify(created).includes(issuer), false);
});

test("closed command contract rejects injected consent, scopes, missing fields and unsupported approve", () => {
  const f = fixture();
  const missing = f.input("owner", "create"); delete missing.trigger;
  for (const input of [missing, { ...f.input("owner", "create"), consent: true },
    f.input("owner", "create", { expectedProgramEpoch: "1" }),
    f.input("target", "decline", { requestId: "bsr_" + "a".repeat(24), sourceKind: "camera" }),
    { ...f.input("target", "list"), action: "approve" }]) {
    assert.equal(requestSchema(input), false);
    assert.throws(() => f.requests.execute(f.identities.owner, input), /invalid_broadcast_source_request/);
  }
});

test("own source requests derive their publisher solely from the authenticated controller", () => {
  const f = fixture(), before = f.runtime.nativeControl(f.identities.owner, f.peers.owner, f.programId);
  for (const sourceKind of ["camera", "microphone", "screen", "screen-audio"]) {
    const [item] = f.execute("owner", "create-own", { sourceKind });
    assert.equal(item.ownerPeerId, f.peers.owner.id); assert.equal(item.targetPeerId, f.peers.owner.id);
    assert.equal(item.authority, "none");
    const resolved = f.requests.resolveForPublisher(f.identities.owner, "room-alpha", f.peers.owner.deviceFingerprint, item.requestId);
    assert.equal(resolved.publisher.id, f.peers.owner.id);
    assert.throws(() => f.requests.resolveForPublisher(f.identities.target, "room-alpha", f.peers.target.deviceFingerprint, item.requestId), /unavailable/);
    assert.throws(() => f.execute("owner", "create-own", { sourceKind }), /pending/);
  }
  assert.deepEqual(f.execute("target", "list"), []);
  assert.deepEqual(f.runtime.nativeControl(f.identities.owner, f.peers.owner, f.programId), before);
  assert.throws(() => f.execute("target", "create-own"), /broadcast_not_available/);
  for (const extra of [{ targetPeerId: f.peers.target.id }, { consent: true }, { ownerPeerId: f.peers.owner.id }]) {
    const input = f.input("owner", "create-own", extra);
    assert.equal(requestSchema(input), false);
    assert.throws(() => f.requests.execute(f.identities.owner, input), /invalid_broadcast_source_request/);
  }
  assert.throws(() => f.execute("owner", "create-own", { deviceFingerprint: f.peers.target.deviceFingerprint }), /membership_required/);
  assert.throws(() => f.execute("owner", "create-own", { expectedProgramEpoch: 99 }), /stale/);
  const item = f.execute("owner", "list")[0];
  assert.equal(f.execute("owner", "cancel", { requestId: item.requestId })[0].state, "cancelled");
  assert.throws(() => f.requests.resolveForPublisher(f.identities.owner, "room-alpha", f.peers.owner.deviceFingerprint, item.requestId), /unavailable/);
});

test("current membership, exact device, creator ownership, target identity and program CAS are mandatory", () => {
  const f = fixture();
  assert.throws(() => f.execute("target", "create"), /broadcast_not_available/);
  assert.throws(() => f.execute("owner", "create", { deviceFingerprint: "z".repeat(43) }), /membership_required/);
  assert.throws(() => f.execute("owner", "create", { roomId: "room-other" }), /membership_required/);
  assert.throws(() => f.execute("owner", "create", { targetPeerId: f.peers.owner.id }), /target_unavailable/);
  assert.throws(() => f.execute("owner", "create", { expectedProgramRevision: f.context.programRevision + 1 }), /stale/);
  f.peers.target.machine = true;
  assert.throws(() => f.execute("owner", "create"), /target_unavailable/);
  f.peers.target.machine = false; f.peers.target.authenticated = false;
  assert.throws(() => f.execute("owner", "create"), /target_unavailable/);
});

test("leave/rejoin, source owner loss, program stop, clock rollback and expired writer invalidate invitations", () => {
  for (const change of [
    f => { f.rooms.leave(f.peers.target); f.rooms.join("room-alpha", {}, "new", f.now(), {
      authenticated: true, principal: f.peers.target.principal, deviceFingerprint: f.peers.target.deviceFingerprint }); },
    f => { f.peers.owner.deviceFingerprint = "z".repeat(43); },
    f => { f.runtime.stopProgram(f.identities.owner, f.programId); },
    f => { f.advance(-1000); }, f => { f.advance(61_000); },
  ]) {
    const f = fixture(); f.execute("owner", "create"); change(f);
    const reader = f.peers.owner.deviceFingerprint === "z".repeat(43) ? "target" : "owner";
    assert.equal(f.execute(reader, "list")[0].state, "invalidated");
  }
  const f = fixture(); f.execute("owner", "create"); f.advance(120_000);
  assert.deepEqual(f.execute("target", "list"), []);
});

test("decline and cancellation cannot replenish per-principal invitation quotas", () => {
  const f = fixture();
  const [first] = f.execute("owner", "create");
  assert.throws(() => f.execute("owner", "create"), /pending/);
  f.execute("owner", "cancel", { requestId: first.requestId });
  for (let i = 1; i < 20; i++) {
    const [item] = f.execute("owner", "create"); f.execute("owner", "cancel", { requestId: item.requestId });
  }
  assert.throws(() => f.execute("owner", "create"), /quota/);
  assert.equal(f.execute("target", "list").length, 20);
});

test("read-only polling is bounded before global invitation validation", () => {
  const f = fixture();
  for (let i = 0; i < 60; i++) f.execute("target", "list");
  assert.throws(() => f.execute("target", "list"), /rate/);
  f.advance(60_000); assert.deepEqual(f.execute("target", "list"), []);
});

test("new membership cannot recover a departed device's invitations and server teardown stays terminal", () => {
  const f = fixture(); f.execute("owner", "create");
  f.rooms.leave(f.peers.target);
  f.peers.target = f.rooms.join("room-alpha", {}, "new", f.now(), { authenticated: true,
    principal: `${issuer}|target`, deviceFingerprint: "b".repeat(43) }).peer;
  assert.deepEqual(f.execute("target", "list"), []);
  assert.equal(f.execute("owner", "list")[0].state, "invalidated");
  f.advance(120_000); f.requests.prune();
  assert.deepEqual(f.execute("owner", "list"), []);
  f.requests.destroy(); f.requests.prune();
  assert.throws(() => f.execute("owner", "list"), /closed/);
});

test("a prepared writer handoff invalidates pending invitations before any new writer activates", () => {
  const f = fixture(); f.execute("owner", "create");
  const before = f.runtime.nativeControl(f.identities.owner, f.peers.owner, f.programId);
  f.runtime.beginNativeHandoff(f.identities.owner, f.peers.owner, f.programId, {
    requestVersion: 1, trigger: "user-action", packagerId: "pkr_bbbbbbbbbbbbbbbb",
    expectedProgramRevision: before.programRevision, expectedProgramEpoch: before.programEpoch,
    expectedFencingRevision: before.writer.fencingRevision, requestedRenditions: 1, allowHardwareAcceleration: false,
  }, (_id, request) => request, f.now());
  assert.equal(f.execute("target", "list")[0].state, "invalidated");
  assert.throws(() => f.execute("owner", "create"), /program_unavailable/);
});

test("HTTP invitation route uses actual signed OIDC, Origin/body validation and current room membership", async t => {
  const f = fixture(), keys = generateKeyPairSync("ed25519");
  const config = { authMode: "required", oidcIssuer: issuer, oidcAudience: "human", oidcAlgorithms: ["EdDSA"],
    publicOrigin: "https://fixture.example", nativePackagerSelfServiceEnabled: true };
  const oidcVerifier = createOidcVerifier(config, { jwks: createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] }) });
  const app = createAppServer({ config, oidcVerifier, registry: f.rooms, broadcastRuntime: f.runtime,
    nativePackagerEnrollmentStore: { definitions: () => [] }, nativePackagerInstallerService: {} });
  t.after(async () => {
    await new Promise(resolve => app.webSocketServer.close(resolve));
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
  });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const token = subject => new SignJWT({}).setIssuer(issuer).setAudience("human").setSubject(subject)
    .setIssuedAt().setExpirationTime("2m").setProtectedHeader({ alg: "EdDSA" }).sign(keys.privateKey);
  const url = `http://127.0.0.1:${app.server.address().port}/api/broadcast-source-requests`;
  const headers = { origin: config.publicOrigin, "content-type": "application/json", authorization: `Bearer ${await token("owner")}` };
  const post = (body, overrides = {}, suffix = "") => fetch(url + suffix, { method: "POST", headers: { ...headers, ...overrides }, body: JSON.stringify(body) });
  assert.equal((await post(f.input("owner", "create"), { authorization: "" })).status, 401);
  assert.equal((await post(f.input("owner", "create"), { authorization: "Bearer invalid" })).status, 401);
  assert.equal((await post(f.input("owner", "create"), { origin: "https://foreign.example" })).status, 404);
  assert.equal((await post(f.input("owner", "create"), {}, "?token=forbidden")).status, 404);
  assert.equal((await post({ ...f.input("owner", "create"), consent: true })).status, 400);
  assert.equal((await post({ ...f.input("owner", "create"), junk: "x".repeat(140_000) })).status, 400);
  const created = await post(f.input("owner", "create")); assert.equal(created.status, 201);
  assert.match(created.headers.get("cache-control"), /no-store/);
  const response = await created.json(); assert.equal(responseSchema(response), true);
  const requestId = response.requests[0].requestId;
  const ownResponse = await post(f.input("owner", "create-own", { sourceKind: "screen" }));
  assert.equal(ownResponse.status, 201); const ownItem = (await ownResponse.json()).requests[0];
  assert.equal(ownItem.targetPeerId, f.peers.owner.id); assert.equal(ownItem.authority, "none");
  assert.equal((await post(f.input("owner", "create-own", { targetPeerId: f.peers.target.id }))).status, 400);
  const targetHeaders = { authorization: `Bearer ${await token("target")}` };
  const inbox = await post(f.input("target", "list"), targetHeaders);
  assert.equal((await inbox.json()).requests[0].requestId, requestId);
  const declined = await post(f.input("target", "decline", { requestId }), targetHeaders);
  assert.equal(declined.status, 200); assert.equal((await declined.json()).requests[0].state, "declined");
  f.rooms.leave(f.peers.target);
  assert.equal((await post(f.input("target", "list"), targetHeaders)).status, 403);
});

test("real Angular keyboard inbox loads and declines an actual scoped invitation without capture", { timeout: 60000 }, async t => {
  try { await fs.access(chromium.executablePath()); } catch { t.skip("Playwright Chromium required for invitation keyboard gate"); return; }
  const f = fixture(), keys = generateKeyPairSync("ed25519");
  const config = { authMode: "required", oidcIssuer: issuer, oidcAudience: "human", oidcAlgorithms: ["EdDSA"],
    publicOrigin: "", nativePackagerSelfServiceEnabled: true, broadcastNativeOutputEnabled: true,
    stunUrls: [], turnServers: [] };
  const oidcVerifier = createOidcVerifier(config, { jwks: createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] }) });
  const app = createAppServer({ config, oidcVerifier, registry: f.rooms, broadcastRuntime: f.runtime,
    publicDir: await machineFixtureAssets(process.env.MEET_TEST_PUBLIC_DIR),
    nativePackagerEnrollmentStore: { definitions: () => [], list: () => [] }, nativePackagerInstallerService: { availableTargets: () => [] } });
  let browser;
  t.after(async () => {
    await browser?.close();
    for (const socket of app.webSocketServer.clients) socket.terminate();
    await new Promise(resolve => app.webSocketServer.close(resolve));
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
  });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const token = subject => new SignJWT({}).setIssuer(issuer).setAudience("human").setSubject(subject)
    .setIssuedAt().setExpirationTime("2m").setProtectedHeader({ alg: "EdDSA" }).sign(keys.privateKey);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ permissions: [] });
  await context.addInitScript(token => {
    sessionStorage.setItem("webrtc.oidc.access-token", token);
    window.__sourceRequestCaptureCalls = 0;
    for (const method of ["getUserMedia", "getDisplayMedia"]) navigator.mediaDevices[method] = () => {
      window.__sourceRequestCaptureCalls++; throw new Error("capture_forbidden");
    };
  }, await token("target"));
  const page = await context.newPage(); let invitationCalls = 0;
  const admissionResponses = [];
  page.on("response", response => { if (new URL(response.url()).pathname === "/api/sessions") admissionResponses.push(response.status()); });
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/broadcast-source-requests") invitationCalls++; });
  await page.goto(origin + "/?room=room-alpha");
  await page.locator("#display-name").fill("Synthetic invitation receiver");
  await page.locator("#join-room:not([disabled])").waitFor(); await page.locator("#join-room").press("Enter");
  await page.locator("#participant-count", { hasText: "4 / 20" }).waitFor({ timeout: 10000 }).catch(async error => {
    t.diagnostic(JSON.stringify({ admissionResponses, members: f.rooms.members("room-alpha").length,
      ui: await page.evaluate(() => ({ connection: document.querySelector("#connection-status")?.textContent,
        count: document.querySelector("#participant-count")?.textContent,
        runtime: document.querySelector("#runtime-config-status")?.getAttribute("data-state") })) }));
    throw error;
  });
  const receiver = f.rooms.members("room-alpha").find(peer => peer.principal === `${issuer}|target` && peer.id !== f.peers.target.id);
  assert.ok(receiver, "a new P-256-bound browser membership was admitted");
  const created = await fetch(origin + "/api/broadcast-source-requests", { method: "POST", headers: {
    origin, "content-type": "application/json", authorization: `Bearer ${await token("owner")}`,
  }, body: JSON.stringify(f.input("owner", "create", { targetPeerId: receiver.id })) });
  assert.equal(created.status, 201); const requestId = (await created.json()).requests[0].requestId;
  await page.locator("#broadcast-navigation").press("Enter");
  await page.locator("#broadcast-source-requests-open").press("Enter");
  await page.locator("#broadcast-source-requests-load:not([disabled])").waitFor();
  assert.equal(invitationCalls, 0, "panel opening does not fetch invitation metadata");
  await page.locator("#broadcast-source-requests-load").press("Enter");
  const item = page.locator(`[data-source-request-id="${requestId}"]`);
  await item.getByText("Offen · keine Freigabe", { exact: false }).waitFor();
  await item.getByRole("button", { name: "Eigene Quelle prüfen", exact: true }).press("Enter");
  await page.locator("#broadcast-source-approval").getByText("Keine passende laufende Quelle vorhanden.", { exact: false }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Entschlüsselung und Broadcast ausdrücklich erlauben…", exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.__sourceRequestCaptureCalls), 0, "server publication query never starts capture");
  await page.getByRole("button", { name: "Auswahl schließen", exact: true }).press("Enter");
  await item.getByRole("button", { name: "Ablehnen", exact: true }).press("Enter");
  await item.getByText("Abgelehnt", { exact: false }).waitFor();
  assert.equal(invitationCalls, 2);
  assert.equal(await page.evaluate(() => window.__sourceRequestCaptureCalls), 0);
  assert.equal(await page.getByRole("button", { name: /^Annehmen/ }).count(), 0);
  const state = await fetch(origin + "/api/broadcast-source-requests", { method: "POST", headers: {
    origin, "content-type": "application/json", authorization: `Bearer ${await token("owner")}`,
  }, body: JSON.stringify(f.input("owner", "list")) });
  assert.equal((await state.json()).requests[0].state, "declined");
});
