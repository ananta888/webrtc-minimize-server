import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";

for (const humanEngine of ["chromium", "firefox"]) {
test(`${humanEngine} decodes independent machine PCM over required SFrame without capture`, { timeout: 90000 }, async t => {
  const f = await machineBrowserFixture(t, { humanEngine, tlsPortProxy: process.env.MEET_SPEECH_PRIVATE_BROWSER_GATE === "1" }), { human, machine } = f;
  t.after(async () => { if (!machine.isClosed()) t.diagnostic(JSON.stringify(await machine.evaluate(() => ({
    speech: window.anantaMachine.speech.status(), e2ee: window.anantaMachine.status().e2ee,
    errors: window.__transformErrors, captures: window.__captures })))); });
  await machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant), [f.roomId, await f.grant(["speech.publish"])]);
  await machine.evaluate(() => {
    window.__speechErrors = [];
    const Native = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends Native { constructor(...args) {
      super(...args); this.port.addEventListener("message", ({ data }) => {
        if (data?.type === "error") window.__speechErrors.push(data.code);
      }); this.port.start();
    } };
  });
  await human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
  const source = await machine.evaluate(id => window.anantaMachine.speech.open(id, 22050 * 3), "speech:" + f.binding.sessionId);
  // Observe actual decrypted receiver PCM, not just RTP bytes. This graph has no device input.
  await human.waitForFunction(() => window.__pcs.some(pc => pc.getReceivers().some(r => r.track.kind === "audio")));
  await human.evaluate(async () => {
    const track = window.__pcs.flatMap(pc => pc.getReceivers()).find(r => r.track.kind === "audio").track;
    const context = new AudioContext(), source = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser(), quiet = context.createGain(); quiet.gain.value = 0;
    source.connect(analyser); analyser.connect(quiet); quiet.connect(context.destination); await context.resume();
    window.__speechProbe = { context, analyser, peak: 0, observations: 0 };
    window.__speechProbe.timer = setInterval(() => {
      const pcm = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(pcm);
      window.__speechProbe.peak = Math.max(window.__speechProbe.peak, ...pcm.map(Math.abs));
      if (pcm.some(v => Math.abs(v) > .05)) window.__speechProbe.observations++;
    }, 20);
  });
  const result = await machine.evaluate(async lease => {
    const speech = window.anantaMachine.speech; let offset = 0;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const state = speech.status();
      if (state.state === "completed") return state;
      if (state.state !== "open") throw new Error("test_speech_closed_early:" + state.state);
      while (offset < lease.totalSamples && offset - state.playedSamples + 441 <= lease.queueSamples) {
        const bytes = new Uint8Array(882), view = new DataView(bytes.buffer);
        for (let n = 0; n < 441; n++) view.setInt16(n * 2, Math.round(12000 * Math.sin(2 * Math.PI * 440 * (offset + n) / 22050)), true);
        speech.push(lease.generation, offset, btoa(String.fromCharCode(...bytes))); offset += 441;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("test_speech_completion_timeout");
  }, source);
  const decoded = await human.evaluate(async () => {
    const p = window.__speechProbe; clearInterval(p.timer); await p.context.close();
    return { peak: p.peak, observations: p.observations, captures: window.__captures, errors: window.__transformErrors };
  });
  assert.equal(result.playedSamples, 66150); assert.equal(result.receivedSamples, 66150);
  assert.ok(decoded.peak > .1, "remote decrypted PCM contains the synthetic tone");
  assert.ok(decoded.observations > 25, "sustained remote decoded audio, not only an initial packet");
  assert.equal(decoded.captures, 0); assert.deepEqual(decoded.errors, []);
  assert.equal(await machine.evaluate(() => window.__captures), 0);
  // A real server-confirmed renewal must retire a currently open source. A new
  // source is explicit; old generation callbacks cannot publish into it.
  const stale = await machine.evaluate(id => window.anantaMachine.speech.open(id, 22050), "speech:" + f.binding.sessionId).catch(async error => {
    t.diagnostic(JSON.stringify(await machine.evaluate(() => ({ errors: window.__speechErrors, state: window.anantaMachine.speech.status() }))));
    throw error;
  });
  await machine.evaluate(grant => window.anantaMachine.renew(grant), await f.grant(["speech.publish"]));
  await machine.waitForFunction(() => window.anantaMachine.speech.status().state === "failed");
  const fresh = await machine.evaluate(id => window.anantaMachine.speech.open(id, 22050), "speech:" + f.binding.sessionId);
  assert.equal(await machine.evaluate(gen => {
    try { window.anantaMachine.speech.push(gen, 0, btoa("\0".repeat(882))); return true; } catch { return false; }
  }, stale.generation), false);
  assert.equal(await machine.evaluate(() => window.anantaMachine.speech.status().generation), fresh.generation);
  await machine.evaluate(() => window.anantaMachine.leave());
  t.diagnostic(JSON.stringify({ synthetic: true, productionEvidence: false, ...decoded, playedSamples: result.playedSamples }));
});
}
