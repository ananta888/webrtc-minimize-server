import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";

for (const humanEngine of ["chromium", "firefox"]) {
test(`${humanEngine} human consent gates real machine chat, decrypted PCM and own screen through three renewals`, { timeout: 100_000 }, async t => {
  const f = await machineBrowserFixture(t, { humanEngine }), { human, machine } = f;
  t.after(async () => { if (!machine.isClosed()) t.diagnostic(JSON.stringify(await machine.evaluate(() => ({
    e2ee: window.anantaMachine.status().e2ee, errors: window.__transformErrors, audio: window.anantaMachine.audio.status() })))); });
  const caps = ["audio.receive", "chat.read", "chat.send", "screen.publish"];
  await machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant), [f.roomId, await f.grant(caps)]);
  await human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
  assert.equal(await human.evaluate(() => window.__captures), 0);
  assert.deepEqual(await machine.evaluate(() => window.anantaMachine.audio.sources()), []);
  assert.equal(await machine.evaluate(() => { try { window.anantaMachine.chat.open(); return true; } catch { return false; } }), false);
  await human.locator("#toggle-microphone").click();
  await human.locator('#toggle-microphone[aria-pressed="true"]').waitFor({ timeout: 5000 });
  await human.locator(".nav-item", { hasText: "Analyse" }).click();
  const panel = human.locator("app-machine-permissions-panel");
  await panel.getByRole("button", { name: "Für diese KI einstellen" }).click();
  await panel.getByLabel("Mein laufendes Mikrofon", { exact: true }).check();
  await panel.getByLabel("Meine neuen Chatbeiträge", { exact: true }).check();
  await panel.getByRole("button", { name: "Auswahl ausdrücklich freigeben" }).click();
  await panel.getByText("Serverbestätigung erhalten.", { exact: true }).waitFor().catch(async error => {
    const codes = await panel.getByRole("alert").allTextContents();
    t.diagnostic(JSON.stringify({ consentFailure: codes.filter(code => /^machine_receive_[a-z_]{1,64}$/.test(code)).slice(0, 3) }));
    throw error;
  });
  await machine.waitForFunction(() => window.anantaMachine.audio.sources().length === 1, null, { timeout: 12000 }).catch(async error => {
    t.diagnostic(JSON.stringify(await machine.evaluate(async () => ({ e2ee: window.anantaMachine.status().e2ee,
      errors: window.__transformErrors, capabilities: typeof RTCRtpScriptTransform,
      peers: window.anantaMachine.status().peers, connections: await Promise.all(window.__pcs.map(async pc => ({
        state: pc.connectionState, receivers: pc.getReceivers().map(r => ({ kind: r.track.kind, muted: r.track.muted, state: r.track.readyState })),
        inbound: [...(await pc.getStats()).values()].filter(s => s.type === 'inbound-rtp').map(s => ({ kind: s.kind, bytes: s.bytesReceived, samples: s.totalSamplesReceived })) }))) }))));
    throw error;
  });
  await machine.evaluate(() => window.anantaMachine.chat.open());
  await human.getByRole("button", { name: "Chat", exact: true }).click();
  await human.locator("#chat-message").fill("@ananta synthetic consented question");
  await human.locator("#chat-form button").click();
  await machine.waitForFunction(() => window.anantaMachine.chat.poll().events.length === 1);
  const event = await machine.evaluate(() => window.anantaMachine.chat.poll().events[0]);
  assert.equal(event.event.sender_kind, "human");
  await machine.evaluate(item => { window.anantaMachine.chat.ack(item.cursor); window.anantaMachine.chat.reply(item.event.message_id, "Bound synthetic answer"); }, event);
  await human.locator("#chat-log").getByText("Bound synthetic answer", { exact: false }).waitFor();
  const pcm = await machine.evaluate(async () => {
    const source = window.anantaMachine.audio.sources()[0];
    await window.anantaMachine.audio.open(source.publicationId, 1);
    let samples = 0, nonzero = 0, sequence = 0;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!window.anantaMachine.audio.status().open) throw new Error(JSON.stringify({
        audio: window.anantaMachine.audio.status(), e2ee: window.anantaMachine.status().e2ee,
        errors: window.__transformErrors, sequence }));
      const batch = window.anantaMachine.audio.poll();
      for (const chunk of batch.chunks) {
        if (chunk.sequence !== ++sequence || chunk.startSample !== samples) throw new Error("PCM discontinuity");
        const bytes = Uint8Array.from(atob(chunk.pcmBase64), c => c.charCodeAt(0));
        const view = new DataView(bytes.buffer); samples += bytes.length / 2;
        for (let i = 0; i < bytes.length; i += 2) if (Math.abs(view.getInt16(i, true)) > 50) nonzero++;
        window.anantaMachine.audio.ack(chunk.sequence);
      }
      if (batch.completed && sequence === 10) return { samples, nonzero };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("PCM budget expired");
  }).catch(async error => {
    t.diagnostic(JSON.stringify(await machine.evaluate(() => ({ e2ee: window.anantaMachine.status().e2ee,
      errors: window.__transformErrors, audio: window.anantaMachine.audio.status() }))));
    throw error;
  });
  t.diagnostic(JSON.stringify({ pcm, machine: await machine.evaluate(() => ({ e2ee: window.anantaMachine.status().e2ee, errors: window.__transformErrors })) }));
  assert.equal(pcm.samples, 16000); assert.ok(pcm.nonzero > 1000);
  await machine.evaluate(() => window.anantaMachine.audio.close());
  await human.locator(".nav-item").filter({ hasText: /^Live/ }).click();
  // Synthetic source distinct from both participant contexts; inspect remote pixels,
  // not just inbound byte counters, and never capture the host desktop.
  const sourceContext = await f.browser.newContext({ viewport: { width: 640, height: 360 } });
  const source = await sourceContext.newPage();
  await source.setContent('<body style="margin:0;background:rgb(220,20,20)"></body>');
  const lease = await machine.evaluate(id => window.anantaMachine.screen.open(id), "screen:" + f.binding.sessionId);
  for (let index = 0; index < 20; index++) {
    await source.evaluate(i => document.body.style.background = i % 2 ? "rgb(20,220,20)" : "rgb(220,20,20)", index);
    const frame = await source.screenshot({ type: "jpeg", quality: 70 });
    await machine.evaluate(([gen, seq, jpeg]) => window.anantaMachine.screen.push(gen, seq, jpeg), [lease.generation, index + 1, frame.toString("base64")]);
    await machine.waitForTimeout(230);
  }
  // Sending the last green frame is not a rendering ACK. Wait for that exact
  // decoded pixel condition, bounded below the source's two-second stall stop.
  const readDecoded = () => human.evaluate(async () => {
    let frames = 0; for (const pc of window.__pcs) for (const stat of (await pc.getStats()).values())
      if (stat.type === "inbound-rtp") frames += stat.framesDecoded || 0;
    const pixels = [...document.querySelectorAll("video")].filter(v => v.videoWidth > 0).map(v => {
      const c = document.createElement("canvas"); c.width = c.height = 1;
      const ctx = c.getContext("2d"); ctx.drawImage(v, 0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data];
    }); return { frames, pixels };
  });
  let decoded = await readDecoded();
  const renderDeadline = performance.now() + 1500;
  while (!(decoded.frames > 3 && decoded.pixels.some(p => p[1] > 150 && p[0] < 80)) && performance.now() < renderDeadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    decoded = await readDecoded();
  }
  assert.ok(decoded.frames > 3, "remote frames decoded");
  assert.ok(decoded.pixels.some(p => p[1] > 150 && p[0] < 80), "remote decoded green source pixels");
  await machine.evaluate(() => window.anantaMachine.screen.close());
  for (let i = 0; i < 3; i++) {
    const before = await machine.evaluate(() => window.anantaMachine.status().lease);
    // JWT expirations are seconds, and renewal must actually extend the lease.
    await machine.waitForTimeout(1100);
    await machine.evaluate(grant => window.anantaMachine.renew(grant), await f.grant(caps));
    const after = await machine.evaluate(() => window.anantaMachine.status().lease);
    assert.equal(after.sessionId, before.sessionId); assert.equal(after.generation, before.generation + 1);
  }
  await human.locator(".nav-item", { hasText: "Analyse" }).click();
  await panel.getByRole("button", { name: "Meine Freigaben widerrufen" }).click();
  await panel.getByText("Keine Empfangsfreigabe erteilt.", { exact: true }).waitFor();
  await machine.waitForFunction(() => !window.anantaMachine.chat.status().open && window.anantaMachine.audio.sources().length === 0);
  assert.equal(await machine.evaluate(() => window.__captures), 0);
  await machine.evaluate(() => window.anantaMachine.leave());
  assert.equal(await machine.evaluate(() => window.anantaMachine.status().joined), false);
});
}
