import assert from "node:assert/strict";

/** Real HTTP + authenticated P-256 socket/registries, synthetic native scene replies (no encoder claim). */
export async function exerciseNativeSceneHttp({ app, agent, identity, ownerPrincipal, publicOrigin, packagerId,
  programId, fingerprint, nativePackagers, broadcastRuntime }) {
  const member = app.registry.membersForPrincipal(ownerPrincipal).find(p => p.deviceFingerprint === fingerprint);
  const control = broadcastRuntime.nativeControl(identity, member, programId);
  const input = { requestVersion: 1, deviceFingerprint: fingerprint, action: "query",
    expectedProgramRevision: control.programRevision, expectedProgramEpoch: control.programEpoch };
  const headers = { "content-type": "application/json", origin: publicOrigin, authorization: "Bearer owner-token" };
  const url = `${app.httpUrl}/api/broadcasts/${programId}/native-source-scene`;
  const post = (body = input, options = {}) => fetch(url, { method: "POST", headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(6000), ...options });
  assert.equal((await post()).status, 409, "old native version must not receive unknown commands");
  const capability = nativePackagers.candidate(ownerPrincipal, packagerId).capability;
  const report = async agentVersion => {
    agent.socket.send(JSON.stringify({ version: 1, type: "capability", capability: { ...capability, agentVersion } }));
    await agent.next(m => m.type === "capability-accepted");
  };
  await report("0.9.0");
  // Fault injection at the real socket's queue observation, not a claim of network saturation.
  const serverSocket = nativePackagers.socketFor(packagerId);
  for (const amount of [65537, -1, NaN, Infinity]) {
    Object.defineProperty(serverSocket, "bufferedAmount", { value: amount, configurable: true });
    try { assert.equal((await post()).status, 503, "backpressure must not queue another scene command"); }
    finally { delete serverSocket.bufferedAmount; }
  }
  for (const patch of [{ extra: true }, { requestVersion: 3 }, { deviceFingerprint: "bad" }, { action: "anything" }]) {
    assert.equal((await post({ ...input, ...patch })).status, 400);
  }
  assert.equal((await post({ ...input, deviceFingerprint: "z".repeat(43) })).status, 403);
  assert.equal((await post(input, { headers: { ...headers, authorization: "Bearer handoff-foreign-token" } })).status, 403);
  assert.equal((await post(input, { headers: { ...headers, authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await post(input, { headers: { ...headers, origin: "https://foreign.example" } })).status, 404);
  assert.equal((await post({ ...input, expectedProgramRevision: control.programRevision + 1 })).status, 409);

  const respond = (command, type, fields) => agent.socket.send(JSON.stringify({ version: 1, type,
    ...Object.fromEntries(["commandId", "assignmentId", "programId", "programEpoch", "leaseId", "fencingRevision"].map(k => [k, command[k]])),
    ...fields }));
  const state = (command, revision = 1, layout = "waiting-slate") => respond(command, "source-program-scene-state", {
    observedAt: Date.now(), sceneRevision: revision, layout, sourceLeaseIds: [], activeSourceLeaseId: "", availableSources: [] });
  const negotiated = post({ ...input, requestVersion: 2 }), legacyQuery = await agent.next(m => m.type === "source-program-scene-query");
  assert.equal(legacyQuery.version, 1, "v2 discovery retains exact v1 for an older authenticated agent");
  state(legacyQuery);
  const negotiatedResponse = await negotiated;
  assert.equal(negotiatedResponse.status, 200);
  const negotiatedBody = await negotiatedResponse.json();
  assert.equal(negotiatedBody.sceneControlVersion, 1); assert.equal(Object.hasOwn(negotiatedBody, "sourceFits"), false);
  assert.equal((await post({ ...input, requestVersion: 2, action: "apply", trigger: "user-action", expectedSceneRevision: 1,
    layout: "grid", sourceLeaseIds: [], activeSourceLeaseId: "", sourceFits: [] })).status, 409, "explicit v2 apply cannot downgrade");
  const pending = post(), query = await agent.next(m => m.type === "source-program-scene-query");
  assert.equal(query.programId, programId); assert.equal(query.expiresAt - query.issuedAt <= 4000, true);
  assert.equal((await post()).status, 429, "one pending operation per actual packager");
  state(query);
  const response = await pending;
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.equal(response.headers.get("cache-control"), "no-store");
  const observed = await response.json();
  assert.equal(observed.outcome, "observed"); assert.equal(observed.sceneRevision, 1);
  assert.equal(Object.hasOwn(observed, "leaseId"), false); assert.equal(Object.hasOwn(observed, "commandId"), false);

  const selection = { ...input, action: "apply", trigger: "user-action", expectedSceneRevision: 1,
    layout: "grid", sourceLeaseIds: [], activeSourceLeaseId: "" };
  for (const patch of [{ trigger: "remote" }, { leaseId: query.leaseId }]) assert.equal((await post({ ...selection, ...patch })).status, 400);
  const update = post(selection), command = await agent.next(m => m.type === "source-program-scene");
  assert.equal(command.expectedSceneRevision, 1); assert.equal(command.layout, "grid");
  assert.equal(command.leaseId, query.leaseId);
  respond(command, "source-program-scene-applied", { appliedAt: Date.now(), sceneRevision: 2 });
  const appliedResponse = await update; assert.equal(appliedResponse.status, 200);
  assert.equal((await appliedResponse.json()).outcome, "applied");
  const conflict = post(selection), stale = await agent.next(m => m.type === "source-program-scene");
  respond(stale, "source-program-scene-rejected", { observedAt: Date.now(), reasonCode: "SCENE_NOT_APPLIED" });
  assert.equal((await (await conflict).json()).outcome, "rejected");

  const revoked = post(), old = await agent.next(m => m.type === "source-program-scene-query");
  await report("0.8.0");
  assert.equal((await revoked).status, 409, "capability loss retires a pending query without an ACK");
  state(old); // Delayed valid reply is ignored and cannot kill a continuing program.
  await report("0.9.0");
  const final = post(), fresh = await agent.next(m => m.type === "source-program-scene-query");
  state(fresh, 2, "grid");
  const result = await final; assert.equal(result.status, 200);
  assert.equal((await result.json()).sceneRevision, 2);
  assert.equal(app.nativePackagerAssignments.activeForProgram(programId).state, "running");
}
