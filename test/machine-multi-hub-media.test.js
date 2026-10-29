import assert from "node:assert/strict";
import test from "node:test";
import { multiHubMedia } from "./helpers/machine-multi-hub-media.mjs";

const peers = ["a".repeat(16), "b".repeat(16)];

async function fixture(values = []) {
  const observed = [];
  const page = {
    async evaluate(fn, arg) {
      if (arg === undefined) return; // Private observer installation/cleanup only.
      assert.deepEqual(arg, peers); observed.push(fn.toString());
      assert.ok(values.length, "fixture must not run an unbounded observation");
      return values.shift();
    },
    locator() { return { filter() { return { async click() {} }; } }; },
  };
  return { media: await multiHubMedia({ human: page }), observed };
}

test("multi-Worker bridge rejects unknown actions and fields before UI effects", async () => {
  const { media, observed } = await fixture();
  for (const input of [
    { command: "grant" }, { command: "ask", text: "untrusted" },
    { command: "consent", publisher: 2, enabled: true },
    { command: "consent", publisher: "0", enabled: true },
    { command: "consent", publisher: 0, enabled: 1 },
    { command: "media", phase: "unknown" },
    { command: "media", phase: "avatars", override: true },
  ]) await assert.rejects(media.command(input, peers), /test_multi_media_command_invalid/);
  assert.deepEqual(observed, []); await media.close();
});

test("simultaneous audio needs three consecutive fresh two-source observations", async () => {
  const f = await fixture([[true, false], [true, true], [true, false], [true, true], [true, true], [true, true]]);
  assert.deepEqual(await f.media.command({ command: "media", phase: "both-speech" }, peers),
    { audio: "both", consecutive: 3 });
  assert.equal(f.observed.length, 6);
  assert.ok(f.observed.every(source => source.includes(".active(")));
  await f.media.close();
});

test("first-source observation does not require or falsely claim a second voice", async () => {
  const f = await fixture([[true, false], [true, false], [true, false]]);
  assert.deepEqual(await f.media.command({ command: "media", phase: "first-speech" }, peers),
    { audio: "first", consecutive: 3 });
  assert.equal(f.observed.length, 3); await f.media.close();
});

test("revoked first image must actually disappear while the other identity retains blue", async () => {
  const second = { camera: [20, 20, 220], screen: [1, 2, 3] };
  const f = await fixture([
    { failed: false, publishers: [{ camera: [220, 20, 20], screen: [1, 2, 3] }, second] },
    { failed: false, publishers: [{ camera: null, screen: [1, 2, 3] }, second] },
  ]);
  assert.deepEqual(await f.media.command({ command: "media", phase: "first-revoked" }, peers),
    { personas: [null, "blue"], screens: [true, true] });
  assert.equal(f.observed.length, 2); await f.media.close();
});

test("legacy positive consent command observes Hub rights without issuing a grant", async () => {
  const actions = [];
  const article = { getByText() { return { async waitFor() { actions.push("observe"); } }; } };
  const panel = { locator() { return { filter() { return article; } }; } };
  const human = { async evaluate() {}, locator(selector) {
    if (selector === "app-machine-permissions-panel") return panel;
    return { async click() { actions.push("navigate"); } };
  } };
  const media = await multiHubMedia({ human });
  assert.deepEqual(await media.command({ command: "consent", publisher: 1, enabled: true }, peers),
    { consent: 1, enabled: true });
  assert.deepEqual(actions, ["navigate", "observe"]);
  assert.deepEqual(media.diagnostic(), { step: "idle", publisher: null });
  await assert.rejects(media.command({ command: "consent", publisher: 1, enabled: false }, peers),
    /test_hub_receive_revocation_required/);
  assert.deepEqual(actions, ["navigate", "observe"]);
  await media.close();
});

test("failed consent diagnostic contains only a closed step and publisher index", async () => {
  const failure = new Error("private operator message must not enter the diagnostic");
  const media = await multiHubMedia({ human: {
    async evaluate() {}, locator() { return { async click() { throw failure; } }; },
  } });
  await assert.rejects(media.command({ command: "consent", publisher: 0, enabled: true }, peers), error => error === failure);
  const snapshot = media.diagnostic();
  assert.deepEqual(snapshot, { step: "consent-navigation", publisher: 0 });
  snapshot.step = "changed";
  assert.deepEqual(media.diagnostic(), { step: "consent-navigation", publisher: 0 });
  await media.close();
});

test("floor start waits for decoded screen rendering before pinning audio connections", async () => {
  const steps = []; const ready = [false, true];
  const media = await multiHubMedia({ human: {
    async evaluate(fn, arg) {
      if (arg === undefined) return;
      assert.deepEqual(arg, peers);
      if (fn.name === "installSpeakerFloorObservation") {
        assert.equal(ready.length, 0); steps.push("pin"); return;
      }
      steps.push("render"); return ready.shift();
    },
    locator() { return { filter() { return { async click() { steps.push("navigate"); } }; } }; },
  } });
  assert.deepEqual(await media.command({ command: "floor-start" }, peers), { observing: true });
  assert.deepEqual(steps, ["navigate", "render", "render", "pin"]);
  await media.close();
});

test("floor result requires both actual turns and a stable final quiet window", async () => {
  const state = { failed: false, overlap: 0, counts: [3, 3], active: [false, false], quiet_ms: 300 };
  const samples = [{ ...state, counts: [3, 0] }, { ...state, quiet_ms: 20 }, state];
  let reads = 0;
  const media = await multiHubMedia({ human: { locator() { return {
    getByText() { return { nth() { return { async waitFor(options) { assert.equal(options.timeout, 25000); } }; } }; },
  }; }, async evaluate(fn) {
    if (fn.toString().includes("__speakerFloor.snapshot")) { reads++; return samples.shift(); }
  } } });
  assert.deepEqual(await media.command({ command: "floor-result" }, peers), state);
  assert.equal(reads, 3); await media.close();
});

for (const bad of [{ failed: true, overlap: 0 }, { failed: false, overlap: 1 }]) {
  test(`floor result never accepts an incomplete observation or overlap: ${JSON.stringify(bad)}`, async () => {
    const media = await multiHubMedia({ human: { locator() { return {
      getByText() { return { nth() { return { async waitFor() {} }; } }; },
    }; }, async evaluate(fn) {
      if (fn.toString().includes("__speakerFloor.snapshot")) return bad;
    } } });
    await assert.rejects(media.command({ command: "floor-result" }, peers), /test_floor_observation_failed/);
    await media.close();
  });
}
