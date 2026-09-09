import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";
import { decodedCompanionScreen } from "./helpers/machine-avatar-coexistence.mjs";
import { startActiveDialog, activeDialogObservation, staleDialogDenied } from "./helpers/machine-active-dialog.mjs";
import { waitFixtureValue } from "./helpers/machine-browser-wait.mjs";

const renewalProfile = process.env.MEET_TEST_DIALOG_RENEWALS || "ordinary";
if (!["ordinary", "extended"].includes(renewalProfile)) throw new Error("test_dialog_renewals_profile_invalid");
const renewals = renewalProfile === "extended" ? 39 : 3;

for (const humanEngine of ["chromium", "firefox"]) {
  test(`${humanEngine} active audio/chat/screen recover through ${renewals} lease replacements without extending consent`,
    { timeout: renewalProfile === "extended" ? 300_000 : 100_000 }, async t => {
    const f = await machineBrowserFixture(t, { humanEngine }), { human, machine } = f;
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
    const consentText = await panel.getByText(/Bestätigte Freigabe bis/).innerText();
    await machine.waitForFunction(() => window.anantaMachine.audio.sources().length === 1, null, { timeout: 12_000 });
    const receipts = [];
    let originalLease;
    for (let phase = 0; phase <= renewals; phase++) {
      await human.locator(".nav-item").filter({ hasText: /^Live/ }).click();
      const color = phase % 2 ? "green" : "red";
      await machine.evaluate(startActiveDialog, { sessionId: f.binding.sessionId, color });
      await human.waitForFunction(decodedCompanionScreen, color, { timeout: 7000 });
      const received = await waitFixtureValue(machine, activeDialogObservation, undefined, {
        timeout: 4000, accept: value => value.samples >= 16000 && value.nonzero > 1000 && value.screenFrames >= 3,
      });
      assert.equal(received.failed, false);
      assert.equal(received.audioCompleted, false, "renewal exercises an active decoder, not a completed subscription");
      assert.equal(received.audioOpen, true); assert.equal(received.chatOpen, true); assert.equal(received.screenOpen, true);
      await human.getByRole("button", { name: "Chat", exact: true }).click();
      // Live and Chat have different forms with the same input ID. A navigation
      // click is not a render ACK; never fill the outgoing Live form.
      await human.locator("#chat-form.large").waitFor({ timeout: 3000 });
      await human.locator("#chat-message").fill(`synthetic renewal question ${phase}`);
      await human.locator("#chat-form button").click({ timeout: 3000 });
      await machine.waitForFunction(() => window.anantaMachine.chat.poll().events.length === 1);
      await machine.evaluate(index => {
        const { cursor, event } = window.anantaMachine.chat.poll().events[0];
        window.anantaMachine.chat.ack(cursor);
        window.anantaMachine.chat.reply(event.message_id, `synthetic renewal answer ${index}`);
      }, phase);
      await human.locator("#chat-log").getByText(`synthetic renewal answer ${phase}`, { exact: true }).waitFor();
      assert.deepEqual(await machine.evaluate(() => ({ joined: window.anantaMachine.status().joined,
        peers: window.anantaMachine.status().peers, e2ee: window.anantaMachine.status().e2ee })),
      { joined: true, peers: 2, e2ee: "active" });
      const lease = await machine.evaluate(() => window.anantaMachine.status().lease);
      originalLease ??= lease;
      assert.equal(lease.sessionId, originalLease.sessionId); assert.equal(lease.generation, originalLease.generation + phase);
      await human.locator(".nav-item", { hasText: "Analyse" }).click();
      assert.equal(await panel.getByText(/Bestätigte Freigabe bis/).innerText(), consentText);
      assert.equal(await panel.getByRole("button", { name: "Für diese KI einstellen" }).count(), 1);
      receipts.push({ generation: lease.generation, samples: received.samples, nonzero: received.nonzero, color });
      if (phase === renewals) break;
      assert.deepEqual(await machine.evaluate(() => ({ audio: window.anantaMachine.audio.status().open,
        chat: window.anantaMachine.chat.status().open, screen: window.anantaMachine.screen.status().open })),
      { audio: true, chat: true, screen: true });
      await machine.evaluate(grant => window.anantaMachine.renew(grant), await f.grant(caps));
      await machine.waitForFunction(() => !window.anantaMachine.audio.status().open && !window.anantaMachine.chat.status().open
        && !window.anantaMachine.screen.status().open, null, { timeout: 2000 });
      assert.deepEqual(await machine.evaluate(staleDialogDenied), { audio: true, chat: true, screen: true });
    }
    // Publisher revocation affects receive rights, not an independently allowed
    // agent-owned screen. A fresh Hub lease must not regrant those human sources.
    await panel.getByRole("button", { name: "Meine Freigaben widerrufen" }).click();
    await panel.getByText("Keine Empfangsfreigabe erteilt.", { exact: true }).waitFor();
    await machine.waitForFunction(() => !window.anantaMachine.audio.status().open && !window.anantaMachine.chat.status().open
      && window.anantaMachine.audio.sources().length === 0, null, { timeout: 2000 });
    assert.equal(await machine.evaluate(() => window.anantaMachine.screen.status().open), true);
    await machine.evaluate(grant => window.anantaMachine.renew(grant), await f.grant(caps));
    const revoked = await machine.evaluate(() => {
      let chatDenied = false;
      try { window.anantaMachine.chat.open(); } catch { chatDenied = true; }
      return { chatDenied, sources: window.anantaMachine.audio.sources().length, joined: window.anantaMachine.status().joined };
    });
    assert.deepEqual(revoked, { chatDenied: true, sources: 0, joined: true });
    await human.locator(".nav-item").filter({ hasText: /^Live/ }).click();
    assert.equal(await human.locator("#participant-count").innerText(), "2 / 20 Teilnehmer");
    assert.deepEqual(await machine.evaluate(() => ({ capture: window.__captures, errors: window.__transformErrors })), { capture: 0, errors: [] });
    assert.deepEqual(await human.evaluate(() => ({ capture: window.__captures, errors: window.__transformErrors })), { capture: 1, errors: [] });
    t.diagnostic(JSON.stringify({ synthetic: true, productionEvidence: false, unchangedConsent: true, receipts }));
  });
}
