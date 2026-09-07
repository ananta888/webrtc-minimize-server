import assert from "node:assert/strict";
import test from "node:test";
import { verifyStandbySnapshot, verifyProductionStandby } from "../scripts/live-production-standby-gate.mjs";

const programId = "prg_aaaaaaaaaaaaaaaa", targetId = "pkr_bbbbbbbbbbbbbbbb";
const previous = { controlVersion: 1, programId, programRevision: 9, programEpoch: 2, standbyRevision: 0, standbyPackagerIds: [] };
const next = { ...previous, standbyRevision: 1, standbyPackagerIds: [targetId] };

test("standby observer accepts only committed selections in exactly the same program generation", () => {
  assert.equal(verifyStandbySnapshot(previous, null, programId, []), previous);
  assert.equal(verifyStandbySnapshot(next, previous, programId, [targetId]), next);
  assert.equal(verifyStandbySnapshot({ ...next, standbyRevision: 2, standbyPackagerIds: [] }, next, programId, []).standbyRevision, 2);
});

test("standby observer fails for stale, unrelated, excessive or permissive responses without raw payload logs", () => {
  for (const value of [
    { ...next, programId: "prg_cccccccccccccccc" }, { ...next, programRevision: 10 },
    { ...next, programEpoch: 3 }, { ...next, standbyRevision: 0 }, { ...next, standbyRevision: 2 },
    { ...next, standbyPackagerIds: [] }, { ...next, standbyPackagerIds: [targetId, targetId] },
    { ...next, token: "SECRET-CANARY" },
  ]) {
    assert.throws(() => verifyStandbySnapshot(value, previous, programId, [targetId]), error => {
      assert.ok(!String(error).includes("SECRET-CANARY"));
      assert.ok(!String(error).includes(targetId));
      return true;
    });
  }
});

function fixture({ changeCapture = false, rejectWrite = false, missingWrite = false } = {}) {
  let selected = false, evaluations = 0, responseIndex = 0;
  const keys = [], reports = [], listeners = new Map();
  const snapshots = [previous, next, { ...next, standbyRevision: 2, standbyPackagerIds: [] }, { ...next, standbyRevision: 3 }];
  const owner = {
    url: () => "https://webrtc.example/",
    evaluate: async () => ({ capture: changeCapture && ++evaluations > 1 ? ["camera"] : [], connections: 1 }),
    waitForResponse: async predicate => {
      const index = responseIndex++;
      const response = {
        url: () => `https://webrtc.example/api/broadcasts/${programId}/${index ? "native-standbys" : "native-standby-control"}`,
        request: () => ({ method: () => index ? "PUT" : "POST", url: () => response.url() }),
        status: () => rejectWrite && index ? 409 : 200, json: async () => snapshots[index],
      };
      assert.equal(predicate(response), true);
      assert.equal(predicate({ ...response, url: () => response.url().replace("webrtc.example", "foreign.example"),
        request: () => ({ method: () => index ? "PUT" : "POST", url: () => response.url().replace("webrtc.example", "foreign.example") }) }), false);
      if (missingWrite && index) {
        listeners.get("request")?.(response.request());
        listeners.get("requestfailed")?.({ ...response.request(), failure: () => ({ errorText: "net::ERR_NETWORK_CHANGED" }) });
        throw new Error("SECRET-CANARY");
      }
      return response;
    },
    once: (event, handler) => { assert.equal(event, "dialog"); handler({ accept: async () => {} }); },
    on: (event, listener) => listeners.set(event, listener), off: event => listeners.delete(event),
    locator: selector => ({
      waitFor: async () => { assert.equal(selector, "#broadcast-standby-save:not([disabled])"); },
      allTextContents: async () => [],
      focus: async () => {}, press: async key => { keys.push(key); if (selector.startsWith("[data-standby-id=")) selected = !selected; },
      isChecked: async () => selected, filter: () => ({ waitFor: async () => {} }),
    }),
  };
  return { args: { owner, targetId, programCreates: () => 1, report: value => reports.push(value) }, keys, reports, listeners };
}

test("standby UI observer requires all three keyboard commits before reporting its narrow result", async () => {
  const f = fixture(); await verifyProductionStandby(f.args);
  assert.deepEqual(f.keys, ["Enter", "Space", "Enter", "Space", "Enter", "Space", "Enter"]);
  assert.equal(f.reports.length, 1);
  assert.equal(f.listeners.size, 0);
});

for (const fault of ["changeCapture", "rejectWrite"]) {
  test(`standby UI observer cannot report success after ${fault}`, async () => {
    const f = fixture({ [fault]: true });
    await assert.rejects(verifyProductionStandby(f.args));
    assert.deepEqual(f.reports, []);
  });
}

test("missing standby response preserves only bounded failure evidence and removes listeners", async () => {
  const f = fixture({ missingWrite: true });
  await assert.rejects(verifyProductionStandby(f.args), error => {
    assert.match(error.message, /request=true:dialog=true:transport=net::ERR_NETWORK_CHANGED/);
    assert.ok(!error.message.includes("SECRET-CANARY")); assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(f.reports, []); assert.equal(f.listeners.size, 0);
});
