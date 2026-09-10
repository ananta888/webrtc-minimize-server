import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { installMultiPublisherObservation } from "./helpers/machine-multi-publisher-observation.mjs";
import { multiHubMedia } from "./helpers/machine-multi-hub-media.mjs";
import { reconnectQuietWindow } from "./helpers/machine-reconnect-quiet-window.mjs";

test("silence includes detached audio connections with no remaining visible video", async () => {
  let level = .2;
  class Peer {
    addEventListener(name, callback) { this[name] = callback; }
    getReceivers() { return []; }
  }
  class Audio {
    constructor() { this.state = "running"; }
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { fftSize: 32, getFloatTimeDomainData(pcm) { pcm.fill(level); }, connect() {} }; }
    createGain() { return { gain: { value: 0 }, connect() {} }; }
    async resume() {}
    async close() { this.state = "closed"; }
  }
  const context = vm.createContext({ window: { RTCPeerConnection: Peer, __pcs: [] },
    document: { querySelectorAll() { return []; } }, AudioContext: Audio, MediaStream: class {},
    setInterval() { return 1; }, clearInterval() {} });
  vm.runInContext("(" + installMultiPublisherObservation.toString() + ")()", context);
  const peer = new context.window.RTCPeerConnection();
  peer.track({ track: { kind: "audio", readyState: "live" } });
  await Promise.resolve(); await Promise.resolve();
  const observer = context.window.__multiPublisher;
  assert.equal(JSON.stringify(observer.active(["a".repeat(16), "b".repeat(16)])), "[false,false]");
  assert.equal(JSON.stringify(observer.quiet()), '{"failed":false,"tracks":1,"active":true}');
  level = 0;
  assert.equal(JSON.stringify(observer.quiet()), '{"failed":false,"tracks":1,"active":false}');
  await observer.close(); assert.equal(observer.quiet().failed, true);
});

function fixture(value) {
  let samples = 0;
  const human = {
    async evaluate(fn) {
      if (!fn.toString().includes(".quiet()")) return;
      ++samples; return typeof value === "function" ? value(samples) : value;
    },
    locator() { return { filter() { return { async click() {} }; } }; },
  };
  return { human, samples: () => samples };
}

test("reconnect silence requires consecutive fresh all-track samples for 300 ms", async () => {
  const f = fixture(n => ({ failed: false, tracks: 4, active: n < 3 }));
  const media = await multiHubMedia(f);
  assert.deepEqual(await media.command({ command: "recovered-media" }, ["a", "b"]),
    { oldAudioReplayed: false, quietMs: 300 });
  // Scheduling need not produce exactly one observation every 50 ms. The
  // deterministic window tests enforce duration and the maximum sample gap.
  assert.ok(f.samples() >= 5); await media.close();
});

test("quiet window requires 300 monotonic milliseconds with bounded fresh observations", () => {
  let time = 0;
  const accept = reconnectQuietWindow(() => time), quiet = { failed: false, tracks: 1, active: false };
  for (time of [0, 50, 100, 150, 200, 250, 299]) assert.equal(accept(quiet), false);
  time = 300; assert.equal(accept(quiet), true);
  time = 350; assert.equal(accept({ ...quiet, active: true }), false);
  for (time of [400, 500, 600, 699]) assert.equal(accept(quiet), false);
  time = 700; assert.equal(accept(quiet), true);
});

test("a sampling gap or changed track count starts a fresh quiet window", () => {
  let time = 0;
  const accept = reconnectQuietWindow(() => time), quiet = { failed: false, tracks: 1, active: false };
  for (time of [0, 150]) assert.equal(accept(quiet), false);
  time = 301; assert.equal(accept(quiet), false, "151 ms gap resets instead of claiming quiet");
  time = 451; assert.equal(accept(quiet), false);
  time = 601; assert.equal(accept(quiet), true);
  time = 651; assert.equal(accept({ ...quiet, tracks: 2 }), false);
  for (time of [751, 851, 950]) assert.equal(accept({ ...quiet, tracks: 2 }), false);
  time = 951; assert.equal(accept({ ...quiet, tracks: 2 }), true);
});

test("invalid or backwards observation clocks cannot create a quiet receipt", () => {
  const quiet = { failed: false, tracks: 1, active: false };
  for (const invalid of [NaN, Infinity, -1, "300", undefined]) {
    assert.throws(() => reconnectQuietWindow(() => invalid)(quiet), /audio_clock_invalid/);
  }
  let time = 300;
  const accept = reconnectQuietWindow(() => time);
  assert.equal(accept(quiet), false);
  time = 299; assert.throws(() => accept(quiet), /audio_clock_invalid/);
});

test("a wall-clock jump cannot manufacture a 300 ms reconnect silence receipt", async t => {
  let wall = 1000;
  t.mock.method(Date, "now", () => wall += 10000);
  const f = fixture({ failed: false, tracks: 1, active: false });
  const media = await multiHubMedia(f), started = performance.now();
  try {
    assert.deepEqual(await media.command({ command: "recovered-media" }, []),
      { oldAudioReplayed: false, quietMs: 300 });
    assert.ok(performance.now() - started >= 300, "quiet proof must span real monotonic time");
  } finally { await media.close(); }
});

for (const value of [null, { failed: true, tracks: 1, active: false }, { failed: false, tracks: 0, active: false },
  { failed: false, tracks: 5, active: false }, { failed: false, tracks: 1, active: 0 },
  { failed: false, tracks: 1, active: false, untrusted: true }]) {
  test(`invalid silence projection never claims recovery: ${JSON.stringify(value)}`, async () => {
    const f = fixture(value), media = await multiHubMedia(f);
    await assert.rejects(media.command({ command: "recovered-media" }, ["a", "b"]), /audio_observation_invalid/);
    assert.equal(f.samples(), 1); await media.close();
  });
}

test("reply delivery has the existing Hub budget before the separate audio observation", async () => {
  const observed = [];
  const human = { async evaluate() {}, locator(selector) {
    assert.equal(selector, "#chat-log");
    return { getByText(text, options) {
      assert.equal(text, "Synthetic Hub answer"); assert.deepEqual(options, { exact: false });
      return { nth(index) { return { async waitFor(options) { observed.push({ index, options }); } }; } };
    } };
  } };
  const media = await multiHubMedia({ human });
  for (const count of [1, 2]) assert.deepEqual(await media.command({ command: "answer-count", count }, []), { replies: count });
  assert.deepEqual(observed, [{ index: 0, options: { timeout: 25000 } }, { index: 1, options: { timeout: 25000 } }]);
  for (const input of [{ command: "answer-count", count: 3 }, { command: "answer-count", count: true },
    { command: "answer-count", count: 1, text: "foreign" }]) {
    await assert.rejects(media.command(input, []), /command_invalid/);
  }
  assert.equal(observed.length, 2); await media.close();
});
