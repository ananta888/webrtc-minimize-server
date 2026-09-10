import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { activeDialogObservation } from "./helpers/machine-active-dialog.mjs";

function observe(error, open = false) {
  let reads = 0;
  const window = {
    __activeDialog: { samples: 16000, nonzero: 15000, screenFrames: 3, failed: false,
      audioClosed: !open, screenClosed: false, jpeg: "private-media-canary" },
    anantaMachine: {
      audio: { status: () => { reads++; return { open, completed: false, error, token: "private-token-canary" }; } },
      chat: { status: () => ({ open: true }) }, screen: { status: () => ({ open: true }) },
    },
  };
  // Same closed callback shape as Playwright evaluate, with no browser or media.
  const value = JSON.parse(JSON.stringify(vm.runInNewContext(`(${activeDialogObservation.toString()})()`, { window })));
  assert.equal(reads, 1);
  assert.doesNotMatch(JSON.stringify(value), /private-/);
  return value;
}

test("active dialog observation preserves received-media evidence and snapshots audio once", () => {
  assert.deepEqual(observe("", true), { samples: 16000, nonzero: 15000, screenFrames: 3,
    failed: false, audioOpen: true, audioCompleted: false, audioError: "none", chatOpen: true,
    screenOpen: true, audioClosed: false, screenClosed: false });
});

test("active dialog observation distinguishes only known fixed audio failures", () => {
  for (const code of ["meet_audio_setup_timeout", "meet_audio_decoder_failed", "meet_audio_open_failed",
    "meet_audio_binding_changed", "meet_audio_queue_or_timeline_invalid", "meet_audio_finish_failed"]) {
    const value = observe(code);
    assert.equal(value.audioError, code); assert.equal(value.audioOpen, false);
    assert.equal(value.samples, 16000); assert.equal(value.screenOpen, true);
  }
});

test("unknown audio errors cannot leak contents or masquerade as a healthy observation", () => {
  for (const error of [undefined, null, {}, { message: "private-error-canary" }, "private-token-canary",
    "meet_audio_binding_changed private-detail", 0]) assert.equal(observe(error).audioError, "unknown");
});
