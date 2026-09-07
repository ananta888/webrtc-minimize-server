import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "../test/helpers/machine-browser-fixture.js";

const seconds = Number(process.env.MACHINE_SOAK_SECONDS || 0);
if (process.env.MACHINE_SOAK_SECONDS !== undefined && (!Number.isInteger(seconds) || seconds < 300 || seconds > 7200)) {
  throw new Error("machine_soak_duration_invalid");
}

test("isolated machine screen/lease soak with decoded-frame, heap and bounded-stop evidence", {
  skip: !seconds && "Set MACHINE_SOAK_SECONDS=300..7200; no long test starts implicitly",
  timeout: (seconds + 90) * 1000,
}, async t => {
  const f = await machineBrowserFixture(t, { lifetimeSeconds: seconds + 180 });
  const caps = ["screen.publish"];
  await f.machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant), [f.roomId, await f.grant(caps)]);
  await f.human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
  const cdp = await f.machine.context().newCDPSession(f.machine);
  const initialHeap = (await cdp.send("Runtime.getHeapUsage")).usedSize;
  const colors = await f.human.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
    return ["#dd1414", "#14dd14"].map(color => {
      const ctx = canvas.getContext("2d"); ctx.fillStyle = color; ctx.fillRect(0, 0, 640, 360);
      return canvas.toDataURL("image/jpeg", .7).split(",")[1];
    });
  });
  const initial = await f.machine.evaluate(() => window.anantaMachine.status().lease);
  const started = performance.now(), deadline = started + seconds * 1000;
  let source, sequence = 0, framesSent = 0, renewals = 0, activations = 0, lastRenew = started, lastReport = started;
  let decoded = 0, lastDecode = started, lastColor = "", lastColorChange = started, peakHeap = initialHeap, expired = false;
  let observation = null, observationError = null;
  const recent = [];
  while (performance.now() < deadline) {
    const now = performance.now();
    if (observationError) throw observationError;
    if (observation && now - lastReport > 10_000) throw new Error("machine_soak_observation_timeout");
    // At the two-hour hard session bound, require automatic stop rather than
    // minting a second membership to hide an expiry or extend the original lease.
    if (Date.now() >= initial.absoluteExpiresAt - 2000) {
      await f.machine.waitForFunction(() => !window.anantaMachine.status().joined, null, { timeout: 5000 });
      expired = true; break;
    }
    if (now - lastRenew >= 60_000) {
      const before = await f.machine.evaluate(() => window.anantaMachine.status().lease);
      await f.machine.evaluate(grant => window.anantaMachine.renew(grant), await f.grant(caps, 2, {
        expiresAt: Math.floor(Math.min(Date.now() + 120_000, initial.absoluteExpiresAt) / 1000),
      }));
      const after = await f.machine.evaluate(() => window.anantaMachine.status().lease);
      assert.equal(after.sessionId, initial.sessionId); assert.equal(after.generation, before.generation + 1);
      lastRenew = performance.now(); renewals++; source = null;
    }
    if (!source || Date.now() >= source.expiresAt - 1500) {
      source = await f.machine.evaluate(id => window.anantaMachine.screen.open(id), "screen:" + f.binding.sessionId);
      activations++; sequence = 0;
    }
    try {
      await f.machine.evaluate(async ([generation, seq, jpeg]) => {
        await window.anantaMachine.screen.push(generation, seq, jpeg);
        window.__lastFrameClock = { wall: Date.now(), mono: performance.now() };
      },
        [source.generation, ++sequence, colors[Math.floor((performance.now() - started) / 2000) % 2]]);
    } catch (error) {
      t.diagnostic(JSON.stringify({ elapsedSeconds: Math.round((performance.now() - started) / 1000), framesSent, sequence,
        sourceRemainingMs: source.expiresAt - Date.now(), runtime: await f.machine.evaluate(() => ({
          source: window.anantaMachine.screen.status(), joined: window.anantaMachine.status().joined,
          stop: window.anantaMachine.screen.diagnostics(),
          peers: window.anantaMachine.status().peers, leaseGeneration: window.anantaMachine.status().lease?.generation,
          e2ee: window.anantaMachine.status().e2ee, transformErrors: window.__transformErrors.slice(0, 8),
          lastFrameWallMs: Date.now() - window.__lastFrameClock?.wall,
          lastFrameMonotonicMs: performance.now() - window.__lastFrameClock?.mono })) }));
      throw error;
    }
    framesSent++;
    if (!observation && performance.now() - lastReport >= 5000) {
      // getStats/CDP may pause for seconds. Do not make instrumentation the
      // producer clock; keep one bounded observation in flight while pushing.
      lastReport = performance.now();
      observation = (async () => {
      const result = await f.human.evaluate(async () => {
        let decoded = 0; const inbound = [];
        for (const pc of window.__pcs) for (const stat of (await pc.getStats()).values()) {
          if (stat.type === "inbound-rtp" && stat.kind === "video") {
            decoded += stat.framesDecoded || 0;
            inbound.push({ received: stat.framesReceived, decoded: stat.framesDecoded, dropped: stat.framesDropped,
              keyframes: stat.keyFramesDecoded, bytes: stat.bytesReceived, packetsLost: stat.packetsLost });
          }
        }
        const colors = [...document.querySelectorAll("video")].filter(video => video.videoWidth).map(video => {
          const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
          const ctx = canvas.getContext("2d"); ctx.drawImage(video, 0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data];
        });
        const pixel = colors.find(([r, g]) => r > 150 && g < 80 || g > 150 && r < 80);
        return { decoded, sourcePixels: Boolean(pixel), color: pixel ? pixel[0] > 150 ? "red" : "green" : "", inbound,
          videos: [...document.querySelectorAll("video")].map(video => ({ width: video.videoWidth, height: video.videoHeight,
            ready: video.readyState, paused: video.paused, ended: video.ended })),
          transformErrors: window.__transformErrors.slice(0, 8) };
      });
      recent.push({ elapsedSeconds: Math.round((performance.now() - started) / 1000), ...result });
      if (recent.length > 6) recent.shift();
      // Counters can reset on a new publication: any changed, nonzero decoded
      // count plus actual source pixels proves movement across bounded windows.
      if (result.decoded > 0 && result.decoded !== decoded && result.sourcePixels) lastDecode = performance.now();
      decoded = result.decoded;
      assert.ok(performance.now() - lastDecode < 15_000, "decoded source stalled for 15 seconds");
      if (result.color && result.color !== lastColor) { lastColor = result.color; lastColorChange = performance.now(); }
      assert.ok(performance.now() - lastColorChange < 15_000, "rendered source pixels stopped changing for 15 seconds");
      const heap = (await cdp.send("Runtime.getHeapUsage")).usedSize; peakHeap = Math.max(peakHeap, heap);
      assert.ok(heap < 256 * 1024 * 1024 && heap - initialHeap < 160 * 1024 * 1024, "browser JS heap budget exceeded");
      // A source/lease rotation may be pending while this observation completes;
      // decoded-frame/pixel liveness still has the unchanged 15-second budget.
      assert.ok(["active", "pending"].includes(await f.machine.evaluate(() => window.anantaMachine.status().e2ee)));
      assert.equal(await f.machine.evaluate(() => window.__captures), 0);
      if (Math.floor((lastReport - started) / 5000) % 6 === 0) {
        t.diagnostic(JSON.stringify({ elapsedSeconds: Math.round((lastReport - started) / 1000), framesSent, renewals, activations,
          decoded, heapMiB: Math.round(heap / 1024 / 1024) }));
      }
      })().catch(error => {
        t.diagnostic(JSON.stringify({ failedObservations: recent }));
        observationError = error;
      }).finally(() => { observation = null; });
    }
    await new Promise(resolve => setTimeout(resolve, 230));
  }
  if (observation) await observation;
  if (observationError) throw observationError;
  await f.machine.evaluate(() => window.anantaMachine.leave());
  assert.equal(await f.machine.evaluate(() => window.anantaMachine.screen.status().open), false);
  assert.equal(await f.machine.evaluate(() => window.anantaMachine.status().joined), false);
  assert.ok(renewals >= 3 && activations >= 5 && framesSent > 350);
  t.diagnostic(JSON.stringify({ schema: "ananta.meet-screen-soak-evidence.v1", configuredSeconds: seconds,
    elapsedSeconds: Math.round((performance.now() - started) / 1000), framesSent, renewals, activations, absoluteExpiryObserved: expired,
    peakHeapMiB: Math.round(peakHeap / 1024 / 1024), scope: "synthetic-policy-direct-ice-screen-only",
    gpuInference: "unverified", turnAndSfu: "unverified", dialogAudioAndChatSoak: "unverified" }));
});
