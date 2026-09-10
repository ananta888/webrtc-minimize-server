import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { installMachineSyntheticCapture } from "./helpers/machine-synthetic-capture.mjs";

function fixture({ machine = false, failAt, resume } = {}) {
  const page = new EventTarget(), contexts = [], window = { __captures: 0 }, navigator = { mediaDevices: {} };
  class AudioContext {
    constructor() {
      contexts.push(this); this.closed = 0; this.disconnected = 0; this.stopped = 0; this.nativeStops = 0;
      const track = this.track = new EventTarget(); track.readyState = "live";
      // Match explicit native stop: no ended event is dispatched.
      track.stop = () => { this.nativeStops++; track.readyState = "ended"; if (failAt === "stop") throw new Error("synthetic_stop"); };
      this.stream = { getAudioTracks: () => [track] };
      this.oscillator = { frequency: { value: 0 }, connect: target => { assert.equal(target, this.output); },
        start: () => { if (failAt === "start") throw new Error("synthetic_start"); },
        stop: () => { this.stopped++; }, disconnect: () => { this.disconnected++; } };
      this.output = { stream: this.stream, disconnect: () => { this.disconnected++; } };
    }
    get destination() { assert.fail("test tone must not access a speaker destination"); }
    createOscillator() { return this.oscillator; }
    createMediaStreamDestination() { if (failAt === "destination") throw new Error("synthetic_destination"); return this.output; }
    resume() { return failAt === "resume" ? Promise.reject(new Error("synthetic_resume")) : resume?.() || Promise.resolve(); }
    close() { this.closed++; return failAt === "close" ? Promise.reject(new Error("synthetic_close")) : Promise.resolve(); }
  }
  // Exercise the exact serialized standalone function used by addInitScript,
  // with fake contexts/tracks only: never launch a browser or an audio service.
  runInNewContext(`(${installMachineSyntheticCapture.toString()})({machine:${machine}})`, {
    navigator, window, AudioContext, addEventListener: page.addEventListener.bind(page),
  }, { timeout: 100 });
  return { contexts, window, media: navigator.mediaDevices, hide: () => page.dispatchEvent(new Event("pagehide")) };
}

test("install and machine/display/camera denial never allocate an audio graph", async () => {
  for (const machine of [false, true]) {
    const f = fixture({ machine }); assert.equal(f.contexts.length, 0);
    assert.throws(() => f.media.getDisplayMedia({ audio: true, video: true }), /human_display_forbidden/);
    for (const constraints of [undefined, {}, { audio: false }, { audio: true, video: true }, ...(machine ? [{ audio: true }] : [])]) {
      await assert.rejects(f.media.getUserMedia(constraints), /human_capture_forbidden/);
    }
    assert.equal(f.contexts.length, 0); assert.ok(f.window.__captures > 0);
  }
});

test("explicit track stop closes and disconnects its graph once without an ended event", async () => {
  const f = fixture();
  const stream = await f.media.getUserMedia({ audio: true });
  const track = stream.getAudioTracks()[0], audio = f.contexts[0];
  assert.equal(audio.oscillator.frequency.value, 440); assert.equal(audio.closed, 0);
  track.stop(); track.stop(); track.dispatchEvent(new Event("ended")); f.hide();
  assert.equal(audio.closed, 1); assert.equal(audio.nativeStops, 1);
  assert.equal(audio.stopped, 1); assert.equal(audio.disconnected, 2);
  assert.equal(track.readyState, "ended");
});

test("natural end cleans the old source without touching a replacement", async () => {
  const f = fixture();
  const first = (await f.media.getUserMedia({ audio: true })).getAudioTracks()[0];
  first.dispatchEvent(new Event("ended"));
  const second = (await f.media.getUserMedia({ audio: true })).getAudioTracks()[0];
  first.stop(); first.dispatchEvent(new Event("ended"));
  assert.equal(f.contexts[0].closed, 1); assert.equal(f.contexts[1].closed, 0);
  assert.equal(second.readyState, "live"); f.hide();
  assert.equal(f.contexts[1].closed, 1);
});

test("page teardown fences a pending resume and denies any later capture", async () => {
  let resolve;
  const f = fixture({ resume: () => new Promise(done => { resolve = done; }) });
  const pending = f.media.getUserMedia({ audio: true }); f.hide();
  assert.equal(f.contexts[0].closed, 1); assert.equal(f.contexts[0].track.readyState, "ended");
  resolve(); await assert.rejects(pending, /test_audio_source_unavailable/);
  await assert.rejects(f.media.getUserMedia({ audio: true }), /human_capture_forbidden/);
  assert.equal(f.contexts.length, 1); assert.equal(f.contexts[0].closed, 1);
});

for (const failAt of ["destination", "start", "resume"]) test(`failed ${failAt} cannot leak an owned context`, async () => {
  const f = fixture({ failAt });
  await assert.rejects(f.media.getUserMedia({ audio: true }), /test_audio_source_unavailable/);
  assert.equal(f.contexts[0].closed, 1); assert.equal(f.contexts[0].stopped, 1);
  if (failAt !== "destination") assert.equal(f.contexts[0].track.readyState, "ended");
  f.hide(); assert.equal(f.contexts[0].closed, 1);
});

for (const failAt of ["stop", "close"]) test(`cleanup continues safely after ${failAt} failure`, async () => {
  const f = fixture({ failAt }), track = (await f.media.getUserMedia({ audio: true })).getAudioTracks()[0];
  assert.doesNotThrow(() => track.stop()); await Promise.resolve();
  assert.equal(f.contexts[0].stopped, 1); assert.equal(f.contexts[0].disconnected, 2);
  assert.equal(f.contexts[0].closed, 1); f.hide(); assert.equal(f.contexts[0].closed, 1);
});
