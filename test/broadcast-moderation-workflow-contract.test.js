import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { authorizeBroadcastModerationAction } from "../src/broadcast-moderation-policy.js";

// Exercise the actual browser serializer and production server policy together.
// This is not a claim that an HTTP moderation route or writer handoff exists.
const compiled = await build({ entryPoints: ["frontend/src/app/broadcast/broadcast-moderation-workflow.ts"],
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent" });
const source = `${compiled.outputFiles[0].text}\n//# sourceURL=broadcast-moderation-browser-contract.js`;
const { BroadcastModerationWorkflow } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const now = 1_800_000_000_000;
const snapshot = Object.freeze({ tenantId: "tn_aaaaaaaaaaaaaaaa", roomId: "room-alpha",
  programId: "prg_aaaaaaaaaaaaaaaa", programRevision: 7, programEpoch: 11, leaseEpoch: 13,
  actorSubjectRef: "sub_bbbbbbbbbbbbbbbb", actorRole: "owner" });
const program = Object.freeze({ contractVersion: 1, type: "broadcast-program",
  tenantId: snapshot.tenantId, roomId: snapshot.roomId, programId: snapshot.programId,
  ownerSubjectRef: snapshot.actorSubjectRef, revision: 7, programEpoch: 11, state: "live", visibility: "private",
  sourceIds: ["src_aaaaaaaaaaaaaaaa"], createdAt: now - 10_000, updatedAt: now - 1_000 });
const actor = role => ({ projectionVersion: 1, source: role === "viewer" ? "broadcast-audience" : "room-membership", active: true,
  tenantId: snapshot.tenantId, roomId: snapshot.roomId, subjectRef: snapshot.actorSubjectRef, role, epoch: 13 });
const result = Object.freeze({ programRevision: 8, programEpoch: 11, leaseEpoch: 13 });
const cases = [
  { action: "source-request", targetSubjectRef: "sub_cccccccccccccccc", sourceKind: "screen" },
  { action: "source-remove", targetSubjectRef: "sub_cccccccccccccccc", sourceId: "src_aaaaaaaaaaaaaaaa", reasonCode: "MODERATOR_REVOKED" },
  { action: "own-source-revoke", targetSubjectRef: snapshot.actorSubjectRef, sourceId: "src_aaaaaaaaaaaaaaaa", reasonCode: "PUBLISHER_REVOKED" },
  { action: "layout-change", layout: "grid" },
  { action: "packager-select", primaryAgentId: "pkr_AAAAAAAAAAAAAAAA", standbyAgentIds: ["pkr_bbbbbbbbbbbbbbbb", "desktop"] },
  { action: "packager-standby", standbyAgentIds: ["pkr_bbbbbbbbbbbbbbbb"] },
  { action: "packager-handoff", primaryAgentId: "pkr_bbbbbbbbbbbbbbbb" },
  { action: "program-stop", reasonCode: "OWNER_STOP" },
];

for (const draft of cases) test(`real browser moderation envelope is accepted by the closed server policy: ${draft.action}`, async () => {
  const order = [];
  let received;
  const role = draft.action === "own-source-revoke" ? "presenter" : "owner";
  const workflow = new BroadcastModerationWorkflow({ execute: async (action, signal) => {
    assert.equal(signal.aborted, false);
    order.push("server-policy");
    received = JSON.parse(JSON.stringify(action));
    assert.deepEqual(authorizeBroadcastModerationAction(program, actor(role), received, now), received);
    return result;
  } }, { fenceStopAndClear: async (_sourceId, signal) => { assert.equal(signal.aborted, false); order.push("local-revoke"); } }, () => now);
  const confirmation = workflow.request({ ...draft, targetLabel: "PRIVATE LOCAL LABEL" }, { ...snapshot, actorRole: role }, "user-action");
  assert.equal(confirmation.targetLabel, "PRIVATE LOCAL LABEL");
  assert.deepEqual(await workflow.confirm(confirmation.confirmationId, "user-action"), result);
  assert.equal(Object.hasOwn(received, "targetLabel"), false);
  assert.equal(JSON.stringify(received).includes("PRIVATE LOCAL LABEL"), false);
  if (draft.action === "own-source-revoke") assert.deepEqual(order, ["local-revoke", "server-policy"]);
  if (draft.action === "packager-handoff") assert.equal(received.expectedLeaseEpoch, snapshot.leaseEpoch);
  for (const mutation of [ { targetLabel: "forbidden" }, { unexpected: true }, { roomId: "room-other" },
    { actorRole: "moderator" }, { expectedProgramRevision: 6 }, { expectedProgramEpoch: 10 } ]) {
    assert.throws(() => authorizeBroadcastModerationAction(program, actor(role), { ...received, ...mutation }, now));
  }
  workflow.destroy();
});

test("a browser claim cannot confer moderator authority on the server", async () => {
  const workflow = new BroadcastModerationWorkflow({ execute: async action => {
    authorizeBroadcastModerationAction(program, actor("viewer"), action, now);
    return result;
  } }, { fenceStopAndClear: async () => {} }, () => now);
  const confirmation = workflow.request({ action: "program-stop", targetLabel: "Stop", reasonCode: "OWNER_STOP" }, snapshot, "user-action");
  await assert.rejects(workflow.confirm(confirmation.confirmationId, "user-action"), { code: "broadcast_moderation_actor_mismatch" });
  workflow.destroy();
});
