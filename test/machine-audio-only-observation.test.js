import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { installMultiPublisherObservation } from "./helpers/machine-multi-publisher-observation.mjs";

async function observer({ audioElements = [], videoElements = [] } = {}) {
  const timers = [], connections = [];
  class Connection {
    listeners = [];
    receivers = [];
    constructor() { connections.push(this); }
    addEventListener(name, listener) { if (name === "track") this.listeners.push(listener); }
    getReceivers() { return this.receivers; }
    emit(track) { this.receivers.push({ track }); for (const listener of this.listeners) listener({ track }); }
  }
  class AudioContext {
    state = "running";
    sample = 0;
    destination = {};
    createMediaStreamSource(stream) { this.sample = stream.getTracks()[0].sample; return { connect() {} }; }
    createAnalyser() { return { fftSize: 32, connect() {}, getFloatTimeDomainData: pcm => pcm.fill(this.sample) }; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    async resume() {}
    async close() { this.state = "closed"; }
  }
  const window = { RTCPeerConnection: Connection, __pcs: [] };
  const document = {
    querySelectorAll: selector => selector.startsWith("#room-audio") ? audioElements : videoElements,
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {},
      getImageData: () => ({ data: [1, 2, 3, 255] }) }) }),
  };
  const context = vm.createContext({ window, document, AudioContext, Float32Array,
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } getTracks() { return this.tracks; } },
    setInterval: fn => { timers.push(fn); return timers.length; }, clearInterval() {} });
  vm.runInContext("(" + installMultiPublisherObservation.toString() + ")()", context);
  const first = new window.RTCPeerConnection(), second = new window.RTCPeerConnection();
  const tracks = [
    { kind: "audio", readyState: "live", sample: .2 },
    { kind: "audio", readyState: "live", sample: .6 },
  ];
  first.emit(tracks[0]); second.emit(tracks[1]);
  await new Promise(resolve => setImmediate(resolve));
  for (const timer of timers) timer();
  return { media: window.__multiPublisher, tracks, first, second };
}

test("audio-only observer binds exact peer tracks without requiring a camera", async () => {
  const elements = [];
  const f = await observer({ audioElements: elements });
  elements.push(...f.tracks.map((track, index) => ({ dataset: { peerId: (index ? "b" : "a").repeat(16) },
    srcObject: { getAudioTracks: () => [track] } })));
  const snapshot = f.media.snapshot(["a".repeat(16), "b".repeat(16)]);
  assert.equal(snapshot.failed, false);
  assert.deepEqual(Array.from(snapshot.publishers, item => item.audioTracks), [1, 1]);
  assert.deepEqual(Array.from(snapshot.publishers, item => item.camera), [null, null]);
  assert.equal(snapshot.publishers[0].active, 1);
  assert.ok(snapshot.publishers[0].peak < .3 && snapshot.publishers[1].peak > .5);
  assert.equal(f.media.snapshot(["c".repeat(16), "c".repeat(16)]).publishers[0].audioTracks, 0);
  await f.media.close();
});

test("existing video association remains supported and does not double-count audio", async () => {
  const audio = [], video = [];
  const f = await observer({ audioElements: audio, videoElements: video });
  const camera = { kind: "video" };
  f.first.receivers.push({ track: camera });
  const element = { srcObject: { getVideoTracks: () => [camera] }, readyState: 2, videoWidth: 10, videoHeight: 10 };
  video.push({ dataset: { peerId: "a".repeat(16), source: "camera" }, querySelector: () => element });
  audio.push({ dataset: { peerId: "a".repeat(16) }, srcObject: { getAudioTracks: () => [f.tracks[0]] } });
  assert.equal(f.media.snapshot(["a".repeat(16), "b".repeat(16)]).publishers[0].audioTracks, 1);
  audio.length = 0;
  assert.equal(f.media.snapshot(["a".repeat(16), "b".repeat(16)]).publishers[0].audioTracks, 1);
  await f.media.close();
});
