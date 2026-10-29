import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";
import { machineRelayObservation, assertMachineRelayObservation, waitMachineRelaySetup, machineRelayDiagnostics } from "./helpers/machine-relay-observation.js";

const icePath = process.env.MACHINE_DIALOG_ICE_PATH ?? "direct";
assert.ok(["direct", "turn-udp", "turn-tcp"].includes(icePath), "closed test ICE path");

for (const humanEngine of ["chromium", "firefox"]) {
test(`${humanEngine} human capture and Hub capability gate real chat redelivery, decrypted PCM and own screen through three renewals`, { timeout: 100_000 }, async t => {
  const f = await machineBrowserFixture(t, { humanEngine, icePath }), { human, machine } = f;
  t.after(async () => { if (!machine.isClosed()) t.diagnostic(JSON.stringify(await machine.evaluate(() => ({
    e2ee: window.anantaMachine.status().e2ee, errors: window.__transformErrors, audio: window.anantaMachine.audio.status() })))); });
  const caps = ["audio.receive", "chat.read", "chat.send", "screen.publish"];
  await machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant), [f.roomId, await f.grant(caps)]);
  await human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
  if (icePath !== "direct") {
    // This case forces the actual session-issued relay from construction. It
    // tests TURN media delivery, not the default delayed tier fallback. Establish
    // ICE/DTLS/SCTP before the unchanged, separate 12 s media budget.
    await waitMachineRelaySetup([human, machine]).catch(async error => {
      t.diagnostic(JSON.stringify({ path: icePath, human: await machineRelayDiagnostics(human), machine: await machineRelayDiagnostics(machine) }));
      throw error;
    });
  }
  assert.equal(await human.evaluate(() => window.__captures), 0);
  assert.deepEqual(await machine.evaluate(() => window.anantaMachine.audio.sources()), []);
  assert.equal(await machine.evaluate(() => { try { window.anantaMachine.chat.open(); return true; } catch { return false; } }), true);
  await human.locator(".nav-item", { hasText: "Analyse" }).click();
  const panel = human.locator("app-machine-permissions-panel");
  await panel.getByText("Leserecht vorhanden / Senderecht vorhanden", { exact: true }).waitFor();
  assert.equal(await panel.locator('input, select').count(), 0, "rights observation offers no ineffective consent editor");
  assert.equal(await human.evaluate(() => window.__captures), 0, "rights observation does not start capture");
  await human.locator(".nav-item").filter({ hasText: /^Live/ }).click();
  await human.locator("#toggle-microphone").click();
  await human.locator('#toggle-microphone[aria-pressed="true"]').waitFor({ timeout: 5000 });
  await human.locator("#toggle-microphone").click();
  await human.locator('#toggle-microphone[aria-pressed="false"]').waitFor();
  await human.locator("#toggle-microphone").click();
  await human.locator('#toggle-microphone[aria-pressed="true"]').waitFor();
  await human.locator(".nav-item", { hasText: "Analyse" }).click();
  await panel.getByText("Vom Hub erlaubt für laufende Raumquellen.", { exact: true }).waitFor();
  await machine.waitForFunction(() => window.anantaMachine.audio.sources().length === 1, null, { timeout: 12000 }).catch(async error => {
    if (icePath !== "direct") {
      t.diagnostic(JSON.stringify({ path: icePath, humanRelay: await machineRelayObservation(human),
        machineRelay: await machineRelayObservation(machine), sender: await human.evaluate(async () => ({
          errors: window.__transformErrors, iceEvents: window.__testIce,
          connections: await Promise.all(window.__pcs.map(async pc => ({
            state: pc.connectionState, ice: pc.iceConnectionState, gathering: pc.iceGatheringState,
            signaling: pc.signalingState, sctp: pc.sctp?.state,
            localType: pc.localDescription?.type, remoteType: pc.remoteDescription?.type,
            localMedia: (pc.localDescription?.sdp.match(/^m=(audio|video|application)/gm) || []).slice(0, 8),
            remoteMedia: (pc.remoteDescription?.sdp.match(/^m=(audio|video|application)/gm) || []).slice(0, 8),
            transports: [...(await pc.getStats()).values()].filter(s => s.type === "transport")
              .map(s => ({ dtls: s.dtlsState, ice: s.iceState })),
            candidates: [...(await pc.getStats()).values()].filter(s => s.type === "local-candidate" || s.type === "remote-candidate")
              .map(s => ({ side: s.type, kind: s.candidateType, protocol: s.protocol, relayProtocol: s.relayProtocol })),
            pairs: [...(await pc.getStats()).values()].filter(s => s.type === "candidate-pair")
              .map(s => ({ state: s.state, nominated: s.nominated, sent: s.bytesSent, received: s.bytesReceived })),
            senders: pc.getSenders().map(s => s.track ? { kind: s.track.kind, state: s.track.readyState, enabled: s.track.enabled } : null),
            outbound: [...(await pc.getStats()).values()].filter(s => s.type === "outbound-rtp")
              .map(s => ({ kind: s.kind, bytes: s.bytesSent, packets: s.packetsSent })),
          }))),
        })) }));
    }
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
  assert.deepEqual(await machine.evaluate(id => window.anantaMachine.chat.redeliver([id]), event.event.message_id),
    { schema: "ananta.meet-chat-redelivery.draft1", message_ids: [event.event.message_id] });
  const answerText = "Bound synthetic answer <b>literal text</b>";
  await machine.evaluate(({ item, text }) => { window.anantaMachine.chat.ack(item.cursor); window.anantaMachine.chat.reply(item.event.message_id, text); }, { item: event, text: answerText });
  await human.locator("#chat-log").getByText(answerText, { exact: true }).waitFor();
  assert.equal(await machine.evaluate(id => {
    try { window.anantaMachine.chat.redeliver([id]); return false; }
    catch (error) { return error.message === "meet_chat_redelivery_denied"; }
  }, event.event.message_id), true, "answered input cannot be reconfirmed");
  const chatViewBaseline = await human.evaluate(() => ({ captures: window.__captures, peers: window.__pcs.length }));
  // The same display must work in both views without recreating media or
  // inferring machine classification from an author name or HTML-like text.
  for (const section of ["chat", "live", "chat"]) {
    if (section === "live") await human.locator(".nav-item").filter({ hasText: /^Live/ }).click();
    else await human.getByRole("button", { name: "Chat", exact: true }).click();
    const log = human.locator("#chat-log"), answer = log.locator(".chat-entry").filter({ hasText: answerText });
    await answer.getByText("KI-Nachricht", { exact: true }).waitFor();
    assert.equal(await answer.getAttribute("data-machine-message"), "true");
    assert.equal(await answer.getByText("Antwort", { exact: true }).count(), 1);
    assert.equal(await answer.locator("b").count(), 0, "chat text is escaped, not interpreted as markup");
    assert.equal(await log.locator(".chat-entry").filter({ hasText: "@ananta synthetic consented question" }).getAttribute("data-machine-message"), null);
  }
  assert.deepEqual(await human.evaluate(() => ({ captures: window.__captures, peers: window.__pcs.length })), chatViewBaseline);
  const relayBefore = icePath === "direct" ? [] : await waitMachineRelaySetup([human, machine], 1500).catch(async error => {
    t.diagnostic(JSON.stringify({ phase: "before-pcm", path: icePath,
      human: await machineRelayDiagnostics(human), machine: await machineRelayDiagnostics(machine) }));
    throw error;
  });
  for (const observed of relayBefore) assertMachineRelayObservation(observed, icePath.slice(5));
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
  const relayAfter = icePath === "direct" ? [] : await waitMachineRelaySetup([human, machine], 1500).catch(async error => {
    t.diagnostic(JSON.stringify({ phase: "after-renewals", path: icePath,
      human: await machineRelayDiagnostics(human), machine: await machineRelayDiagnostics(machine) }));
    throw error;
  });
  for (const [index, observed] of relayAfter.entries()) {
    assertMachineRelayObservation(observed, icePath.slice(5), relayBefore[index]);
    t.diagnostic(JSON.stringify({ synthetic: true, productionEvidence: false, path: icePath,
      endpoint: index === 0 ? "human" : "machine", relay: observed }));
  }
  await machine.evaluate(() => window.anantaMachine.screen.close());
  await machine.evaluate(() => window.anantaMachine.chat.open());
  await human.getByRole("button", { name: "Chat", exact: true }).click();
  for (let i = 0; i < 9; i++) {
    await human.locator("#chat-message").fill(`Synthetic pending input ${i}`);
    await human.locator("#chat-form button").click();
  }
  await machine.waitForFunction(() => window.anantaMachine.chat.poll().events.length === 8);
  const heldIds = await machine.evaluate(() => {
    const first = window.anantaMachine.chat.poll(0);
    const second = window.anantaMachine.chat.poll(first.events.at(-1).cursor);
    if (first.events.length !== 8 || second.events.length !== 1 || second.acknowledged !== 0)
      throw new Error("test_pending_pagination_invalid");
    const ids = [...first.events, ...second.events].map(item => item.event.message_id);
    return window.anantaMachine.chat.redeliver(ids).message_ids;
  });
  assert.equal(new Set(heldIds).size, 9);
  for (let i = 0; i < 3; i++) {
    const before = await machine.evaluate(() => window.anantaMachine.status().lease);
    // JWT expirations are seconds, and renewal must actually extend the lease.
    await machine.waitForTimeout(1100);
    await machine.evaluate(grant => window.anantaMachine.renew(grant), await f.grant(caps));
    const after = await machine.evaluate(() => window.anantaMachine.status().lease);
    assert.equal(after.sessionId, before.sessionId); assert.equal(after.generation, before.generation + 1);
    await machine.waitForFunction(() => !window.anantaMachine.chat.status().open, null, { timeout: 2000 });
    assert.deepEqual(await machine.evaluate(ids => {
      window.anantaMachine.chat.open(); return window.anantaMachine.chat.redeliver(ids).message_ids;
    }, heldIds), heldIds, "only current same-conversation delivered inputs survive renewal");
  }
  await machine.evaluate(ids => {
    for (const id of ids) window.anantaMachine.chat.reply(id, "Synthetic held reply");
  }, heldIds);
  await human.waitForFunction(() => [...document.querySelectorAll("#chat-log .chat-entry")]
    .filter(entry => entry.textContent.includes("Synthetic held reply")).length === 9);
  // Revoke an actively collecting subscription, not only a completed graph.
  t.after(async () => { if (!machine.isClosed()) await machine.evaluate(() => clearInterval(window.__audioRevokeTimer)); });
  await machine.evaluate(async () => {
    const source = window.anantaMachine.audio.sources()[0];
    if (!source) throw new Error("test_active_audio_source_missing");
    await window.anantaMachine.audio.open(source.publicationId, 10);
    window.__audioRevokeObservation = { chunks: 0, closed: false, error: "" };
    // Drain throughout UI navigation so overflow cannot impersonate revocation.
    window.__audioRevokeTimer = setInterval(() => {
      try {
        const batch = window.anantaMachine.audio.poll();
        for (const chunk of batch.chunks) {
          window.__audioRevokeObservation.chunks++;
          window.anantaMachine.audio.ack(chunk.sequence);
        }
      } catch {
        window.__audioRevokeObservation.closed = true;
        window.__audioRevokeObservation.error = window.anantaMachine.audio.status().error;
        clearInterval(window.__audioRevokeTimer);
      }
    }, 50);
  });
  await machine.waitForFunction(() => window.__audioRevokeObservation.chunks > 0, null, { timeout: 3000 });
  await human.locator(".nav-item", { hasText: "Analyse" }).click();
  assert.equal(await machine.evaluate(() => window.anantaMachine.audio.status().open), true);
  // Observing rights does not revoke the Hub capability. The private
  // server's membership teardown is the authoritative loss for this fixture.
  for (const socket of f.app.webSocketServer.clients) socket.terminate();
  await machine.waitForFunction(() => !window.anantaMachine.status().joined && !window.anantaMachine.audio.status().open
    && window.anantaMachine.audio.sources().length === 0 && window.__audioRevokeObservation.closed, null, { timeout: 3000 });
  assert.equal(await machine.evaluate(() => window.__audioRevokeObservation.error), "meet_audio_binding_changed");
  assert.deepEqual(await machine.evaluate(() => {
    let pollDenied = false, ackDenied = false;
    try { window.anantaMachine.audio.poll(); } catch { pollDenied = true; }
    try { window.anantaMachine.audio.ack(1); } catch { ackDenied = true; }
    return { pollDenied, ackDenied };
  }), { pollDenied: true, ackDenied: true });
  assert.equal(await machine.evaluate(() => {
    try { window.anantaMachine.chat.redeliver(["0".repeat(32)]); return false; } catch { return true; }
  }), true, "membership loss cannot reconfirm any input");
  assert.equal(await machine.evaluate(() => window.__captures), 0);
  await machine.evaluate(() => window.anantaMachine.leave());
  assert.equal(await machine.evaluate(() => window.anantaMachine.status().joined), false);
});
}
