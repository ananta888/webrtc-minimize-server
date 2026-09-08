import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { installDialogObservation } from "./helpers/machine-dialog-observer.mjs";

const message = extra => ({ version: 2, type: "chat", roomId: "room-" + "a".repeat(18), membershipEpoch: 1,
  messageId: "b".repeat(32), replyTo: "", sentAt: 100, text: "Synthetic question", ...extra });
function setup({ delay = false, unsupported = false, sendError = null, sendResult } = {}) {
  const contexts = [], timers = new Map(), rendered = [], pending = [];
  class Channel extends EventTarget {
    label = "chat"; sent = [];
    send(raw) { this.sent.push(raw); if (sendError) throw sendError; return sendResult; }
    receive(value) { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(value) })); }
  }
  class Peer extends EventTarget {
    createDataChannel() { return new Channel(); }
    getReceivers() { return []; }
  }
  class Audio {
    closed = 0;
    constructor() { if (unsupported) throw new Error("unsupported"); contexts.push(this); }
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { fftSize: 4, connect() {}, getFloatTimeDomainData(pcm) { pcm.fill(.2); } }; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    resume() { return delay ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(); }
    close() { this.closed++; return Promise.resolve(); }
  }
  class Worker extends EventTarget { sent = []; postMessage(...args) { this.sent.push(args); } }
  class Transform { constructor(...args) { this.args = args; } }
  const window = { RTCPeerConnection: Peer, Worker, RTCRtpScriptTransform: Transform, __pcs: [] };
  const context = { window, AudioContext: Audio, MediaStream: class {}, crypto: webcrypto, TextEncoder,
    document: { querySelectorAll: () => rendered.map(text => ({ textContent: text })) },
    setInterval: callback => { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearInterval: id => timers.delete(id),
  };
  vm.runInNewContext(`(${installDialogObservation.toString()})()`, context);
  const peer = new window.RTCPeerConnection(), channel = peer.createDataChannel("chat");
  return { probe: window.__dialogObservation, peer, channel, contexts, timers, rendered, pending, window, Peer };
}

test("probe requires exact outgoing correlation AND accepted rendered text; outputs digest only", async () => {
  const f = setup(); f.channel.send(JSON.stringify(message()));
  for (const extra of [{ replyTo: "d".repeat(32) }, { membershipEpoch: 2 }, { roomId: "other" }]) {
    f.channel.receive(message({ messageId: "c".repeat(32), replyTo: "b".repeat(32), ...extra }));
    assert.equal(f.probe.status().correlated, false);
  }
  f.channel.receive(message({ messageId: "c".repeat(32), replyTo: "b".repeat(32), text: "Synthetic model answer" }));
  await assert.rejects(f.probe.answer(), /not_rendered/);
  f.rendered.push("Synthetic question", "Synthetic model answer");
  const result = await f.probe.answer();
  assert.deepEqual(Object.keys(result).sort(), ["correlated", "text_sha256"]);
  assert.match(result.text_sha256, /^[a-f0-9]{64}$/); assert.equal(result.correlated, true);
  assert.equal(JSON.stringify(result).includes("Synthetic"), false);
  await f.probe.close(); assert.equal(f.probe.status().correlated, false);
  assert.equal(f.window.RTCPeerConnection, f.Peer);
});

test("probe has an eight-request bound and never alters forwarded valid bytes", async () => {
  const f = setup(), raw = JSON.stringify(message());
  for (let n = 0; n < 8; n++) f.channel.send(raw);
  assert.equal(f.channel.sent.length, 8); assert.equal(f.channel.sent[0], raw);
  assert.throws(() => f.channel.send(raw), /probe_budget/);
  assert.equal(f.probe.chatStatus().attempted, 8);
  assert.equal(f.probe.chatStatus().queued, 8);
  await f.probe.close(); f.channel.send(raw); assert.equal(f.channel.sent.length, 9);
  assert.equal(f.probe.status().correlated, false);
});

test("dispatch observation preserves native return/throw and emits only bounded counts", async () => {
  const returned = {}, error = new Error("private native detail"), raw = JSON.stringify(message());
  for (const failed of [false, true]) {
    const f = setup({ sendError: failed ? error : null, sendResult: returned });
    if (failed) assert.throws(() => f.channel.send(raw), caught => caught === error);
    else assert.equal(f.channel.send(raw), returned);
    const report = f.probe.chatStatus();
    assert.equal(f.channel.sent.length, 1); assert.equal(f.channel.sent[0], raw);
    assert.deepEqual(JSON.parse(JSON.stringify(report)), { attempted: 1, queued: failed ? 0 : 1,
      send_failures: failed ? 1 : 0, answer_seen: false, rendered: false });
    assert.equal(JSON.stringify(report).includes("private"), false);
    await f.probe.close(); assert.equal(f.probe.chatStatus().attempted, 0);
  }
});

test("audio observation is bounded, non-capturing, resettable and closed", async () => {
  const f = setup();
  for (let n = 0; n < 5; n++) f.peer.dispatchEvent(Object.assign(new Event("track"), { track: { kind: "audio" } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.contexts.length, 4); assert.equal(f.probe.status().failed, true);
  for (const tick of f.timers.values()) tick();
  assert.equal(f.probe.status().active_windows, 4); assert.ok(f.probe.status().peak > .1);
  f.probe.resetAudio(); assert.equal(f.probe.status().active_windows, 0); assert.equal(f.probe.status().peak, 0);
  await f.probe.close(); assert.equal(f.timers.size, 0); assert.ok(f.contexts.every(c => c.closed));
});

test("late AudioContext resume cannot install a timer after cleanup", async () => {
  const f = setup({ delay: true });
  f.peer.dispatchEvent(Object.assign(new Event("track"), { track: { kind: "audio" } }));
  await f.probe.close(); for (const resolve of f.pending) resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.timers.size, 0); assert.ok(f.contexts.every(c => c.closed));
});

test("unsupported audio fails the observation without an unhandled callback", async () => {
  const f = setup({ unsupported: true });
  f.peer.dispatchEvent(Object.assign(new Event("track"), { track: { kind: "audio" } }));
  await Promise.resolve(); assert.equal(f.probe.status().failed, true); await f.probe.close();
});

test("transform diagnostics are bounded counts and preserve native message forwarding", async () => {
  const f = setup(), worker = new f.window.Worker();
  const command = { type: "set-key", direction: "decrypt", contextId: "private-context", baseKey: "never-report-key" };
  worker.postMessage(command, []);
  new f.window.RTCRtpScriptTransform(worker, { direction: "decrypt", contextId: command.contextId });
  assert.equal(worker.sent[0][0], command);
  assert.equal(f.probe.status().matched_contexts, 1);
  for (let n = 0; n < 40; n++) {
    worker.postMessage({ ...command, contextId: "context-" + n });
    new f.window.RTCRtpScriptTransform(worker, { direction: "decrypt", contextId: "context-" + n });
  }
  const status = f.probe.status();
  assert.equal(status.keyed_contexts, 32); assert.equal(status.decrypt_contexts, 32);
  assert.equal(JSON.stringify(status).includes("private-context"), false);
  assert.equal(JSON.stringify(status).includes("never-report-key"), false);
  await f.probe.close(); assert.equal(f.probe.status().matched_contexts, 0);
});
