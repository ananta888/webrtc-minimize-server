import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "../test/helpers/machine-browser-fixture.js";
import { decodedCompanionScreen } from "../test/helpers/machine-avatar-coexistence.mjs";
import { startActiveDialog, activeDialogObservation } from "../test/helpers/machine-active-dialog.mjs";
import { waitFixtureValue } from "../test/helpers/machine-browser-wait.mjs";

const seconds = Number(process.env.MACHINE_AUDIO_CHAT_SOAK_SECONDS || 0);
if (process.env.MACHINE_AUDIO_CHAT_SOAK_SECONDS !== undefined
  && (!Number.isInteger(seconds) || seconds < 300 || seconds > 7200)) {
  throw new Error("machine_audio_chat_soak_duration_invalid");
}

test("isolated machine audio/chat/screen soak with PCM, chat ACK and bounded stop", {
  skip: !seconds && "Set MACHINE_AUDIO_CHAT_SOAK_SECONDS=300..7200; no long test starts implicitly",
  timeout: (seconds + 90) * 1000,
}, async t => {
  const f = await machineBrowserFixture(t, { lifetimeSeconds: seconds + 180 });
  const { human, machine } = f;
  t.after(async () => {
    if (!machine.isClosed()) await machine.evaluate(async () => {
      await window.__activeDialog?.stop();
      window.anantaMachine.audio.close(); window.anantaMachine.chat.close(); window.anantaMachine.screen.close();
    });
  });
  const caps = ["audio.receive", "chat.read", "chat.send", "screen.publish"];
  await machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant), [f.roomId, await f.grant(caps)]);
  await human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
  await human.locator("#toggle-microphone").click();
  await human.locator('#toggle-microphone[aria-pressed="true"]').waitFor();
  await human.locator(".nav-item", { hasText: "Analyse" }).click();
  const panel = human.locator("app-machine-permissions-panel");
  await panel.getByRole("button", { name: "Für diese KI einstellen" }).click();
  await panel.getByLabel("Mein laufendes Mikrofon", { exact: true }).check();
  await panel.getByLabel("Meine neuen Chatbeiträge", { exact: true }).check();
  await panel.getByRole("button", { name: "Auswahl ausdrücklich freigeben" }).click();
  await panel.getByText("Serverbestätigung erhalten.", { exact: true }).waitFor();
  await machine.waitForFunction(() => window.anantaMachine.audio.sources().length === 1, null, { timeout: 12_000 });
  const cdp = await machine.context().newCDPSession(machine);
  const initialHeap = (await cdp.send("Runtime.getHeapUsage")).usedSize;
  const initial = await machine.evaluate(() => window.anantaMachine.status().lease);
  const started = performance.now(), deadline = started + seconds * 1000;
  let phases = 0, renewals = 0, chatAcks = 0, lastRenew = started, peakHeap = initialHeap, expired = false;
  while (performance.now() < deadline) {
    if (Date.now() >= initial.absoluteExpiresAt - 2000) {
      await machine.waitForFunction(() => !window.anantaMachine.status().joined, null, { timeout: 5000 });
      expired = true; break;
    }
    if (performance.now() - lastRenew >= 60_000) {
      const before = await machine.evaluate(() => window.anantaMachine.status().lease);
      await machine.evaluate(grant => window.anantaMachine.renew(grant), await f.grant(caps, 2, {
        expiresAt: Math.floor(Math.min(Date.now() + 120_000, initial.absoluteExpiresAt) / 1000),
      }));
      const after = await machine.evaluate(() => window.anantaMachine.status().lease);
      assert.equal(after.sessionId, initial.sessionId); assert.equal(after.generation, before.generation + 1);
      lastRenew = performance.now(); renewals++;
    }
    await machine.evaluate(async () => { await window.__activeDialog?.stop(); });
    await human.locator(".nav-item").filter({ hasText: /^Live/ }).click();
    const color = phases % 2 ? "green" : "red";
    await machine.evaluate(startActiveDialog, { sessionId: f.binding.sessionId, color });
    await human.waitForFunction(decodedCompanionScreen, color, { timeout: 7000 });
    const received = await waitFixtureValue(machine, activeDialogObservation, undefined, {
      timeout: 4000, accept: value => value.samples >= 16000 && value.nonzero > 1000 && value.screenFrames >= 3,
    });
    assert.equal(received.failed, false);
    assert.equal(received.audioOpen, true);
    assert.equal(received.chatOpen, true);
    const chat = await machine.evaluate(() => {
      const batch = window.anantaMachine.chat.poll();
      if (!batch.events.length) return 0;
      const { cursor, event } = batch.events[0];
      window.anantaMachine.chat.ack(cursor);
      window.anantaMachine.chat.reply(event.message_id, "synthetic soak ack");
      return 1;
    });
    chatAcks += chat;
    const heap = (await cdp.send("Runtime.getHeapUsage")).usedSize;
    peakHeap = Math.max(peakHeap, heap);
    assert.ok(heap < 256 * 1024 * 1024 && heap - initialHeap < 160 * 1024 * 1024, "browser JS heap budget exceeded");
    assert.equal(await machine.evaluate(() => window.__captures), 0);
    phases++;
    if (phases % 6 === 0) {
      t.diagnostic(JSON.stringify({ elapsedSeconds: Math.round((performance.now() - started) / 1000), phases, renewals, chatAcks,
        peakHeapMiB: Math.round(peakHeap / 1024 / 1024) }));
    }
  }
  await machine.evaluate(async () => {
    await window.__activeDialog?.stop();
    window.anantaMachine.leave();
  });
  assert.equal(await machine.evaluate(() => window.anantaMachine.status().joined), false);
  assert.ok(phases >= 3 && chatAcks >= 1);
  t.diagnostic(JSON.stringify({
    schema: "ananta.meet-audio-chat-soak-evidence.v1", configuredSeconds: seconds,
    elapsedSeconds: Math.round((performance.now() - started) / 1000), phases, renewals, chatAcks,
    absoluteExpiryObserved: expired, peakHeapMiB: Math.round(peakHeap / 1024 / 1024),
    scope: "synthetic-policy-direct-ice-audio-chat-screen", gpuInference: "unverified",
  }));
});
