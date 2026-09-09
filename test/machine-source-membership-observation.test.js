import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { observeMachineSourceMembership } from "./helpers/machine-source-membership-observation.mjs";
test("membership observation retains only bounded authority counts and known errors", () => {
  const page = new EventEmitter(), socket = new EventEmitter(), snapshot = observeMachineSourceMembership(page);
  page.emit("websocket", socket);
  const send = value => socket.emit("framereceived", { payload: JSON.stringify(value) });
  send({ type: "signal", sdp: "private" }); send({ type: "error", code: "private" });
  send({ type: "topology-state", membershipEpoch: 2, peers: ["private", "secret"], roomId: "secret" });
  send({ type: "peer-left", peerId: "private" });
  assert.deepEqual(snapshot().events.map(({ elapsedMs, ...v }) => v), [
    { kind: "error", code: "other" }, { kind: "membership", epoch: 2, peers: 2 }, { kind: "peer-left" },
  ]);
  for (let i=0; i<40; i++) send({ type: "error", code: "rate_limited" });
  assert.equal(snapshot().events.length, 32); assert.equal(snapshot().truncated, true);
  assert.doesNotMatch(JSON.stringify(snapshot()), /private|secret|sdp|roomId|peerId/);
});
