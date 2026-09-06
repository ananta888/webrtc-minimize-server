import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const code = readFileSync(new URL("../frontend/src/assets/machine-audio.worklet.js", import.meta.url), "utf8");
function processor(rate = 16000) {
  const sent = []; let Processor;
  runInNewContext(code, { sampleRate: rate, ArrayBuffer, DataView, Float32Array, Uint8Array,
    AudioWorkletProcessor: class { port = { postMessage: data => sent.push(data), onmessage: null }; },
    registerProcessor: (name, value) => { assert.equal(name, "ananta-machine-pcm-v1"); Processor = value; } });
  return { audio: new Processor(), sent };
}
test("worklet emits true mono PCM16 little endian in exactly 100ms chunks", () => {
  const { audio, sent } = processor(), samples = new Float32Array(1600).fill(0.5);
  samples[0] = -1; samples[1] = 1; samples[2] = -2; samples[3] = 2;
  assert.equal(audio.process([[samples]]), true);
  assert.equal(sent.length, 1); assert.equal(sent[0].pcm.byteLength, 3200); assert.equal(sent[0].startSample, 0);
  const view = new DataView(sent[0].pcm);
  assert.deepEqual([0, 2, 4, 6, 8].map(at => view.getInt16(at, true)), [-32768, 32767, -32768, 32767, 16384]);
  audio.port.onmessage({ data: { type: "ack", startSample: 0 } });
  audio.process([[samples]]); assert.equal(sent[1].startSample, 1600);
});
test("worklet stops with one outstanding chunk rather than accumulating messages", () => {
  const { audio, sent } = processor(), samples = new Float32Array(1600);
  audio.process([[samples]]); assert.equal(audio.process([[samples]]), false);
  assert.equal(sent.filter(item => item.type === "pcm").length, 1);
  assert.equal(sent.at(-1).code, "meet_audio_backpressure");
  assert.equal(audio.process([[samples]]), false); assert.equal(sent.length, 2);
});
test("worklet rejects wrong rate, nonfinite samples, extra channels and mismatched ACK", () => {
  for (const [rate, samples, expected] of [[48000, [new Float32Array(1)], "meet_audio_rate_unsupported"],
    [16000, [new Float32Array([NaN])], "meet_audio_sample_invalid"],
    [16000, [new Float32Array(1), new Float32Array(1)], "meet_audio_channels_invalid"]]) {
    const { audio, sent } = processor(rate); assert.equal(audio.process([samples]), false); assert.equal(sent.at(-1).code, expected);
  }
  const { audio, sent } = processor(); audio.port.onmessage({ data: { type: "ack", startSample: 0 } });
  assert.equal(sent.at(-1).code, "meet_audio_ack_invalid");
});
