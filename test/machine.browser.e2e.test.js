import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import { SignJWT } from "jose";
import { chromium } from "playwright";
import { createAppServer } from "../src/server.js";

test("machine publishes generated speech, avatar and chat under required SFrame", {
  timeout: 80_000, skip: !process.env.MACHINE_E2E_VIDEO && "Set MACHINE_E2E_VIDEO to a synthetic local GPU demo MP4",
}, async context => {
  const video = await fs.readFile(process.env.MACHINE_E2E_VIDEO);
  assert.ok(video.length > 100 && video.length < 3_500_000);
  const keys = generateKeyPairSync("ed25519");
  const issuer = "https://synthetic-hub.example.test";
  const roomId = "room-0123456789abcdef01";
  const app = createAppServer({ config: { host: "127.0.0.1", port: 0, authMode: "required",
    oidcIssuer: issuer, oidcAudience: "human", oidcJwksUrl: issuer + "/jwks",
    machineHubPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }), machineHubIssuer: issuer,
    stunUrls: [], turnServers: [], mediaE2eeMode: "required", signalRateLimit: 240,
  } });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  context.after(async () => {
    await browser.close();
    for (const socket of app.webSocketServer.clients) socket.terminate();
    await new Promise(resolve => app.server.close(resolve));
  });
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const browserContext = await browser.newContext({ permissions: [] });
    await browserContext.addInitScript(() => {
      window.__captures = 0; window.__pcs = [];
      for (const method of ["getUserMedia", "getDisplayMedia"]) navigator.mediaDevices[method] = () => {
        ++window.__captures; throw new Error("human_capture_forbidden");
      };
      const Native = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Native {
        constructor(...args) {
          super(...args); window.__pcs.push(this);
          this.addEventListener("track", event => {
            const element = document.createElement(event.track.kind === "audio" ? "audio" : "video");
            element.autoplay = true; element.srcObject = new MediaStream([event.track]);
            document.body.append(element); void element.play();
          });
        }
      };
    });
    const page = await browserContext.newPage();
    await page.goto(`http://127.0.0.1:${app.server.address().port}/machine`);
    await page.waitForFunction(() => Boolean(window.anantaMachine));
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ iss: issuer, aud: "ananta-meet-machine-v1", sub: `synthetic-${i}`,
      iat: now, exp: now + 120, jti: randomUUID(), roomId, taskId: randomUUID(), tenantId: "synthetic", projectId: "synthetic",
    }).setProtectedHeader({ alg: "EdDSA", typ: "ananta-meet-machine+jwt" }).sign(keys.privateKey);
    await page.evaluate(([room, grant]) => window.anantaMachine.join(room, grant), [roomId, token]);
    pages.push(page);
  }
  await Promise.all([
    pages[0].evaluate(encoded => window.anantaMachine.publish("Synthetischer GPU-Test", encoded), video.toString("base64")),
    pages[1].waitForFunction(async () => {
      let frames = 0, samples = 0;
      for (const pc of window.__pcs) for (const stat of (await pc.getStats()).values()) {
        if (stat.type === "inbound-rtp") { frames += stat.framesDecoded || 0; samples += stat.totalSamplesReceived || 0; }
      }
      return frames > 3 && samples > 1000 && window.anantaMachine.status().e2ee === "active"
        && window.anantaMachine.status().chat.some(item => item.text === "Synthetischer GPU-Test");
    }, null, { timeout: 60_000 }),
  ]);
  for (const page of pages) {
    assert.equal(await page.evaluate(() => window.__captures), 0);
    await page.evaluate(() => window.anantaMachine.leave());
    assert.equal(await page.evaluate(() => window.anantaMachine.status().joined), false);
    assert.deepEqual(await page.evaluate(() => window.anantaMachine.status().chat), []);
  }
});
