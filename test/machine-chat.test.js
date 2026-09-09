import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parseMachineChatEvent, validateMachineChatScope } from "../src/machine-chat-contract.js";
import { MachineChatQueue } from "../src/machine-chat-queue.js";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/ananta-meet-chat-admission.json", import.meta.url)));
const event = fixture.base_event;
for (const item of fixture.cases) test(`shared Ananta draft fixture: ${item.name}`, () => {
  const raw = JSON.stringify({ ...event, ...item.patch });
  if (item.valid) assert.equal(parseMachineChatEvent(raw).schema, event.schema);
  else assert.throws(() => parseMachineChatEvent(raw));
});
test("chat parser rejects duplicate/escaped keys, invalid UTF-8, surrogates and non-JSON whitespace", () => {
  const raw = JSON.stringify(event);
  for (const input of [raw.replace('"generation":1', '"generation":1,"generati\\u006fn":2'),
    raw.replace('"generation":1', '"generation":{}'), raw.replace('{', '{\u00a0'),
    raw + "true", new Uint8Array([0xff]), JSON.stringify({ ...event, text: "\ud800" }),
    JSON.stringify({ ...event, text: "\0" }), JSON.stringify({ ...event, text: "x".repeat(8193) })]) {
    assert.throws(() => parseMachineChatEvent(input));
  }
  assert.equal(parseMachineChatEvent(new TextEncoder().encode(raw)).text, event.text);
});
test("chat text uses Unicode characters and UTF-8 byte limits like Ananta", () => {
  assert.equal(parseMachineChatEvent(JSON.stringify({ ...event, text: "😀".repeat(1000) })).text.length, 2000);
  assert.throws(() => parseMachineChatEvent(JSON.stringify({ ...event, text: "😀".repeat(1001) })));
});
function setup() {
  let now = 100_000;
  const authority = { chatRead: true, chatSend: true, scope: {
    origin: "https://webrtc.example", tenant_id: "tenant", project_id: "project", task_id: "task",
    session_id: event.session_id, runtime_id: "runtime", lease_id: "lease", generation: 1,
    room_id: event.room_id, membership_epoch: 1, policy_revision: 1, own_peer_id: "ai-peer", deadline_ms: 200_000,
  } };
  const queue = new MachineChatQueue({ authority: () => authority, clock: () => now });
  return { queue, authority, advance: ms => { now += ms; }, push: patch => queue.push(JSON.stringify({ ...event, ...patch })) };
}
test("queue is bounded, ephemeral, deduplicated and ACK cannot consume undelivered data", () => {
  const f = setup();
  assert.equal(f.push(), true); assert.equal(f.push(), false);
  assert.throws(() => f.queue.ack(1), /ack_invalid/);
  assert.equal(f.queue.poll().events.length, 1);
  f.queue.ack(1); assert.equal(f.queue.poll().events.length, 0);
  assert.equal(f.push(), false);
  assert.throws(() => f.queue.ack(0), /ack_invalid/);
  for (let i = 0; i < 32; i++) f.push({ message_id: `message-${i}` });
  assert.equal(f.queue.poll().events.length, 8);
  assert.throws(() => f.push({ message_id: "overflow" }), /queue_exhausted/);
  assert.throws(() => f.queue.poll(), /closed/);
});
test("machine, unknown and own events never trigger the chat adapter", () => {
  const f = setup();
  for (const patch of [{ sender_kind: "machine" }, { sender_kind: "unknown" }, { sender_peer_id: "ai-peer" }]) {
    assert.equal(f.push(patch), false);
  }
  assert.equal(f.queue.poll().events.length, 0);
});
for (const phase of ["queued", "delivered", "acknowledged", "aged-out"]) {
  test(`message ID remains bound to its original sender after ${phase}`, () => {
    const f = setup(); f.push();
    if (phase === "delivered" || phase === "acknowledged") f.queue.poll();
    if (phase === "acknowledged") f.queue.ack(1);
    if (phase === "aged-out") { f.advance(30_001); assert.equal(f.queue.poll().events.length, 0); }
    assert.throws(() => f.push({ sender_peer_id: "different-human", sent_at_ms: phase === "aged-out" ? 130_001 : 100_000 }),
      /meet_chat_message_id_conflict/);
    assert.throws(() => f.queue.poll(), /meet_chat_closed/);
    assert.throws(() => f.queue.checkReply(), /meet_chat_closed/);
  });
}
test("equal text from independent sender IDs is not a collision, and same-sender retries are deduplicated", () => {
  const f = setup(); assert.equal(f.push(), true);
  assert.equal(f.push({ text: "changed retry content" }), false);
  assert.equal(f.push({ message_id: "independent-id", sender_peer_id: "different-human" }), true);
  assert.equal(f.queue.poll().events.length, 2);
});
test("sender bindings retain the existing 512-ID budget without retaining an acknowledged history", () => {
  const f = setup();
  for (let i = 0; i < 512; i++) {
    assert.equal(f.push({ message_id: `id-${i}` }), true);
    const batch = f.queue.poll(); assert.equal(batch.events.length, 1);
    f.queue.ack(batch.events[0].cursor); assert.equal(f.queue.poll().events.length, 0);
  }
  assert.equal(f.push({ message_id: "id-0" }), false);
  assert.throws(() => f.push({ message_id: "id-512" }), /meet_chat_queue_exhausted/);
  assert.throws(() => f.queue.poll(), /meet_chat_closed/);
});
test("read-only authority receives and acknowledges without gaining reply rights", () => {
  const f = setup(); f.authority.chatSend = false;
  assert.equal(f.push(), true);
  assert.equal(f.queue.poll().events.length, 1);
  assert.throws(() => f.queue.checkReply(), /meet_chat_reply_denied/);
  f.queue.ack(1); assert.equal(f.queue.poll().events.length, 0);
  f.authority.chatSend = true; assert.doesNotThrow(() => f.queue.checkReply());
  f.authority.chatRead = false;
  assert.throws(() => f.queue.checkReply(), /meet_chat_receive_denied/);
  assert.throws(() => f.queue.poll(), /closed/);
});
test("scope and freshness are checked independently of valid parsing", () => {
  const f = setup();
  for (const patch of [{ generation: 2 }, { membership_epoch: 2 }, { session_id: "other" },
    { room_id: "room-222222222222222222" }, { sent_at_ms: 69_999 }, { sent_at_ms: 102_001 }]) {
    assert.throws(() => f.push(patch), /scope_invalid/);
  }
});
test("revocation, policy/lease changes, expiry and clock rollback immediately clear the endpoint", () => {
  for (const mutate of [f => { f.authority.chatRead = false; }, f => { f.authority.chatSend = "true"; },
    f => { f.authority.scope.policy_revision++; }, f => { f.authority.scope.generation++; },
    f => f.advance(100_000), f => f.advance(-1)]) {
    const f = setup(); f.push(); mutate(f);
    assert.throws(() => f.queue.poll()); assert.throws(() => f.queue.poll(), /closed/);
  }
});
test("read-only reply check still fences changed authority before reporting a missing send right", () => {
  const f = setup(); f.authority.chatSend = false; f.push();
  f.authority.scope.generation++;
  assert.throws(() => f.queue.checkReply(), /meet_chat_authority_changed/);
  assert.throws(() => f.queue.poll(), /closed/);
});
test("late events are pruned even when their timestamps arrive out of order", () => {
  const f = setup(); f.push(); f.push({ message_id: "older", sent_at_ms: 70_001 });
  f.advance(2); assert.equal(f.queue.poll().events.length, 1);
});
test("strict authority scope and callback failures never preserve access", () => {
  const f = setup();
  assert.throws(() => validateMachineChatScope({ ...f.authority.scope, tools: true }));
  assert.throws(() => validateMachineChatScope({ ...f.authority.scope, origin: "https://webrtc.example/path" }));
  assert.throws(() => new MachineChatQueue({ authority: () => { throw new Error("secret detail"); } }), /authority_unavailable/);
});
