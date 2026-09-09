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
  for (const patch of [{ extra: true }, { requestVersion: 3 }, { deviceFingerprint: "bad" }, { expectedProgramRevision: 0 }]) assert.equal((await post({ ...input, ...patch })).status, 400);
  assert.equal((await post({ ...input, requestVersion: 2 })).status, 409, "v1 audio capability does not authorize v2 strategy control");
  assert.equal((await post({ ...input, deviceFingerprint: "z".repeat(43) })).status, 403);
  assert.equal((await post(input, { headers: { ...headers, authorization: "Bearer handoff-foreign-token" } })).status, 403);
  assert.equal((await post(input, { headers: { ...headers, authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await post(input, { headers: { ...headers, origin: "https://foreign.example" } })).status, 404);
  assert.equal((await post({ ...input, expectedProgramRevision: control.programRevision + 1 })).status, 409);
  const socket = nativePackagers.socketFor(packagerId);
  Object.defineProperty(socket, "bufferedAmount", { value: 65537, configurable: true });
  try { assert.equal((await post()).status, 503); } finally { delete socket.bufferedAmount; }
  const respond = (command, type, fields) => agent.socket.send(JSON.stringify({ version: command.version, type,
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
  await report({ ...capability, capabilityVersion: 4, sourceAudioControlVersion: 2, agentVersion: "0.11.0" });
  const v2 = { ...input, requestVersion: 2 };
  const readV2 = post(v2), queryV2 = await agent.next(m => m.type === "source-program-audio-query");
  assert.equal(queryV2.version, 2);
  const mix = { strategy: "balanced", microphoneGainQ15: 32768, screenAudioGainQ15: 16384, limiterGainQ15: 32768, peakQ15: 10000 };
  const encoding = { codec: "aac", sampleRate: 48000, channels: 2, renditions: [{ id: "low", targetBitsPerSecond: 64000 }] };
  respond(queryV2, "source-program-audio-state", { observedAt: Date.now(), audioRevision: 4, sources: [], mix, encoding });
  const observedV2 = await (await readV2).json();
  assert.equal(observedV2.audioControlVersion, 2); assert.deepEqual(observedV2.mix, mix); assert.deepEqual(observedV2.encoding, encoding);
  const strategy = { ...v2, action: "apply", trigger: "user-action", expectedAudioRevision: 4, sources: [], strategy: "speech-first" };
  for (const patch of [{ strategy: "other" }, { mix }, { requestVersion: 1 }]) assert.equal((await post({ ...strategy, ...patch })).status, 400);
  const applyV2 = post(strategy), commandV2 = await agent.next(m => m.type === "source-program-audio");
  assert.equal(commandV2.strategy, "speech-first"); assert.deepEqual(commandV2.sources, []);
  respond(commandV2, "source-program-audio-applied", { appliedAt: Date.now(), audioRevision: 5 });
  const appliedV2 = await (await applyV2).json(); assert.equal(appliedV2.outcome, "applied"); assert.equal(appliedV2.audioControlVersion, 2);
  const downgrade = post(v2), pendingV2 = await agent.next(m => m.type === "source-program-audio-query");
  await report(capability); assert.equal((await downgrade).status, 409);
  respond(pendingV2, "source-program-audio-state", { observedAt: Date.now(), audioRevision: 5, sources: [], mix, encoding });
  assert.equal((await post(v2)).status, 409);
  await report(previous);
  assert.equal(app.nativePackagerAssignments.activeForProgram(programId).state, "running");
}
