import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { loadConfig } from "../src/config.js";
import { BroadcastPlaybackCapacity, BROADCAST_PLAYBACK_CAPACITY_DEFAULTS, BROADCAST_PLAYBACK_CAPACITY_ENV,
  normalizeBroadcastPlaybackCapacity, playbackCapacityScope } from "../src/broadcast-playback-capacity.js";
import { BroadcastPlaybackSessionStore } from "../src/broadcast-playback-session-store.js";
import { createAppServer } from "../src/server.js";

const NOW = 1800000000000, origin = "https://playback.example.test";
const scope = { tenantId: "tn_aaaaaaaaaaaaaaaa", programId: "prg_aaaaaaaaaaaaaaaa", audienceRef: "sub_aaaaaaaaaaaaaaaa" };
const resourceRef = "res_aaaaaaaaaaaaaaaa";
const grant = changes => ({ ...scope, grantKind: "playback", resourceRef, expiresAt: NOW + 60000, ...changes });

function fixture(capacityLimits = {}, entries = [grant({})]) {
  let allocations = 0;
  const authority = { async authorizeGatewayBearer(token, expectation) {
    const entry = entries[Number(token.replace("Bearer ", ""))];
    if (!entry || expectation.path !== `/broadcast/play/${entry.resourceRef}`) throw new Error("denied");
    return entry;
  } };
  const store = new BroadcastPlaybackSessionStore({ authority, publicOrigin: origin, capacityLimits,
    idFactory: () => `pbs_${String(++allocations).padStart(24, "a")}` });
  return { store, authority, allocations: () => allocations,
    create: (index = 0, now = NOW) => store.create({ authorizationHeader: `Bearer ${index}`,
      resourceRef: entries[index]?.resourceRef || resourceRef, origin, now }) };
}

test("program observation uses actual create/close/expire occupancy without allocating or exposing foreign scopes", async () => {
  const entries = [grant({}), grant({ programId: "prg_bbbbbbbbbbbbbbbb" }), grant({ tenantId: "tn_bbbbbbbbbbbbbbbb" })];
  const f = fixture({ deployment: 4, tenant: 3, program: 2 }, entries);
  const inspect = (n = 1, now = NOW) => f.store.inspectProgramCapacity({ tenantId: scope.tenantId, programId: scope.programId,
    additionalSessions: n, now });
  assert.deepEqual(inspect(), { programSessions: 0, programLimit: 2, perAudienceLimit: 4, additionalSessions: 1, sharedBudgetsFit: true });
  const first = await f.create(); await f.create(1); await f.create(2);
  assert.equal(inspect().programSessions, 1); assert.equal(inspect().sharedBudgetsFit, true);
  assert.equal(inspect(2).sharedBudgetsFit, false);
  assert.equal(f.allocations(), 3); assert.equal(f.store.size, 3);
  f.store.close({ sessionId: first.playbackSessionId, cookieHeader: first.setCookie[0].split(";", 1)[0], origin, now: NOW });
  assert.equal(inspect(2).sharedBudgetsFit, true); assert.equal(inspect().programSessions, 0);
  // Invalid inspection cannot expire real records as a side effect.
  assert.throws(() => inspect(0, NOW + 60000)); assert.equal(f.store.size, 2);
  assert.equal(inspect(2, NOW + 60000).sharedBudgetsFit, true); assert.equal(f.store.size, 0);
});

test("shared observation enforces all three shared boundaries without promising per-identity admission", () => {
  const candidate = { tenantId: scope.tenantId, programId: scope.programId };
  const occupied = [scope, { ...scope, programId: "prg_bbbbbbbbbbbbbbbb" }, { ...scope, tenantId: "tn_bbbbbbbbbbbbbbbb" }];
  for (const [field, boundary] of [["deployment", 4], ["tenant", 3], ["program", 2]]) {
    const policy = new BroadcastPlaybackCapacity({ [field]: boundary });
    assert.equal(policy.inspectProgram(candidate, occupied, 1).sharedBudgetsFit, true);
    assert.equal(policy.inspectProgram(candidate, occupied, 2).sharedBudgetsFit, false);
  }
  const noAudience = new BroadcastPlaybackCapacity({ audience: 0 });
  assert.equal(noAudience.inspectProgram(candidate, [], 1).sharedBudgetsFit, true);
  assert.equal(noAudience.inspectProgram(candidate, [], 1).perAudienceLimit, 0);
  assert.equal(noAudience.allows(scope, []), false);
  for (const n of [0, -1, 1.5, NaN, Infinity, 10001]) assert.throws(() => noAudience.inspectProgram(candidate, [], n));
  for (const c of [null, [], { ...candidate, audienceRef: scope.audienceRef }, { ...candidate, tenantId: "invalid" }]) {
    assert.throws(() => noAudience.inspectProgram(c, [], 1));
  }
  for (const records of [null, [null], Array(10001).fill(scope)]) assert.throws(() => noAudience.inspectProgram(candidate, records, 1));
});

test("playback capacity config is closed, bounded, immutable and carries ENV through Compose", () => {
  assert.deepEqual(loadConfig({}).broadcastPlaybackCapacity, BROADCAST_PLAYBACK_CAPACITY_DEFAULTS);
  const compose = parse(fs.readFileSync(new URL("../compose.yaml", import.meta.url), "utf8"));
  for (const [field, name] of Object.entries(BROADCAST_PLAYBACK_CAPACITY_ENV)) {
    assert.equal(compose.services.webrtc.environment[name], "${" + name + "-" + BROADCAST_PLAYBACK_CAPACITY_DEFAULTS[field] + "}");
    for (const limit of [0, 1, 10000]) {
      assert.equal(loadConfig({ [name]: String(limit) }).broadcastPlaybackCapacity[field], limit);
    }
    for (const value of ["", "-1", "1.5", "Infinity", "10001", "2bad"]) assert.throws(() => loadConfig({ [name]: value }), new RegExp(name));
  }
  assert.ok(Object.isFrozen(normalizeBroadcastPlaybackCapacity()));
  for (const value of [null, [], { extra: 1 }, { tenant: -1 }, { program: 0.5 }, { audience: undefined }, { deployment: 10001 }]) {
    assert.throws(() => normalizeBroadcastPlaybackCapacity(value), /invalid_broadcast_playback_capacity/);
    assert.throws(() => fixture(value), /invalid_broadcast_playback_session_configuration/);
  }
});

test("scope projection follows grant contracts without retaining identity or metadata", () => {
  assert.deepEqual(playbackCapacityScope({ ...scope, token: "private" }), scope);
  assert.ok(Object.isFrozen(playbackCapacityScope(scope)));
  assert.equal(new BroadcastPlaybackCapacity().allows({ ...scope, audienceRef: "pkr_aaaaaaaaaaaaaaaa" }, []), true);
  for (const field of Object.keys(scope)) for (const value of [undefined, null, 1, "private", "x".repeat(1000)]) {
    const malformed = { ...scope, [field]: value };
    assert.throws(() => playbackCapacityScope(malformed), /invalid_broadcast_playback_scope/);
    assert.equal(new BroadcastPlaybackCapacity().allows(malformed, []), false);
    assert.equal(new BroadcastPlaybackCapacity().allows(scope, [malformed]), false);
  }
  assert.equal(new BroadcastPlaybackCapacity().allows(scope, null), false);
});

for (const field of Object.keys(BROADCAST_PLAYBACK_CAPACITY_DEFAULTS)) {
  test(`zero ${field} budget refuses after authorization and before allocation`, async () => {
    const f = fixture({ [field]: 0 });
    await assert.rejects(f.create(9), /not_found/);
    await assert.rejects(f.create(), error => error.status === 429 && error.code === "broadcast_playback_session_quota_reached");
    assert.equal(f.allocations(), 0); assert.equal(f.store.size, 0);
  });
}

test("program and tenant bounds aggregate scopes, survive renewal, and release on close or expiry", async () => {
  const entries = [grant({}), grant({ audienceRef: "sub_bbbbbbbbbbbbbbbb" }),
    grant({ programId: "prg_bbbbbbbbbbbbbbbb", resourceRef: "res_bbbbbbbbbbbbbbbb", audienceRef: "sub_bbbbbbbbbbbbbbbb" }),
    grant({ tenantId: "tn_bbbbbbbbbbbbbbbb", audienceRef: "sub_cccccccccccccccc" })];
  const f = fixture({ program: 1, tenant: 2 }, entries);
  const first = await f.create();
  await assert.rejects(f.create(1), /quota_reached/);
  await f.create(2); // same tenant, different program
  await f.create(3); // same program identifier, different tenant
  assert.equal(f.store.size, 3);
  const cookieHeader = first.setCookie[0].split(";", 1)[0];
  const renewed = await f.store.renew({ authorizationHeader: "Bearer 0", sessionId: first.playbackSessionId,
    resourceRef, cookieHeader, origin, now: NOW + 1 });
  assert.equal(renewed.playbackSessionId, first.playbackSessionId);
  assert.equal(f.store.size, 3);
  f.store.close({ sessionId: first.playbackSessionId, cookieHeader, origin, now: NOW + 1 });
  await f.create(1, NOW + 1);
  assert.equal(f.store.size, 3);
  entries[0] = grant({ expiresAt: NOW + 120000 });
  await f.create(0, NOW + 60000);
  assert.equal(f.store.size, 1);
});

test("tenant quota rejects a new program while leaving another tenant available", async () => {
  const f = fixture({ tenant: 1 }, [grant({}), grant({ programId: "prg_bbbbbbbbbbbbbbbb" }),
    grant({ tenantId: "tn_bbbbbbbbbbbbbbbb" })]);
  await f.create(); await assert.rejects(f.create(1), /quota_reached/); await f.create(2);
  assert.equal(f.store.size, 2);
});

test("parallel grant checks cannot exceed the synchronously committed session budget", async () => {
  const f = fixture({ program: 2 });
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => f.create()));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 2);
  for (const result of results.filter(result => result.status === "rejected")) assert.equal(result.reason.status, 429);
  assert.equal(f.store.size, 2); assert.equal(f.allocations(), 2);
});

test("new resource and epoch do not evade the same program quota", async () => {
  const f = fixture({ program: 1 }, [grant({ programEpoch: 1 }), grant({
    programEpoch: 2, resourceRef: "res_bbbbbbbbbbbbbbbb", audienceRef: "sub_bbbbbbbbbbbbbbbb",
  })]);
  await f.create(); await assert.rejects(f.create(1), /quota_reached/);
  assert.equal(f.store.size, 1); assert.equal(f.allocations(), 1);
});

test("renewal cannot migrate quota into a different program or tenant", async () => {
  for (const change of [{ programId: "prg_bbbbbbbbbbbbbbbb" }, { tenantId: "tn_bbbbbbbbbbbbbbbb" }]) {
    const f = fixture({ program: 1, tenant: 1 }, [grant({}), grant(change)]);
    const first = await f.create();
    await assert.rejects(f.store.renew({ authorizationHeader: "Bearer 1", sessionId: first.playbackSessionId,
      resourceRef, cookieHeader: first.setCookie[0].split(";", 1)[0], origin, now: NOW }), /not_found/);
    assert.equal(f.store.size, 1); assert.equal(f.allocations(), 1);
    await assert.rejects(f.create(0), /quota_reached/);
  }
});

test("missing verified tenant or program cannot mint a cookie under default budgets", async () => {
  for (const field of ["tenantId", "programId", "audienceRef"]) {
    const f = fixture({}, [grant({ [field]: undefined })]);
    await assert.rejects(f.create(), /not_found/); assert.equal(f.allocations(), 0);
  }
});

for (const [field, name] of Object.entries(BROADCAST_PLAYBACK_CAPACITY_ENV)) {
  test(`real server applies ${name} to HTTP cookie exchange before allocation`, async t => {
    // Controlled authorization port, real session store/proxy/server; no network identity or media claim.
    const authority = { async authorizeGatewayBearer(token, expectation, now) {
      if (token !== "Bearer synthetic" || expectation.path !== `/broadcast/play/${resourceRef}`) throw new Error("denied");
      return grant({ expiresAt: now + 60000 });
    } };
    const config = loadConfig({ PUBLIC_ORIGIN: origin, AUTH_MODE: "disabled", PAIR_WORKSPACE_ENABLED: "false",
      BROADCAST_GATEWAY_ORIGIN: "http://127.0.0.1:9", [name]: "1" });
    assert.equal(config.broadcastPlaybackCapacity[field], 1);
    const app = createAppServer({ config, broadcastGrantAuthority: authority, broadcastRuntime: {} });
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const post = (token = "synthetic") => fetch(base + "/api/broadcast/playback-sessions", { method: "POST",
      headers: { origin, "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ resourceRef }) });
    const one = await post(); assert.equal(one.status, 201);
    const session = await one.json(); assert.ok(one.headers.get("set-cookie"));
    const denied = await post(); assert.equal(denied.status, 429);
    assert.equal(denied.headers.get("set-cookie"), null);
    assert.doesNotMatch(await denied.text(), /tenant|audience|program|1024|500/);
    const unauthorized = await post("invalid"); assert.equal(unauthorized.status, 404); await unauthorized.arrayBuffer();
    const close = await fetch(base + `/api/broadcast/playback-sessions/${session.playbackSessionId}`, { method: "DELETE",
      headers: { origin, cookie: one.headers.getSetCookie()[0].split(";", 1)[0] } });
    assert.equal(close.status, 204);
    const replacement = await post(); assert.equal(replacement.status, 201); await replacement.arrayBuffer();
    const health = await fetch(base + "/healthz"); assert.equal(health.status, 200); await health.arrayBuffer();
  });
}
