import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { machineSourceFailureObservation } from "./helpers/machine-source-failure-observation.mjs";

test("source failure projection preserves missing timing rows and bounded actual progress without source contents", () => {
  const speech = { state: "failed", generation: 3, receivedSamples: 4410, playedSamples: 2205, sourceId: "private" };
  const api = { speech: { status: () => speech }, avatar: { status: () => ({ state: "closed", generation: 5 }) },
    screen: { status: () => ({ open: false, generation: 4, sequence: 1 }) },
    timing: { snapshot: () => ({ sources: { screen: { state: "failed", private: "secret" } } }) } };
  const window = { anantaMachine: api, __speechErrors: ["meet_speech_worklet_underrun", "secret"] };
  const run = vm.runInNewContext(`(${machineSourceFailureObservation.toString()})`, { window });
  assert.deepEqual(JSON.parse(JSON.stringify(run())), {
    speech: { state: "failed", generation: 3, receivedSamples: 4410, playedSamples: 2205 },
    avatar: { state: "closed", generation: 5 }, screen: { open: false, generation: 4, sequence: 1 },
    timing: { available: true, speech: "unknown", avatar: "unknown", screen: "failed" },
    speechErrors: ["meet_speech_worklet_underrun", "unknown"],
  });
  api.timing.snapshot = () => { throw new Error("private"); };
  Object.assign(speech, { state: "private", generation: -1, receivedSamples: Infinity, playedSamples: 1000001 });
  window.__speechErrors = Array(20).fill("private");
  const value = JSON.parse(JSON.stringify(run()));
  assert.equal(value.timing.available, false); assert.equal(value.speechErrors.length, 8);
  assert.deepEqual(value.speech, { state: "unknown", generation: null, receivedSamples: null, playedSamples: null });
  assert.doesNotMatch(JSON.stringify(value), /private|secret|sourceId/);
});
