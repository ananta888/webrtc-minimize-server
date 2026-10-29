import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";

for (const humanEngine of ["chromium", "firefox"]) {
  test(`${humanEngine} read-only machine chat redelivery follows Hub capability through renewal and server membership loss`, { timeout: 60_000 }, async t => {
    const f = await machineBrowserFixture(t, { humanEngine, machineEngine: humanEngine }), { human, machine } = f;
    const caps = ["chat.read"];
    await machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant), [f.roomId, await f.grant(caps)]);
    await human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
    await human.locator(".nav-item", { hasText: "Analyse" }).click();
    const panel = human.locator("app-machine-permissions-panel");
    await panel.getByText("Leserecht vorhanden / Kein Senderecht", { exact: true }).waitFor();
    assert.equal(await panel.locator('input, select').count(), 0);
    await panel.locator('#machine-receive-stop').waitFor();
    await machine.evaluate(() => window.anantaMachine.chat.open());
    await human.getByRole("button", { name: "Chat", exact: true }).click();
    const send = async text => {
      await human.locator("#chat-message").fill(text); await human.locator("#chat-form button").click();
      await machine.waitForFunction(() => window.anantaMachine.chat.poll().events.length === 1);
      return machine.evaluate(() => {
        const item = window.anantaMachine.chat.poll().events[0];
        const receipt = window.anantaMachine.chat.redeliver([item.event.message_id]);
        if (receipt.schema !== "ananta.meet-chat-redelivery.draft1"
          || receipt.message_ids.length !== 1 || receipt.message_ids[0] !== item.event.message_id)
          throw new Error("test_current_redelivery_invalid");
        window.__testPendingChatId = item.event.message_id;
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
    assert.equal(await machine.evaluate(() => {
      const receipt = window.anantaMachine.chat.redeliver([window.__testPendingChatId]);
      return receipt.message_ids[0] === window.__testPendingChatId;
    }), true, "current same-conversation renewal preserves delivered identity, not send authority");
    assert.deepEqual(await send("Synthetic renewed input"), { denied: true, text: "Synthetic renewed input", open: true });
    assert.equal(await human.locator("#chat-log").getByText("Forbidden machine reply", { exact: false }).count(), 0);
    await human.locator(".nav-item", { hasText: "Analyse" }).click();
    assert.equal(await machine.evaluate(() => {
      return window.anantaMachine.chat.redeliver([window.__testPendingChatId]).message_ids[0] === window.__testPendingChatId;
    }), true, "observing rights does not revoke a verified Hub capability");
    await human.locator("#leave-room").click();
    await machine.waitForFunction(() => window.anantaMachine.status().joined
      && window.anantaMachine.status().peers === 1, null, { timeout: 3000 });
    assert.equal(await machine.evaluate(() => {
      window.anantaMachine.chat.open();
      try { window.anantaMachine.chat.redeliver([window.__testPendingChatId]); return false; }
      catch (error) { return error.message === "meet_chat_redelivery_denied"; }
    }), true, "a departed publisher cannot be reconfirmed even while the machine's Hub lease remains live");
    // Terminate only this private fixture's sockets. Actual server membership
    // loss, not an obsolete consent switch, ends current receive authority.
    for (const socket of f.app.webSocketServer.clients) socket.terminate();
    await machine.waitForFunction(() => !window.anantaMachine.status().joined, null, { timeout: 3000 });
    assert.equal(await machine.evaluate(() => {
      try { window.anantaMachine.chat.open(); return false; } catch { return true; }
    }), true);
    assert.equal(await machine.evaluate(() => {
      try { window.anantaMachine.chat.redeliver([window.__testPendingChatId]); return false; }
      catch { return true; }
    }), true, "actual membership loss cannot be reconfirmed");
    assert.equal(await human.evaluate(() => window.__captures), 0);
    assert.equal(await machine.evaluate(() => window.__captures), 0);
    await machine.evaluate(() => window.anantaMachine.leave());
  });
}
