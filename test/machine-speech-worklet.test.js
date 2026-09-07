import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const code = readFileSync(new URL("../frontend/src/assets/machine-speech.worklet.js", import.meta.url), "utf8");
function processor(total = 22050, rate = 22050, frame = 0, budget = 22050 * 50) {
  const sent = []; let Processor;
  const realm = { sampleRate: rate, currentFrame: frame, ArrayBuffer, DataView, Uint8Array,
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage: value => sent.push(value) }; },
    registerProcessor: (name, value) => { assert.equal(name, "ananta-machine-speech-v1"); Processor = value; } };
  runInNewContext(code, realm);
  const audio = new Processor({ processorOptions: { totalSamples: total, budgetFrames: budget } });
  return { audio, sent, realm };
}
function pcm(samples = 441, value = 16384) {
  const data = new ArrayBuffer(samples * 2), view = new DataView(data);
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, value, true);
  return data;
}
function push(audio, startSample, data = pcm()) { audio.port.onmessage({ data: { type: "pcm", startSample, pcm: data } }); }

test("speech worklet emits exact signed little-endian PCM and wipes consumed bytes", () => {
  const { audio, sent } = processor(3), bytes = pcm(3), view = new DataView(bytes);
  view.setInt16(0, -32768, true); view.setInt16(2, 32767, true);
  push(audio, 0, bytes); const output = new Float32Array(128);
  assert.equal(audio.process([], [[output]]), false);
  assert.deepEqual([...output.slice(0, 4)], [-1, 32767 / 32768, 0.5, 0]);
  assert.equal(new Uint8Array(bytes).some(Boolean), false);
  assert.equal(sent.length, 1); assert.equal(sent[0].playedSamples, 3);
});

test("prebuffering is bounded and no samples are emitted while insufficiently filled", () => {
  const { audio, sent } = processor(); push(audio, 0);
  const output = new Float32Array(128).fill(1);
  assert.equal(audio.process([], [[output]]), true); assert.equal(output.some(Boolean), false);
  assert.equal(sent.length, 0);
  for (let i = 1; i < 5; i++) push(audio, i * 441);
  assert.equal(audio.process([], [[output]]), true); assert.equal(output[0], 0.5);
});

test("overflow and stop wipe all queued samples and never resume", () => {
  for (const overflow of [false, true]) {
    const { audio } = processor(), packets = Array.from({ length: 11 }, () => pcm());
    for (let i = 0; i < 10; i++) push(audio, i * 441, packets[i]);
    if (overflow) push(audio, 4410, packets[10]); else audio.port.onmessage({ data: { type: "stop" } });
    for (const data of packets.slice(0, overflow ? 11 : 10)) assert.equal(new Uint8Array(data).some(Boolean), false);
    push(audio, 0, packets[10]); assert.equal(new Uint8Array(packets[10]).some(Boolean), false);
    const output = new Float32Array(128).fill(1);
    assert.equal(audio.process([], [[output]]), false); assert.equal(output.some(Boolean), false);
  }
});

test("underflow fails rather than silently stretching the speech clock", () => {
  const { audio, sent } = processor();
  for (let i = 0; i < 5; i++) push(audio, i * 441);
  for (let i = 0; i < 17; i++) assert.equal(audio.process([], [[new Float32Array(128)]]), true);
  assert.equal(audio.process([], [[new Float32Array(128)]]), false);
  assert.equal(sent.at(-1).code, "meet_speech_worklet_underrun");
});

test("relative budget tolerates independent context startup clocks without extending its sample limit", () => {
  const { audio, realm, sent } = processor(441, 22050, 256, 441);
  assert.equal(sent.length, 0); push(audio, 0);
  realm.currentFrame = 256 + 441;
  assert.equal(audio.process([], [[new Float32Array(128)]]), false);
  for (const budget of [0, -1, 22050 * 50 + 1, 1.5, Infinity]) {
    assert.equal(processor(441, 22050, 256, budget).sent[0].code, "meet_speech_worklet_profile_invalid");
  }
});

test("wrong rate, audio deadline, order, format and unknown fields fail closed", () => {
  assert.equal(processor(441, 48000).sent[0].code, "meet_speech_worklet_profile_invalid");
  const expired = processor(441); push(expired.audio, 0); expired.realm.currentFrame = 22050 * 50;
  assert.equal(expired.audio.process([], [[new Float32Array(128)]]), false);
  assert.equal(expired.sent.at(-1).code, "meet_speech_worklet_expired_or_invalid");
  for (const change of [{ startSample: 1 }, { pcm: pcm(442) }, { extra: true }, { pcm: new ArrayBuffer(3) }]) {
    const { audio, sent } = processor();
    audio.port.onmessage({ data: { type: "pcm", startSample: 0, pcm: pcm(), ...change } });
    assert.equal(sent.at(-1).code, "meet_speech_worklet_input_invalid");
  }
});
