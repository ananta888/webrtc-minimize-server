import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";

for (const humanEngine of ["chromium", "firefox"]) {
  test(`${humanEngine} decoded receive-only audio finishes at an acknowledged early boundary`, { timeout: 45000 }, async t => {
    const f = await machineBrowserFixture(t, { humanEngine }), { machine, human } = f;
    assert.deepEqual(await machine.evaluate(() => window.anantaMachine.audio.segmentProbe()), {
      schema: "ananta.meet-audio-segment-probe.v1", profile: "sample-boundary-v1", supported: true });
    await machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant),
      [f.roomId, await f.grant(["audio.receive"])]);
    await human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
    assert.deepEqual(await machine.evaluate(() => window.anantaMachine.audio.sources()), []);
    await human.locator("#toggle-microphone").click();
    await human.locator('#toggle-microphone[aria-pressed="true"]').waitFor();
    await human.locator(".nav-item", { hasText: "Analyse" }).click();
    const panel = human.locator("app-machine-permissions-panel");
    await panel.getByRole("button", { name: "Für diese KI einstellen" }).click();
    await panel.getByLabel("Mein laufendes Mikrofon", { exact: true }).check();
    await panel.getByRole("button", { name: "Auswahl ausdrücklich freigeben" }).click();
    await panel.getByText("Serverbestätigung erhalten.", { exact: true }).waitFor();
    await machine.waitForFunction(() => window.anantaMachine.audio.sources().length === 1, null, { timeout: 12000 });
    const result = await machine.evaluate(async () => {
      const api = window.anantaMachine.audio;
      const subscription = await api.open(api.sources()[0].publicationId, 10);
      let samples = 0, nonzero = 0;
      const deadline = performance.now() + 6000;
      while (performance.now() < deadline) {
        for (const chunk of api.poll().chunks) {
          if (chunk.startSample !== samples || chunk.sequence !== samples / 1600 + 1) throw new Error("test_sample_discontinuity");
          const bytes = Uint8Array.from(atob(chunk.pcmBase64), c => c.charCodeAt(0)), view = new DataView(bytes.buffer);
          for (let offset = 0; offset < bytes.length; offset += 2) if (Math.abs(view.getInt16(offset, true)) > 50) nonzero++;
          samples += bytes.length / 2; bytes.fill(0); api.ack(chunk.sequence);
          if (samples === 17600) {
            const finished = api.finish(subscription.subscriptionId, samples);
            const duplicate = api.finish(subscription.subscriptionId, samples);
            await new Promise(resolve => setTimeout(resolve, 300));
            const drained = api.poll(); let replyDenied = false;
            try { api.reply(subscription.subscriptionId, "must not publish"); } catch { replyDenied = true; }
            window.__segmentSubscription = subscription.subscriptionId;
            return { samples, nonzero, schema: finished.schema, endSample: finished.endSample,
              idempotent: JSON.stringify(finished) === JSON.stringify(duplicate),
              completed: drained.completed, remainingChunks: drained.chunks.length, replyDenied,
              e2ee: window.anantaMachine.status().e2ee, captures: window.__captures, errors: window.__transformErrors };
          }
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error("test_early_segment_timeout");
    });
    assert.equal(result.samples, 17600); assert.ok(result.nonzero > 1000);
    assert.equal(result.schema, "ananta.meet-audio-segment-finished.v1"); assert.equal(result.endSample, 17600);
    assert.equal(result.idempotent, true); assert.equal(result.completed, true); assert.equal(result.remainingChunks, 0);
    assert.equal(result.replyDenied, true); assert.equal(result.e2ee, "active"); assert.equal(result.captures, 0);
    assert.deepEqual(result.errors, []);
    await panel.getByRole("button", { name: "Meine Freigaben widerrufen" }).click();
    await machine.waitForFunction(() => !window.anantaMachine.audio.status().open, null, { timeout: 3000 });
    assert.equal(await machine.evaluate(() => {
      try { window.anantaMachine.audio.finish(window.__segmentSubscription, 17600); return false; } catch { return true; }
    }), true);
    t.diagnostic(JSON.stringify({ synthetic: true, productionEvidence: false, samples: result.samples,
      nonzero: result.nonzero, earlyFinishVerified: true, receiveOnly: true, revokedFinishDenied: true }));
  });
}
