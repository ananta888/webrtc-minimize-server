import assert from "node:assert/strict";

/** Actual HTTP/authenticated socket and registries; synthetic native replies, not media evidence. */
export async function exerciseNativeAudioHttp({ app, agent, identity, ownerPrincipal, publicOrigin, packagerId, programId, fingerprint, nativePackagers, broadcastRuntime }) {
  const member = app.registry.membersForPrincipal(ownerPrincipal).find(p => p.deviceFingerprint === fingerprint);
  const control = broadcastRuntime.nativeControl(identity, member, programId);
  const input = { requestVersion: 1, deviceFingerprint: fingerprint, action: "query", expectedProgramRevision: control.programRevision, expectedProgramEpoch: control.programEpoch };
  const headers = { "content-type": "application/json", origin: publicOrigin, authorization: "Bearer owner-token" };
  const post = (body = input, options = {}) => fetch(`${app.httpUrl}/api/broadcasts/${programId}/native-source-audio`, {
    method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(6000), ...options });
  assert.equal((await post()).status, 409, "v2 source support does not imply audio control");
  const previous = nativePackagers.candidate(ownerPrincipal, packagerId).capability;
  const report = async capability => {
    agent.socket.send(JSON.stringify({ version: 1, type: "capability", capability }));
    await agent.next(m => m.type === "capability-accepted");
  };
  const capability = { ...previous, capabilityVersion: 3, sourceAudioControlVersion: 1, agentVersion: "0.10.0" };
  await report(capability);
  for (const patch of [{ extra: true }, { requestVersion: 2 }, { deviceFingerprint: "bad" }, { expectedProgramRevision: 0 }]) assert.equal((await post({ ...input, ...patch })).status, 400);
  assert.equal((await post({ ...input, deviceFingerprint: "z".repeat(43) })).status, 403);
  assert.equal((await post(input, { headers: { ...headers, authorization: "Bearer handoff-foreign-token" } })).status, 403);
  assert.equal((await post(input, { headers: { ...headers, authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await post(input, { headers: { ...headers, origin: "https://foreign.example" } })).status, 404);
  assert.equal((await post({ ...input, expectedProgramRevision: control.programRevision + 1 })).status, 409);
  const socket = nativePackagers.socketFor(packagerId);
  Object.defineProperty(socket, "bufferedAmount", { value: 65537, configurable: true });
  try { assert.equal((await post()).status, 503); } finally { delete socket.bufferedAmount; }
  const respond = (command, type, fields) => agent.socket.send(JSON.stringify({ version: 1, type,
    ...Object.fromEntries(["commandId", "assignmentId", "programId", "programEpoch", "leaseId", "fencingRevision"].map(k => [k, command[k]])), ...fields }));
  const state = command => respond(command, "source-program-audio-state", { observedAt: Date.now(), audioRevision: 2,
    sources: [{ sourceLeaseId: "sls_aaaaaaaaaaaaaaaa", sourceKind: "microphone", leftGainQ15: 32768, rightGainQ15: 32768, muted: false }] });
  const pending = post(), query = await agent.next(m => m.type === "source-program-audio-query");
  assert.equal((await post()).status, 429); state(query);
  const response = await pending; assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const observed = await response.json(); assert.equal(observed.outcome, "observed"); assert.equal(observed.sources.length, 1);
  for (const field of ["leaseId", "commandId", "socket", "deviceFingerprint"]) assert.equal(Object.hasOwn(observed, field), false);
  const selection = { ...input, action: "apply", trigger: "user-action", expectedAudioRevision: 2,
    sources: [{ sourceLeaseId: "sls_aaaaaaaaaaaaaaaa", leftGainQ15: 16384, rightGainQ15: 8192, muted: true }] };
  for (const patch of [{ trigger: "remote" }, { leaseId: query.leaseId }, { sources: [] }]) assert.equal((await post({ ...selection, ...patch })).status, 400);
  const update = post(selection), command = await agent.next(m => m.type === "source-program-audio");
  assert.equal(command.sources[0].muted, true); assert.equal(command.leaseId, query.leaseId);
  respond(command, "source-program-audio-applied", { appliedAt: Date.now(), audioRevision: 3 });
  assert.equal((await (await update).json()).outcome, "applied");
  const conflict = post(selection), stale = await agent.next(m => m.type === "source-program-audio");
  respond(stale, "source-program-audio-rejected", { observedAt: Date.now(), reasonCode: "AUDIO_NOT_APPLIED" });
  assert.equal((await (await conflict).json()).outcome, "rejected");
  const revoked = post(), old = await agent.next(m => m.type === "source-program-audio-query");
  await report(previous); assert.equal((await revoked).status, 409);
  state(old); // A late former-generation reply cannot restore the pending operation.
  await report(capability);
  const final = post(), fresh = await agent.next(m => m.type === "source-program-audio-query"); state(fresh);
  assert.equal((await final).status, 200);
  await report(previous);
  assert.equal(app.nativePackagerAssignments.activeForProgram(programId).state, "running");
}
