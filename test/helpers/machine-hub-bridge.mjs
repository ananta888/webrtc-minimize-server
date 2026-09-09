// Opt-in private stdio driver for Ananta's cross-repository integration test.
// No tasks, grants, policy overrides or media keys are accepted through this port.
import fs from "node:fs/promises";
import readline from "node:readline";
import { bridgeBrowserLauncher } from "./machine-bridge-browser.mjs";
import { peerBrowserDriver } from "./machine-peer-driver.mjs";
import { machineBrowserFixture } from "./machine-browser-fixture.js";
import { installDialogObservation } from "./machine-dialog-observer.mjs";
import { observeDialogAnswer } from "./machine-chat-observation.mjs";
import { observeAvatarCommand } from "./machine-avatar-observation.mjs";
import { requireReceiverKeyDelay } from "./machine-receiver-key-delay.mjs";
import { transformFailureCounts } from "./machine-transform-observation.mjs";
async function runBridge() {
const cleanup = [];
let stage = "setup";
try {
  const isolatedBrowser = process.env.MEET_ISOLATED_PEER_BROWSER || "0";
  if (!["0", "1"].includes(isolatedBrowser)) throw new Error("test_browser_launcher_invalid");
  const peerDriver = isolatedBrowser === "1" ? peerBrowserDriver(process.env.MEET_TEST_PEER_PLAYWRIGHT_PACKAGE) : null;
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  cleanup.push(() => input.close());
  const commands = input[Symbol.asyncIterator]();
  const reply = value => process.stdout.write(JSON.stringify(value) + "\n");
  const receiverKeyDelay = process.env.MEET_TEST_RECEIVER_KEY_DELAY || "0";
  if (!["0", "1"].includes(receiverKeyDelay)) throw new Error("test_receiver_key_delay_invalid");
  const soakSeconds = Number(process.env.MEET_DIALOG_SOAK_SECONDS || 0);
  if (!Number.isInteger(soakSeconds) || soakSeconds < 0 || soakSeconds > 7200) throw new Error("test_soak_invalid");
  const f = await machineBrowserFixture({ after: fn => cleanup.push(fn) }, {
    listenHost: "127.0.0.2", tlsPortProxy: true,
    lifetimeSeconds: soakSeconds + 180,
    observeStage: value => { stage = value; },
    hubPublicKey: await fs.readFile(process.env.MEET_TEST_HUB_PUBLIC_KEY, "utf8"),
    receiverKeyDelay: receiverKeyDelay === "1",
    browserLauncher: isolatedBrowser === "1" ? bridgeBrowserLauncher({ send: reply,
      receive: () => commands.next(), connect: (endpoint, options) => peerDriver.connect(endpoint, options) }) : undefined,
  });
  f.human.setDefaultTimeout(12000);
  if (process.env.MEET_DIALOG_GPU_GATE === "1" || process.env.MEET_DIALOG_OBSERVE === "1") {
    await f.human.evaluate(installDialogObservation);
    cleanup.push(() => f.human.evaluate(() => window.__dialogObservation.close()));
  }
  reply({ origin: f.origin, room_id: f.roomId, certificate: f.certificatePath, test_network: f.testNetwork });
  stage = "dialog";
  const panel = f.human.locator("app-machine-permissions-panel");
  let answersExpected = 0;
  for await (const line of commands) {
    if (line === "stop") break;
    const avatar = await observeAvatarCommand(line, f.human);
    if (avatar) { reply(avatar); continue; }
    if (line === "consent") {
      stage = "consent-live-navigation";
      await f.human.locator(".nav-item").filter({ hasText: /^Live/ }).click();
      stage = "consent-membership";
      await f.human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
      stage = "consent-panel-navigation";
      await f.human.locator("#mesh-analysis-navigation").click();
      stage = "consent-machine-selection";
      await panel.getByRole("button", { name: "Für diese KI einstellen" }).click();
      stage = "consent-chat-selection";
      await panel.getByLabel("Meine neuen Chatbeiträge", { exact: true }).check();
      stage = "consent-submit";
      await panel.getByRole("button", { name: "Auswahl ausdrücklich freigeben" }).click();
      stage = "consent-confirmation";
      await panel.getByText("Serverbestätigung erhalten.", { exact: true }).waitFor();
      stage = "dialog";
      reply({ consent: true });
    } else if (line === "ask") {
      await f.human.getByRole("button", { name: "Chat", exact: true }).click();
      await f.human.locator("#chat-form.large").waitFor();
      await f.human.locator("#chat-message").fill("@ananta synthetic cross-repository question");
      await f.human.locator("#chat-form button").click(); answersExpected++; reply({ sent: true });
    } else if (line === "answer_correlated") {
      reply(await observeDialogAnswer(f.human));
    } else if (line === "audio_reset") {
      await f.human.evaluate(() => window.__dialogObservation.resetAudio()); reply({ reset: true });
    } else if (line === "audio_absent") {
      await f.human.waitForFunction(() => !document.querySelector("#room-audio audio"), null, { timeout: 4000 });
      reply({ audio_absent: true });
    } else if (line === "audio_probe") {
      // Return diagnostics after a bounded observation even when audio is absent;
      // the parent asserts success instead of losing the cause in a timeout.
      reply(await f.human.evaluate(async () => {
        const deadline = performance.now() + 2000;
        while (window.__dialogObservation.status().active_windows <= 10
          && !window.__dialogObservation.status().failed && performance.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        const stats = (await Promise.all(window.__pcs.map(pc => pc.getStats()))).flatMap(report => [...report.values()])
          .filter(entry => entry.type === "inbound-rtp" && entry.kind === "audio");
        return { ...window.__dialogObservation.status(), captures: window.__captures,
          transform_errors: window.__transformErrors.length,
          received_packets: stats.reduce((sum, entry) => sum + (entry.packetsReceived || 0), 0),
          received_samples: stats.reduce((sum, entry) => sum + (entry.totalSamplesReceived || 0), 0) };
      }));
    } else if (line === "answer") {
      await f.human.locator("#chat-log").getByText("Synthetic Hub answer", { exact: false }).nth(answersExpected - 1).waitFor();
      reply({ received: true });
    } else if (line === "receiver_key_startup") {
      if (receiverKeyDelay !== "1") throw new Error("test_receiver_key_delay_invalid");
      reply(requireReceiverKeyDelay(await f.human.evaluate(() => window.__receiverKeyDelay)));
    } else if (line === "screen") {
      await f.human.locator(".nav-item").filter({ hasText: /^Live/ }).click();
      const fingerprints = new Set();
      const deadline = Date.now() + 12000;
      while (fingerprints.size < 2 && Date.now() < deadline) {
        const fingerprint = await f.human.evaluate(() => {
          const v = [...document.querySelectorAll("video")].find(v => v.videoWidth === 640 && v.srcObject && v.readyState >= 2);
          if (!v) return null; // Expected bounded gap while an activation renews.
          const c = document.createElement("canvas"); c.width = 64; c.height = 36;
          const ctx = c.getContext("2d"); ctx.drawImage(v, 0, 0, 64, 36);
          return [...ctx.getImageData(0, 0, 64, 36).data].reduce((n, b, i) => (n + b * (i + 1)) % 2147483647, 0);
        });
        if (fingerprint !== null) fingerprints.add(fingerprint);
        await f.human.waitForTimeout(250);
      }
      if (fingerprints.size < 2) {
        const error = new Error("screen_not_moving");
        // State/counts only: never ICE addresses, SDP, peer IDs, frames or keys.
        error.observation = await f.human.evaluate(async () => ({
          iceCounts: window.__testIce,
          transformErrors: window.__transformErrors.length,
          ...(window.__receiverKeyDelay ? { keyStartup: window.__receiverKeyDelay } : {}),
          videos: [...document.querySelectorAll("video")].map(v => ({ width: v.videoWidth, ready: v.readyState })),
          peers: await Promise.all(window.__pcs.map(async pc => ({
            connection: pc.connectionState, ice: pc.iceConnectionState, signaling: pc.signalingState,
            localDescription: Boolean(pc.localDescription), remoteDescription: Boolean(pc.remoteDescription),
            video: [...(await pc.getStats()).values()].filter(s => s.type === "inbound-rtp" && s.kind === "video")
              .map(s => ({ packets: s.packetsReceived, frames: s.framesDecoded,
                keyframes: s.keyFramesDecoded || 0, pliCount: s.pliCount || 0, nackCount: s.nackCount || 0 })),
          }))),
        }));
        error.observation.transformFailureCodes = await f.human.evaluate(transformFailureCounts);
        throw error;
      }
      reply({ moving_screen: true });
    } else if (line === "screen_absent") {
      await f.human.locator(".nav-item").filter({ hasText: /^Live/ }).click();
      await f.human.waitForFunction(() => ![...document.querySelectorAll("video")].some(v => v.videoWidth === 640 && v.srcObject));
      reply({ screen_absent: true });
    } else if (line === "private_frame_absent") {
      await f.human.locator(".nav-item").filter({ hasText: /^Live/ }).click();
      const safe = await f.human.evaluate(async () => {
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d"); const deadline = performance.now() + 5000;
        while (performance.now() < deadline) {
          const video = [...document.querySelectorAll("video")].find(v => v.videoWidth === 640 && v.srcObject);
          if (!video) return true;
          ctx.drawImage(video, 320, 180, 1, 1, 0, 0, 1, 1);
          const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
          if (r > 220 && b > 220 && g < 70) return false;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        return false; // Source must disappear, not just retain the old image.
      });
      if (!safe) throw new Error("test_private_frame_or_stop_failed");
      reply({ private_frame_absent: true });
    } else if (line === "alone") {
      await f.human.locator(".nav-item").filter({ hasText: /^Live/ }).click();
      await f.human.locator("#participant-count", { hasText: "1 / 20" }).waitFor(); reply({ alone: true });
    } else throw new Error("unknown_bridge_command");
  }
} catch (error) {
  const dockerFailure = /^test_docker_command_failed:(create|start|inspect|image|network|rm|logs|unknown):(\d{1,3}|unknown):(image_unavailable|image_platform|network_subnet|network_address|cpu_limit|permission|container_conflict|deadline|unknown)$/.test(error.message);
  const code = ["test_public_dir_invalid", "screen_not_moving", "avatar_not_moving", "test_private_frame_or_stop_failed", "test_tls_proxy_not_ready",
    "test_receiver_key_delay_invalid", "test_receiver_key_delay_not_observed",
    "test_navigation_network_changed", "test_navigation_deadline",
    "test_stun_start_failed", "test_docker_command_failed", "test_private_proxy_network_invalid"].includes(error.message)
    ? error.message : dockerFailure ? "test_docker_command_failed" : error.name === "TimeoutError" ? "test_browser_timeout" : "synthetic_meet_bridge_failed";
  process.stdout.write(JSON.stringify({ bridge_error: code, stage,
    ...(Number.isInteger(error.status) ? { command_status: error.status } : {}),
    ...(/net::(ERR_[A-Z_]{1,64})/.test(String(error.message)) ? { network_error: String(error.message).match(/net::(ERR_[A-Z_]{1,64})/)[1] } : {}),
    kind: ["Error", "TypeError", "TimeoutError"].includes(error.name) ? error.name : "Error",
    ...(error.startupObservation ? { startup: error.startupObservation } : {}),
    ...(["screen_not_moving", "avatar_not_moving", "test_receiver_key_delay_not_observed"].includes(code)
      && error.observation ? { observation: error.observation } : {}) }) + "\n");
  process.stderr.write("synthetic_meet_bridge_failed\n"); process.exitCode = 1;
} finally {
  for (const close of cleanup.reverse()) { try { await close(); } catch { process.exitCode = 1; } }
}
}
if (process.env.MEET_CROSS_REPOSITORY_GATE === "1" && process.env.MEET_TEST_HUB_PUBLIC_KEY) {
  await runBridge();
} else {
  // node --test discovers helper modules too. Never provision a bridge merely
  // because it was discovered, and do not hide the opt-in gate's absence.
  process.stdout.write("SKIP private Hub bridge: cross-repository fixture not enabled\n");
}
