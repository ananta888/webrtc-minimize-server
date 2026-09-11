import assert from "node:assert/strict";
import test from "node:test";
import { captureFirstCameraLease } from "./helpers/native-source-lease-replay.mjs";

function fixture() {
  let now = 1000;
  const sent = [];
  const socket = { send(...args) { assert.equal(this, socket); sent.push(args); return 42; } };
  const original = socket.send;
  const probe = captureFirstCameraLease(socket, () => now);
  const lease = (expiry = 2000, sourceKind = "camera") => JSON.stringify({ version: 1,
    type: "trusted-source-publisher-lease", lease: { expiresAt: expiry, consent: { sourceKind } } });
  return { socket, original, probe, sent, lease, advance: value => { now = value; } };
}

test("fixture forwards exact messages/callbacks and replays only the first expired lease once", () => {
  const f = fixture(), callback = () => {};
  assert.equal(f.socket.send(f.lease(), { binary: false }, callback), 42);
  assert.deepEqual(f.sent[0], [f.lease(), { binary: false }, callback]);
  f.socket.send(f.lease(5000));
  assert.throws(() => f.probe.replayExpired(), /not expired/);
  f.advance(2000); assert.throws(() => f.probe.replayExpired(), /not expired/);
  f.advance(2001); assert.equal(f.probe.replayExpired(), 42);
  assert.deepEqual(f.sent.at(-1), [f.lease()]);
  assert.equal(f.socket.send, f.original);
  assert.throws(() => f.probe.replayExpired(), /did not capture/);
});

test("fixture bounds retention and ignores invalid, expired, non-camera and non-string messages", () => {
  const f = fixture();
  for (const input of [null, "{", "x".repeat(8193), f.lease(1000), f.lease(2000, "screen"),
    f.lease(1.5), f.lease().replace('"version":1', '"version":2'), Buffer.from(f.lease())]) f.socket.send(input);
  f.advance(3000); assert.throws(() => f.probe.replayExpired(), /did not capture/);
  assert.equal(f.sent.length, 8);
  f.probe.dispose(); assert.equal(f.socket.send, f.original);
});

test("fixture disposal forgets the message and preserves a subsequent socket wrapper", () => {
  const f = fixture(); f.socket.send(f.lease());
  const replacement = () => {}; f.socket.send = replacement;
  f.probe.dispose(); f.probe.dispose(); f.advance(3000);
  assert.equal(f.socket.send, replacement);
  assert.throws(() => f.probe.replayExpired(), /did not capture/);
});
