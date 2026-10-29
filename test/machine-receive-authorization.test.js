import assert from "node:assert/strict";
import test from "node:test";
import { machineReceiveAuthorization } from "../src/machine-receive-authorization.js";

function fixture(caps = ["audio.receive", "chat.read"]) {
  const receiver = { id: "a".repeat(16), roomId: "room-test", machine: true, authenticated: true, machineCapabilities: caps };
  const owner = { id: "b".repeat(16), roomId: receiver.roomId, machine: false, authenticated: true,
    publications: new Map([["mic", { publicationId: "mic", source: "microphone", publicationEpoch: 1 }],
      ["camera", { publicationId: "camera", source: "camera", publicationEpoch: 2 }]]) };
  const members = [receiver, owner], lease = { expiresAt: 100_000 };
  const projection = (revision = 0) => machineReceiveAuthorization(receiver, members, revision, lease,
    (peer, id, room) => members.find(member => member.id === peer && member.roomId === room)?.publications?.get(id), 1000);
  return { receiver, owner, members, lease, projection };
}

test("verified receive capabilities project only current permitted sources without legacy consent", () => {
  const f = fixture(), result = f.projection();
  assert.deepEqual(result.grants, [{ publisherPeerId: f.owner.id, machinePeerId: f.receiver.id,
    publicationIds: ["mic"], chatRead: true, expiresAt: f.lease.expiresAt }]);
  assert.deepEqual(result.publications, [{ peerId: f.owner.id, publicationId: "mic", source: "microphone", publicationEpoch: 1 }]);
  assert.equal(result.receiveRevision, 1); assert.equal(f.projection(3).receiveRevision, 3);
  assert.ok(Object.isFrozen(result.grants[0].publicationIds));
  f.owner.publications.clear(); assert.deepEqual(f.projection().publications, []);
  assert.deepEqual(result.grants[0].publicationIds, ["mic"], "no implicit mutable source sharing");
  f.members.pop(); assert.deepEqual(f.projection().grants, [], "departed publisher is not authorized");
});

test("send/publish capabilities never authorize reading and source classes remain independent", () => {
  for (const caps of [["chat.send"], ["avatar.publish"], []]) assert.deepEqual(fixture(caps).projection().grants, []);
  const f = fixture(["video.receive"]), result = f.projection();
  assert.equal(result.grants[0].chatRead, false); assert.deepEqual(result.grants[0].publicationIds, ["camera"]);
});

test("anonymous, other-room and machine publishers never become human input authority", () => {
  for (const patch of [{ authenticated: false }, { roomId: "other" }, { machine: true }]) {
    const f = fixture(); Object.assign(f.owner, patch); assert.deepEqual(f.projection().grants, []);
  }
});

test("lease expiry, unknown capability, stale receiver and malformed source fail closed", () => {
  for (const mutate of [f => f.lease.expiresAt = 1000, f => f.lease.expiresAt = 700_000,
    f => f.members.shift(), f => f.receiver.machineCapabilities = ["record"],
    f => f.owner.publications.get("mic").publicationEpoch = 0,
    f => f.owner.publications.get("mic").publicationId = "other",
    f => f.members.push(f.owner)]) {
    const f = fixture(); mutate(f); assert.throws(() => f.projection());
  }
  for (const revision of [-1, NaN, 1.5]) assert.throws(() => fixture().projection(revision));
});
