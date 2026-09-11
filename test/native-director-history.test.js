import assert from "node:assert/strict";
import test from "node:test";
import { directNativeSourceScene } from "../src/native-source-scene-director.js";
import { directNativeSourceAudio } from "../src/native-source-audio-director.js";
import { NativeSourceSceneBroker } from "../src/native-source-scene-broker.js";
import { NativeSourceAudioBroker } from "../src/native-source-audio-broker.js";
import { broadcastTenantRef, broadcastSubjectRef } from "../src/broadcast-identifiers.js";
const now = 1800000000000;
for (const kind of ["scene", "audio"]) for (const mode of ["applied", "query", "rejected", "stale", "after-ack", "invalid", "observer-failed"]) {
  test(`${kind} journal follows the real correlated broker ACK, mode=${mode}`, async () => {
    const identity = { issuer: "https://synthetic.example", subject: "owner" }, socket = {}, generation = {}, events = [];
    const member = { id: "a".repeat(16), creator: true, principal: "owner", roomId: "room-alpha", deviceFingerprint: "a".repeat(43) };
    const programId = "prg_aaaaaaaaaaaaaaaa", packagerId = "pkr_aaaaaaaaaaaaaaaa";
    const writer = { state: "live", programRevision: 4, programEpoch: 2, packagerRef: packagerId,
      fencingRevision: 3, leaseId: "lea_aaaaaaaaaaaaaaaa", expiresAt: now + 60000 };
    const assignment = { inputMode: "trusted-sframe-v1", assignmentId: "asn_aaaaaaaaaaaaaaaa", programId,
      programEpoch: 2, roomId: member.roomId, leaseId: writer.leaseId, fencingRevision: 3, expiresAt: now + 50000 };
    const capability = { capabilityVersion: 3, sourcePrograms: true, sourceAudioControlVersion: 1,
      agentVersion: "1.0.0", expiresAt: now + 30000 };
    const selected = kind === "scene" ? { expectedSceneRevision: 1, layout: "waiting-slate", sourceLeaseIds: [], activeSourceLeaseId: "" }
      : { expectedAudioRevision: 1, sources: [{ sourceLeaseId: "sls_aaaaaaaaaaaaaaaa", muted: false, leftGainQ15: 32768, rightGainQ15: 32768 }] };
    const input = { requestVersion: 1, action: mode === "query" ? "query" : "apply", deviceFingerprint: member.deviceFingerprint,
      expectedProgramRevision: 4, expectedProgramEpoch: 2, ...(mode === "query" ? {} : { trigger: "user-action", ...selected }) };
    const Broker = kind === "scene" ? NativeSourceSceneBroker : NativeSourceAudioBroker;
    const broker = new Broker({ clock: () => now, send: (target, command) => {
      assert.equal(target, socket);
      queueMicrotask(() => {
        if (mode === "stale") writer.programEpoch++;
        const reply = Object.fromEntries(["version", "commandId", "assignmentId", "programId", "programEpoch", "leaseId", "fencingRevision"].map(k => [k, command[k]]));
        Object.assign(reply, mode === "rejected" ? { type: `source-program-${kind}-rejected`, observedAt: now, reasonCode: `${kind.toUpperCase()}_NOT_APPLIED` }
          : { type: `source-program-${kind}-applied`, appliedAt: now, [`${kind}Revision`]: 2 });
        if (mode === "query") {
          delete reply.appliedAt;
          Object.assign(reply, { type: `source-program-${kind}-state`, observedAt: now }, kind === "scene"
            ? { layout: "waiting-slate", sourceLeaseIds: [], activeSourceLeaseId: "", availableSources: [] } : { sources: [] });
        }
        if (mode === "invalid") reply.privateToken = "must-never-retain";
        broker.acknowledge(socket, reply);
        assert.equal(broker.acknowledge(socket, reply), false, "duplicate ACK cannot create another journal entry");
        if (mode === "after-ack") writer.programEpoch++;
      });
      return true;
    } });
    const args = { identity, ownerPrincipal: "owner", programId, input, getMember: () => member, clock: () => now,
      runtime: { nativeSourceWriterContext: () => writer, observeProgramAction: (...args) => {
        if (mode === "observer-failed") throw new Error("private observer error"); events.push(args);
      } }, assignments: { sourceContext: () => assignment },
      control: { sourceContext: () => ({ generation, capability }), socketFor: () => socket, connection: () => ({ ownerPrincipal: "owner" }) }, broker };
    try {
      const result = (kind === "scene" ? directNativeSourceScene : directNativeSourceAudio)(args);
      if (["stale", "after-ack", "invalid"].includes(mode)) await assert.rejects(result);
      else assert.equal((await result).outcome, mode === "rejected" ? "rejected" : mode === "query" ? "observed" : "applied");
      const scope = { tenantId: broadcastTenantRef(identity.issuer), ownerSubjectRef: broadcastSubjectRef(identity),
        roomId: member.roomId, programId, programEpoch: 2 };
      if (mode === "applied") assert.deepEqual(events, [[scope, { kind: `${kind}-applied`, sourceKind: null, reason: null, controlRevision: 2 }, now]]);
      else if (mode === "rejected") assert.deepEqual(events, [[scope, { kind: `${kind}-rejected`, sourceKind: null, reason: null, controlRevision: null }, now]]);
      else assert.deepEqual(events, []);
    } finally { broker.destroy(); }
  });
}
