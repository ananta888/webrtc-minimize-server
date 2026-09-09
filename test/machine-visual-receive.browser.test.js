import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";
import { startSyntheticVisualPublisher, grantSyntheticVisualPublisher } from "./helpers/machine-visual-publisher.mjs";

for (const humanEngine of ["chromium", "firefox"]) for (const source of ["camera", "screen"]) {
  test(`${humanEngine} synthetic ${source} reaches only an explicitly authorized bounded visual subscription`, { timeout: 45000 }, async t => {
    const f = await machineBrowserFixture(t, { humanEngine }), { machine, human } = f;
    await machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant), [f.roomId, await f.grant(["video.receive"])]);
    await human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
    await startSyntheticVisualPublisher(human, source);
    assert.deepEqual(await machine.evaluate(() => window.anantaMachine.visual.sources()), []);
    const panel = await grantSyntheticVisualPublisher(human, source);
    await machine.waitForFunction(() => window.anantaMachine.visual.sources().length === 1, null, { timeout: 12000 });
    const result = await machine.evaluate(async () => {
      const api = window.anantaMachine.visual, selected = api.sources()[0], sub = await api.open(selected.publicationId);
      window.__visualTestSubscription = sub.subscriptionId;
      const frame = await api.frame(sub.subscriptionId);
      const bytes = Uint8Array.from(atob(frame.jpegBase64), c => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d"); context.drawImage(bitmap, 0, 0, 1, 1);
      const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
      bitmap.close(); canvas.width = canvas.height = 0; bytes.fill(0);
      let replayDenied = false;
      try { await api.frame(sub.subscriptionId); } catch { replayDenied = true; }
      return { selected, binding: sub.binding, width: frame.width, height: frame.height, rgb, replayDenied,
        captures: window.__captures, errors: window.__transformErrors, e2ee: window.anantaMachine.status().e2ee,
        audioSources: window.anantaMachine.audio.sources().length };
    });
    assert.equal(result.selected.source, source); assert.ok(result.selected.publicationEpoch > 0);
    assert.equal(result.binding.publication_epoch, result.selected.publicationEpoch);
    // The mesh may adapt camera resolution below the export ceiling. Never
    // upscale low-resolution decoded input merely to satisfy a test dimension.
    assert.ok(Number.isInteger(result.width) && result.width >= 1 && result.width <= 640);
    assert.ok(Number.isInteger(result.height) && result.height >= 1 && result.height <= 360);
    assert.ok(Math.abs(result.width / result.height - 16 / 9) < 0.02);
    const color = source === "camera" ? 0 : 1;
    assert.ok(result.rgb[color] > 130 && result.rgb[(color + 1) % 3] < 65, "decoded frame matches the selected synthetic source");
    assert.equal(result.replayDenied, true); assert.equal(result.captures, 0); assert.equal(result.audioSources, 0);
    assert.equal(result.e2ee, "active"); assert.deepEqual(result.errors, []);
    await panel.getByRole("button", { name: "Meine Freigaben widerrufen" }).click();
    await machine.waitForFunction(() => !window.anantaMachine.visual.status().open, null, { timeout: 3000 });
    assert.deepEqual(await machine.evaluate(() => window.anantaMachine.visual.sources()), []);
    assert.equal(await machine.evaluate(async () => {
      try { await window.anantaMachine.visual.frame(window.__visualTestSubscription); return false; } catch { return true; }
    }), true);
    t.diagnostic(JSON.stringify({ synthetic: true, productionEvidence: false, publisherEngine: humanEngine,
      receiverEngine: "chromium", source, width: result.width, height: result.height, rgb: result.rgb,
      exactEpoch: true, noMachineCapture: true, revokedFrameDenied: true }));
  });
}
