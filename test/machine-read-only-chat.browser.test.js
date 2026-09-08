import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";

for (const humanEngine of ["chromium", "firefox"]) {
  test(`${humanEngine} read-only machine chat stays non-sending through renewal and consent withdrawal`, { timeout: 60_000 }, async t => {
    const f = await machineBrowserFixture(t, { humanEngine }), { human, machine } = f;
    const caps = ["chat.read"];
    await machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant), [f.roomId, await f.grant(caps)]);
    await human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
    await human.locator(".nav-item", { hasText: "Analyse" }).click();
    const panel = human.locator("app-machine-permissions-panel");
    await panel.getByRole("button", { name: "Für diese KI einstellen" }).click();
    await panel.getByText("Leserecht möglich / Kein Senderecht", { exact: true }).waitFor();
    await panel.getByLabel("Meine neuen Chatbeiträge", { exact: true }).check();
    await panel.getByRole("button", { name: "Auswahl ausdrücklich freigeben" }).click();
    await panel.getByText("Serverbestätigung erhalten.", { exact: true }).waitFor();
    await machine.evaluate(() => window.anantaMachine.chat.open());
    await human.getByRole("button", { name: "Chat", exact: true }).click();
    const send = async text => {
      await human.locator("#chat-message").fill(text); await human.locator("#chat-form button").click();
      await machine.waitForFunction(() => window.anantaMachine.chat.poll().events.length === 1);
      return machine.evaluate(() => {
        const item = window.anantaMachine.chat.poll().events[0];
        window.anantaMachine.chat.ack(item.cursor);
        let denied = false;
        try { window.anantaMachine.chat.reply(item.event.message_id, "Forbidden machine reply"); }
        catch (error) { denied = error.message === "meet_chat_reply_denied"; }
        return { denied, text: item.event.text, open: window.anantaMachine.chat.status().open };
      });
    };
    assert.deepEqual(await send("Synthetic read-only input"), { denied: true, text: "Synthetic read-only input", open: true });
    const before = await machine.evaluate(() => window.anantaMachine.status().lease);
    await machine.waitForTimeout(1100);
    await machine.evaluate(grant => window.anantaMachine.renew(grant), await f.grant(caps));
    await machine.waitForFunction(() => !window.anantaMachine.chat.status().open, null, { timeout: 2000 });
    const after = await machine.evaluate(() => window.anantaMachine.status().lease);
    assert.equal(after.sessionId, before.sessionId); assert.equal(after.generation, before.generation + 1);
    assert.deepEqual(await machine.evaluate(() => {
      window.anantaMachine.chat.open(); return window.anantaMachine.chat.poll().events;
    }), [], "renewal must not replay consumed history");
    assert.deepEqual(await send("Synthetic renewed input"), { denied: true, text: "Synthetic renewed input", open: true });
    assert.equal(await human.locator("#chat-log").getByText("Forbidden machine reply", { exact: false }).count(), 0);
    await human.locator(".nav-item", { hasText: "Analyse" }).click();
    await panel.getByRole("button", { name: "Meine Freigaben widerrufen" }).click();
    await panel.getByText("Keine Empfangsfreigabe erteilt.", { exact: true }).waitFor();
    await machine.waitForFunction(() => !window.anantaMachine.chat.status().open, null, { timeout: 2000 });
    assert.equal(await machine.evaluate(() => {
      try { window.anantaMachine.chat.open(); return false; } catch { return true; }
    }), true);
    assert.equal(await human.evaluate(() => window.__captures), 0);
    assert.equal(await machine.evaluate(() => window.__captures), 0);
    await machine.evaluate(() => window.anantaMachine.leave());
  });
}
