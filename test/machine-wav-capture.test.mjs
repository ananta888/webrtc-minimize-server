import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startSyntheticAudioPublisher } from "./helpers/machine-audio-publisher.mjs";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject }; };

async function fixture(t, { source = "microphone", decode, resume, failAt, duration = 2, channels = 1 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meet-wav-lifecycle-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "synthetic.wav"), bytes = Buffer.alloc(44);
  bytes.write("RIFF"); bytes.write("WAVE", 8); await fs.writeFile(file, bytes);
  const pageEvents = new EventTarget(), contexts = [], canvases = [], tracks = [];
  const window = {}, navigator = { mediaDevices: {} }, clicks = [];
  const track = kind => {
    const value = new EventTarget(); value.kind = kind; value.readyState = "live"; value.stops = 0;
    value.stop = () => { value.stops++; value.readyState = "ended";
      if (failAt === "track-stop") throw new Error("private synthetic detail"); };
    // Native stop deliberately emits NO ended event.
    tracks.push(value); return value;
  };
  class AudioContext {
    constructor() { this.state = "suspended"; this.closed = 0; this.players = []; this.currentTime = 7; contexts.push(this); }
    get destination() { assert.fail("WAV fixture must never access a speaker"); }
    async decodeAudioData() {
      if (failAt === "decode") throw new Error("private synthetic detail");
      if (decode) await decode.promise;
      return { duration, numberOfChannels: channels };
    }
    createBufferSource() {
      if (failAt === "buffer-source") throw new Error("private synthetic detail");
      const player = { stops: 0, disconnects: 0, starts: [],
        connect: target => { assert.equal(target, this.output); },
        start: at => { player.starts.push(at); if (failAt === "start") throw new Error("private synthetic detail"); },
        stop: () => { player.stops++; if (failAt === "player-stop") throw new Error("private synthetic detail"); },
        disconnect: () => { player.disconnects++; if (failAt === "disconnect") throw new Error("private synthetic detail"); } };
      this.players.push(player); return player;
    }
    createMediaStreamDestination() {
      if (failAt === "destination") throw new Error("private synthetic detail");
      const owned = [track("audio")];
      this.output = { disconnects: 0, disconnect() { this.disconnects++; }, stream: {
        getTracks: () => [...owned], getAudioTracks: () => owned.filter(x => x.kind === "audio"),
        getVideoTracks: () => owned.filter(x => x.kind === "video"), addTrack: value => owned.push(value),
      } }; return this.output;
    }
    async resume() { if (failAt === "resume") throw new Error("private synthetic detail");
      if (resume) await resume.promise; if (this.state !== "closed") this.state = "running"; }
    close() { this.closed++; this.state = "closed";
      if (failAt === "context-close") return Promise.reject(new Error("private synthetic detail")); return Promise.resolve(); }
  }
  const document = { createElement: name => {
    assert.equal(name, "canvas"); const canvas = { width: 0, height: 0,
      getContext: () => failAt === "canvas-context" ? null : { fillRect() {} },
      captureStream: fps => { assert.equal(fps, 1); return { getVideoTracks: () => [track("video")] }; },
    }; canvases.push(canvas); return canvas;
  } };
  const page = {
    evaluate: (fn, input) => runInNewContext(`(${fn.toString()})(input)`, {
      input, window, navigator, AudioContext, document,
      atob: value => Buffer.from(value, "base64").toString("binary"),
      addEventListener: pageEvents.addEventListener.bind(pageEvents),
    }, { timeout: 100 }),
    locator: selector => ({ click: async () => { clicks.push(selector); }, check: async () => {}, waitFor: async () => {} }),
  };
  await startSyntheticAudioPublisher(page, source, file);
  t.after(() => pageEvents.dispatchEvent(new Event("pagehide")));
  return { contexts, tracks, canvases, window, clicks,
    capture: () => source === "microphone" ? navigator.mediaDevices.getUserMedia({ audio: true })
      : navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
    hide: () => pageEvents.dispatchEvent(new Event("pagehide")),
  };
}

for (const source of ["microphone", "screen-audio"]) {
  test(`WAV ${source} explicit stop owns all tracks, players and context without ended`, async t => {
    const f = await fixture(t, { source }); assert.equal(f.contexts.length, 0);
    assert.ok(f.clicks.includes(`#toggle-${source === "microphone" ? "microphone" : "screen"}`));
    const stream = await f.capture(), audio = f.contexts[0];
    const speak = f.window.__startSyntheticReceiveSpeech; speak(); speak();
    assert.ok(audio.players.every(player => player.starts[0] === 8));
    const stopTrack = source === "microphone" ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
    stopTrack.stop(); stopTrack.stop(); f.hide();
    assert.equal(audio.closed, 1); assert.equal(f.window.__startSyntheticReceiveSpeech, null);
    for (const track of stream.getTracks()) { assert.equal(track.readyState, "ended"); assert.equal(track.stops, 1); }
    for (const player of audio.players) { assert.equal(player.stops, 1); assert.equal(player.disconnects, 1); }
    assert.ok(audio.players.every(player => player.buffer === null && player.onended === null));
    assert.equal(audio.output.disconnects, 1);
    if (source === "screen-audio") assert.deepEqual([f.canvases[0].width, f.canvases[0].height], [0, 0]);
    assert.throws(speak, /test_audio_speech_budget_exhausted/);
  });
}

test("WAV natural utterance end does not stop capture; stale track callbacks cannot clear its successor", async t => {
  const f = await fixture(t), stream = await f.capture(), oldSpeak = f.window.__startSyntheticReceiveSpeech;
  oldSpeak(); const player = f.contexts[0].players[0], ended = player.onended; ended(); ended();
  assert.equal(f.contexts[0].closed, 0); assert.equal(player.disconnects, 1);
  stream.getAudioTracks()[0].dispatchEvent(new Event("ended"));
  const successor = await f.capture(), nextSpeak = f.window.__startSyntheticReceiveSpeech;
  stream.getAudioTracks()[0].dispatchEvent(new Event("ended")); stream.getAudioTracks()[0].stop();
  assert.equal(f.window.__startSyntheticReceiveSpeech, nextSpeak);
  assert.equal(successor.getAudioTracks()[0].readyState, "live"); assert.equal(f.contexts[1].closed, 0);
  assert.throws(oldSpeak, /test_audio_speech_budget_exhausted/); f.hide(); assert.equal(f.contexts[1].closed, 1);
});

for (const phase of ["decode", "resume"]) {
  test(`WAV page teardown fences pending ${phase}, stops allocation and denies later capture`, async t => {
    const pendingPhase = deferred(), f = await fixture(t, { source: "screen-audio", [phase]: pendingPhase });
    const pending = f.capture(); await new Promise(resolve => setImmediate(resolve));
    f.hide(); assert.equal(f.contexts[0].closed, 1);
    pendingPhase.resolve(); await assert.rejects(pending, /test_audio_source_unavailable/);
    await assert.rejects(f.capture(), /test_audio_source_unavailable/);
    assert.equal(f.contexts.length, 1); assert.equal(f.contexts[0].closed, 1);
    assert.equal(f.window.__startSyntheticReceiveSpeech ?? null, null);
    if (phase === "decode") { assert.equal(f.tracks.length, 0); assert.equal(f.canvases.length, 0); }
    else for (const track of f.tracks) assert.equal(track.stops, 1);
  });
}

test("WAV concurrent or duplicate capture cannot allocate a second graph", async t => {
  const decode = deferred(), f = await fixture(t, { decode }), pending = f.capture();
  const rejected = assert.rejects(f.capture(), /test_audio_source_unavailable/);
  decode.resolve(); await rejected; assert.equal(f.contexts.length, 1); const stream = await pending;
  await assert.rejects(f.capture(), /test_audio_source_unavailable/);
  stream.getAudioTracks()[0].stop(); await f.capture(); assert.equal(f.contexts.length, 2); f.hide();
});

test("WAV retains the three explicitly invoked utterance budget without closing the ongoing source", async t => {
  const f = await fixture(t); await f.capture(); const speak = f.window.__startSyntheticReceiveSpeech;
  for (let i = 0; i < 3; i++) speak();
  assert.throws(speak, /test_audio_speech_budget_exhausted/); assert.equal(f.contexts[0].players.length, 3);
  assert.equal(f.contexts[0].closed, 0); f.hide(); assert.equal(f.contexts[0].closed, 1);
});

test("WAV pagehide before capture allocates no graph and forbids later activation", async t => {
  const f = await fixture(t); f.hide();
  await assert.rejects(f.capture(), /test_audio_source_unavailable/);
  assert.equal(f.contexts.length, 0); assert.equal(f.tracks.length, 0);
});

test("WAV pending resume cannot reinstall an old speech callback after explicit stop", async t => {
  const resume = deferred(), f = await fixture(t, { resume }), pending = f.capture();
  await new Promise(resolve => setImmediate(resolve));
  f.tracks[0].stop(); assert.equal(f.contexts[0].closed, 1);
  resume.resolve(); await assert.rejects(pending, /test_audio_source_unavailable/);
  assert.equal(f.window.__startSyntheticReceiveSpeech ?? null, null);
  await f.capture(); const nextSpeak = f.window.__startSyntheticReceiveSpeech;
  f.tracks[0].stop(); assert.equal(f.window.__startSyntheticReceiveSpeech, nextSpeak);
  assert.equal(f.contexts[1].closed, 0);
});

for (const failAt of ["decode", "buffer-source", "destination", "canvas-context", "resume"]) {
  test(`WAV ${failAt} failure cleans partial setup without revealing exception details`, async t => {
    const f = await fixture(t, { source: "screen-audio", failAt });
    await assert.rejects(f.capture(), /test_audio_source_unavailable/);
    assert.equal(f.contexts[0].closed, 1); for (const track of f.tracks) assert.equal(track.stops, 1);
    f.hide(); assert.equal(f.contexts[0].closed, 1);
  });
}

for (const failAt of ["track-stop", "player-stop", "disconnect", "context-close", "start"]) {
  test(`WAV cleanup remains bounded after ${failAt} failure`, async t => {
    const f = await fixture(t, { source: "screen-audio", failAt }), stream = await f.capture();
    if (failAt === "start") assert.throws(() => f.window.__startSyntheticReceiveSpeech(), /test_audio_source_unavailable/);
    else f.window.__startSyntheticReceiveSpeech();
    assert.doesNotThrow(() => stream.getAudioTracks()[0].stop()); await Promise.resolve(); f.hide();
    assert.equal(f.contexts[0].closed, 1); assert.equal(f.window.__startSyntheticReceiveSpeech, null);
    for (const track of f.tracks) assert.equal(track.stops, 1);
    assert.deepEqual([f.canvases[0].width, f.canvases[0].height], [0, 0]);
  });
}

for (const options of [{ duration: 0.5 }, { duration: 9 }, { duration: NaN }, { channels: 2 }]) {
  test(`WAV decoded bounds ${JSON.stringify(options)} fail closed`, async t => {
    const f = await fixture(t, options); await assert.rejects(f.capture(), /test_audio_fixture_invalid/);
    assert.equal(f.contexts[0].closed, 1); assert.equal(f.tracks.length, 0);
  });
}
