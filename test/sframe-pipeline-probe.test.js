import assert from "node:assert/strict";
import test from "node:test";
import { installSFramePipelineProbe, collectSFramePipelines, installPrivateSFramePipelineRoute } from "./helpers/sframe-pipeline-probe.mjs";

function fixture(t) {
  const saved = Object.fromEntries(["TransformStream", "addEventListener", "__testSFramePipelineReport"]
    .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const through = ReadableStream.prototype.pipeThrough, to = ReadableStream.prototype.pipeTo;
  const listeners = new Map();
  globalThis.addEventListener = (type, callback) => listeners.set(type, callback);
  t.after(() => {
    ReadableStream.prototype.pipeThrough = through; ReadableStream.prototype.pipeTo = to;
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  });
  installSFramePipelineProbe();
  const run = async (frames, transform, write = () => {}) => {
    let pending;
    addEventListener("rtctransform", event => {
      pending = event.transformer.readable.pipeThrough(new TransformStream({ transform }))
        .pipeTo(new WritableStream({ write }));
    });
    listeners.get("rtctransform")({ transformer: { options: { direction: "decrypt", contextId: "PRIVATE-MARKER" },
      readable: new ReadableStream({ start(controller) { for (const frame of frames) controller.enqueue(frame); controller.close(); } }) } });
    await pending;
    return globalThis.__testSFramePipelineReport();
  };
  run.command = data => listeners.get("message")({ data });
  return run;
}

test("probe preserves exact native frame delivery and counts dropped frames without content", async t => {
  const run = fixture(t), delivered = [], frames = [{ type: "key", data: "PRIVATE-MARKER" }, { type: "delta" }, {}];
  const value = await run(frames, (frame, controller) => { if (frame.type !== "delta") controller.enqueue(frame); }, frame => delivered.push(frame));
  assert.deepEqual(delivered, [frames[0], frames[2]]); assert.equal(delivered[0], frames[0]);
  assert.deepEqual(value.rows[0], { index: 1, direction: "decrypt", inputKey: 1, inputDelta: 1, inputOther: 1,
    enqueuedKey: 1, enqueuedDelta: 0, enqueuedOther: 1, dropped: 1, thrown: 0, ended: true, pipeFailed: false,
    keySetCommands: 0, keyClearCommands: 0 });
  assert.equal(JSON.stringify(value).includes("PRIVATE-MARKER"), false);
  value.rows[0].dropped = 99;
  assert.equal(globalThis.__testSFramePipelineReport().rows[0].dropped, 1);
});

test("probe propagates transform and native writable rejection unchanged", async t => {
  const run = fixture(t), error = new Error("PRIVATE-MARKER");
  await assert.rejects(run([{ type: "key" }], () => { throw error; }), value => value === error);
  await assert.rejects(run([{ type: "delta" }], (frame, controller) => controller.enqueue(frame), () => { throw error; }), value => value === error);
  const value = globalThis.__testSFramePipelineReport();
  assert.equal(value.rows[0].thrown, 1); assert.equal(value.rows[0].dropped, 1);
  assert.equal(value.rows[1].enqueuedDelta, 1); assert.equal(value.rows[1].thrown, 0);
  assert.ok(value.rows.every(row => row.ended && row.pipeFailed));
  assert.equal(JSON.stringify(value).includes("PRIVATE-MARKER"), false);
});

test("probe retains only sixteen copied lifecycle rows and does not inspect frame data", async t => {
  const run = fixture(t);
  const frame = { type: "key", get data() { throw Error("must not inspect media"); } };
  for (let index = 0; index < 20; index++) await run([frame], (value, controller) => controller.enqueue(value));
  const value = globalThis.__testSFramePipelineReport();
  assert.equal(value.total, 20); assert.equal(value.rows.length, 16); assert.equal(value.rows[0].index, 5);
  assert.equal(value.truncated, true); assert.ok(JSON.stringify(value).length < 5000);
});

test("unrelated transforms are not observed", async t => {
  fixture(t); let invoked = 0;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(7); controller.close(); } });
  await stream.pipeThrough(new TransformStream({ transform(value, controller) { invoked++; controller.enqueue(value); } }))
    .pipeTo(new WritableStream());
  assert.equal(invoked, 1); assert.deepEqual(globalThis.__testSFramePipelineReport().rows, []);
});

test("probe counts key lifecycle commands without reading keys or treating commands as acceptance", async t => {
  const run = fixture(t);
  run.command({ version: 1, type: "set-key", contextId: "PRIVATE-MARKER",
    get baseKey() { throw Error("must not inspect key material"); } });
  run.command({ version: 1, type: "clear-context", contextId: "PRIVATE-MARKER" });
  const result = await run([{ type: "key" }], () => {});
  assert.equal(result.rows[0].keySetCommands, 1); assert.equal(result.rows[0].keyClearCommands, 1);
  assert.equal(result.rows[0].enqueuedKey, 0);
  run.command({ version: 1, type: "clear-all" });
  assert.equal(globalThis.__testSFramePipelineReport().rows[0].keyClearCommands, 2);
  assert.equal(JSON.stringify(result).includes("PRIVATE-MARKER"), false);
});

test("collector bounds worker inspection and treats absent or failed probes as unavailable", async () => {
  let inspected = 0;
  const worker = { evaluate: async () => { inspected++; return null; } };
  assert.deepEqual(await collectSFramePipelines({ workers: () => Array(20).fill(worker) }), { available: false, workers: [] });
  assert.equal(inspected, 4);
  assert.deepEqual(await collectSFramePipelines({ workers: () => [{ evaluate: () => { throw Error("PRIVATE-MARKER"); } }] }),
    { available: false, workers: [] });
});

test("collector has a bounded deadline for an unresponsive owned Worker", { timeout: 2000 }, async () => {
  assert.deepEqual(await collectSFramePipelines({ workers: () => [{ evaluate: () => new Promise(() => {}) }] }),
    { available: false, workers: [] });
});

test("collector returns four latest rows per Worker and preserves the bridge byte budget", async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "__testSFramePipelineReport");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "__testSFramePipelineReport", descriptor);
    else delete globalThis.__testSFramePipelineReport;
  });
  globalThis.__testSFramePipelineReport = () => ({ schema: "meet.test-sframe-pipeline.v1", total: 20,
    rows: Array.from({ length: 16 }, (_, index) => ({ index: index + 5 })) });
  const result = await collectSFramePipelines({ workers: () => Array(4).fill({ evaluate: async callback => callback() }) });
  assert.equal(result.available, true);
  assert.ok(result.workers.every(worker => worker.truncated && worker.rows.length === 4 && worker.rows[0].index === 17));
  assert.ok(JSON.stringify(result).length <= 6000);
  assert.deepEqual(await collectSFramePipelines({ workers: () => [{ evaluate: async () => ({ oversized: "x".repeat(6001) }) }] }),
    { available: false, workers: [] });
});

test("private routing modifies only the bounded SFrame asset", async () => {
  let handler;
  await installPrivateSFramePipelineRoute({ route: async (_pattern, callback) => { handler = callback; } });
  for (const body of ['addEventListener("rtctransform"); "media_envelope_version";', "unrelated worker"]) {
    let received;
    await handler({ fetch: async () => ({ text: async () => body }), fulfill: async value => { received = value.body; } });
    assert.ok(received.endsWith(body)); assert.equal(received !== body, body.includes("rtctransform"));
  }
  await assert.rejects(handler({ fetch: async () => ({ text: async () => "x".repeat(512 * 1024 + 1) }) }), /asset_budget/);
});
