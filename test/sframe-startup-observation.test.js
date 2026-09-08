import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { collectSFrameStartup, installSFrameStartupObservation, sframeStartupSnapshot } from "./helpers/sframe-startup-observation.mjs";

test("startup observer preserves native Worker messages and bounds its closed code buffer", () => {
  class Worker {
    events = new Map();
    constructor(...args) { this.args = args; }
    addEventListener(type, callback) { const list = this.events.get(type) || []; list.push(callback); this.events.set(type, list); }
    emit(type, value) { for (const handler of this.events.get(type) || []) handler(value); }
  }
  const sandbox = { Worker };
  runInNewContext(`(${installSFrameStartupObservation.toString()})()`, sandbox);
  const worker = new sandbox.Worker("private-worker-url", { name: "sframe-media" });
  let received = 0; worker.addEventListener("message", () => received++);
  worker.emit("message", { data: { type: "set-key", baseKey: "PRIVATE_MARKER" } });
  worker.emit("message", { data: { type: "transform-error", code: "PRIVATE_MARKER", contextId: "PRIVATE_MARKER" } });
  worker.emit("message", { data: { type: "transform-error", code: "media_frame_type" } });
  worker.emit("error", { message: "PRIVATE_MARKER" });
  for (let i = 0; i < 300; i++) worker.emit("message", { data: { type: "transform-error", code: "media_envelope_version" } });
  assert.equal(received, 303); assert.equal(sandbox.__sframeStartupErrors.length, 129);
  assert.equal(JSON.stringify(sandbox.__sframeStartupErrors).includes("PRIVATE_MARKER"), false);
  assert.equal(worker.args[0], "private-worker-url");
  const other = new sandbox.Worker("another", { name: "unrelated" });
  assert.equal(other.events.size, 0);
});

test("serialized startup snapshot has only closed states and bounded numeric RTP rows", async () => {
  const sandbox = { document: { querySelector: () => ({ textContent: "PRIVATE_MARKER" }) }, __sframeStartupErrors: [],
    __peerConnections: Array.from({ length: 3 }, () => ({ connectionState: "connected", async getStats() {
      return new Map(Array.from({ length: 100 }, (_, i) => [i, { type: "inbound-rtp", framesDecoded: i,
        packetsReceived: Infinity, keyFramesDecoded: true, pliCount: -1, codec: "PRIVATE_MARKER", sdp: "PRIVATE_MARKER" }]));
    } })) };
  const result = await runInNewContext(`(${sframeStartupSnapshot.toString()})()`, sandbox);
  assert.equal(result.state, "unknown"); assert.equal(result.connections.length, 2);
  assert.equal(result.connections[0].rtp.length, 8);
  assert.equal(JSON.stringify(result).includes("PRIVATE_MARKER"), false);
  assert.deepEqual(Object.keys(result.connections[0].rtp[0]), ["inbound", "framesDecoded"]);
});

test("collection bounds a stuck browser and redacts native exceptions", async () => {
  assert.deepEqual(await collectSFrameStartup({ evaluate: () => new Promise(() => {}) }, 5), { available: false });
  assert.deepEqual(await collectSFrameStartup({ evaluate: async () => { throw new Error("PRIVATE_MARKER"); } }), { available: false });
  const actual = await collectSFrameStartup({ evaluate: async () => ({ state: "pending", connections: [],
    errors: ["PRIVATE_MARKER", "media_frame_type"] }) });
  assert.equal(actual.transforms.counts.unknown, 1); assert.equal(actual.transforms.counts.media_frame_type, 1);
  assert.equal(JSON.stringify(actual).includes("PRIVATE_MARKER"), false);
});
