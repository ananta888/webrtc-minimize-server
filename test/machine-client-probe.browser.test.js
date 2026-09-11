import assert from "node:assert/strict";
import test from "node:test";
import { chromium, firefox } from "playwright";
import { createAppServer } from "../src/server.js";
import { machineFixtureAssets } from "./helpers/machine-fixture-assets.mjs";
import { navigateFixture } from "./helpers/machine-browser-navigation.mjs";

for (const [name, engine] of Object.entries({ chromium, firefox })) {
  test(`${name} probes the installed machine client without capture, join or key setup`, { timeout: 30000 }, async t => {
    const app = createAppServer({ publicDir: await machineFixtureAssets(process.env.MEET_TEST_PUBLIC_DIR),
      config: { host: "127.0.0.1", port: 0, publicOrigin: "", stunUrls: [], turnServers: [],
        authMode: "disabled", mediaE2eeMode: "required", maxRoomParticipants: 20, roomIdleTtlMs: 60000,
        signalRateLimit: 120, pairWorkspaceEnabled: false } });
    let browser;
    t.after(async () => {
      await browser?.close();
      for (const socket of app.webSocketServer.clients) socket.terminate();
      await new Promise(resolve => app.webSocketServer.close(resolve));
      if (app.server.listening) await new Promise(resolve => app.server.close(resolve));
    });
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ permissions: [], serviceWorkers: "block" });
    await context.addInitScript(() => {
      window.__probeEffects = { capture: 0, connection: 0, socket: 0 };
      for (const key of ["getUserMedia", "getDisplayMedia"]) navigator.mediaDevices[key] = () => {
        window.__probeEffects.capture++; throw Error("test_capture_denied");
      };
      const Connection = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Connection { constructor(...args) {
        window.__probeEffects.connection++; super(...args);
      } };
      const Socket = window.WebSocket;
      window.WebSocket = class extends Socket { constructor(...args) {
        window.__probeEffects.socket++; super(...args);
      } };
    });
    const page = await context.newPage();
    await navigateFixture(page, `http://127.0.0.1:${app.server.address().port}/machine`,
      () => typeof window.anantaMachine?.probe === "function");
    const result = await page.evaluate(() => {
      let forbidden = 0;
      const restore = [];
      // Scope effects to these two synchronous calls, not unrelated bootstrap
      // requests already in flight when Angular exposes the machine endpoint.
      for (const [owner, key] of [[window, "fetch"], [XMLHttpRequest.prototype, "open"],
        [navigator.mediaDevices, "enumerateDevices"], [crypto.subtle, "generateKey"]]) {
        const original = owner[key]; restore.push(() => { owner[key] = original; });
        owner[key] = () => { forbidden++; throw Error("test_probe_effect_denied"); };
      }
      let first, second;
      try { first = window.anantaMachine.probe(); second = window.anantaMachine.probe(); }
      finally { for (const reset of restore.reverse()) reset(); }
      return { first, stable: JSON.stringify(first) === JSON.stringify(second),
        frozen: [first, first.ports, first.codecs].every(Object.isFrozen),
        effects: window.__probeEffects, forbidden, joined: window.anantaMachine.status().joined,
        legacy: window.anantaMachine.capabilities() };
    });
    assert.deepEqual(result.first, { schema: "ananta.meet-client-probe.v1", client: "isolated-browser-v1",
      frameEnvelope: "codec-prefix-v1", nativeAdapter: false, secureContext: true, encodedTransform: true,
      codecs: { vp8Send: true, vp8Receive: true, opusSend: true, opusReceive: true },
      ports: { session: true, mp4: true, chat: true, audio: true, visual: true, screen: true, screenAudio: true, speech: true, avatar: true } });
    assert.equal(result.stable, true); assert.equal(result.frozen, true); assert.equal(result.joined, false);
    assert.deepEqual(result.effects, { capture: 0, connection: 0, socket: 0 });
    assert.equal(result.forbidden, 0);
    assert.deepEqual(result.legacy, { schema: "ananta.meet-capabilities.v1", publication: "mp4-v1",
      sessionLease: "ananta.meet-session-lease.v1", chatEvents: false, audioSubscription: false, screenPublication: false });
    const denied = await page.evaluate(() => {
      Object.defineProperty(window, "RTCRtpScriptTransform", { configurable: true, value: undefined });
      return window.anantaMachine.probe();
    });
    assert.equal(denied.encodedTransform, false); assert.equal(denied.nativeAdapter, false);
    assert.deepEqual(denied.ports, result.first.ports);
  });
}
