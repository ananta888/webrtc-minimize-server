import assert from "node:assert/strict";
import test from "node:test";
import { chromium, firefox } from "playwright";
import { installDialogObservation } from "./helpers/machine-dialog-observer.mjs";

for (const [name, engine] of Object.entries({ chromium, firefox })) {
  test(`${name} retains native unconnected-chat rejection and emits counts only`, { timeout: 30000 }, async t => {
    const browser = await engine.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.evaluate(installDialogObservation);
    const result = await page.evaluate(async () => {
      const peer = new RTCPeerConnection(), channel = peer.createDataChannel("chat");
      let rejected = false;
      try {
        try {
          channel.send(JSON.stringify({ version: 2, type: "chat", roomId: "room-" + "a".repeat(18),
            membershipEpoch: 1, messageId: "b".repeat(32), replyTo: "", sentAt: Date.now(),
            text: "SYNTHETIC_PRIVATE_QUESTION" }));
        } catch (error) { rejected = error.name === "InvalidStateError"; }
        return { rejected, probe: window.__dialogObservation.chatStatus() };
      } finally { peer.close(); await window.__dialogObservation.close(); }
    });
    assert.deepEqual(result, { rejected: true, probe: { attempted: 1, queued: 0, send_failures: 1,
      answer_seen: false, rendered: false } });
    assert.equal(JSON.stringify(result).includes("SYNTHETIC_PRIVATE_QUESTION"), false);
  });
}
