// Private observation-only bridge for two real Ananta Worker containers.
// It accepts expected Hub principal subjects, never grants or policy overrides.
import fs from "node:fs/promises";
import readline from "node:readline";
import { machineBrowserFixture } from "./machine-browser-fixture.js";
import { waitFixtureValue } from "./machine-browser-wait.mjs";
import { multiHubMedia } from "./machine-multi-hub-media.mjs";
import { multiHubIcePath, observeMultiHubRelay } from "./machine-multi-hub-relay.mjs";
import { MultiHubReconnect, interruptMultiHubMember } from "./machine-multi-hub-reconnect.mjs";

function screenSignatures(peers) {
  return peers.map(peer => {
    const element = [...document.querySelectorAll('.remote-media[data-source="screen"]')].find(el => el.dataset.peerId === peer);
    const video = element?.querySelector("video");
    if (!video?.srcObject || video.videoWidth !== 640 || video.videoHeight !== 360 || video.readyState < 2) return null;
    const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 36;
    const ctx = canvas.getContext("2d"); ctx.drawImage(video, 0, 0, 64, 36);
    const signature = ctx.getImageData(0, 0, 64, 36).data.reduce((n, b, i) => (n + b * (i + 1)) % 2147483647, 0);
    canvas.width = canvas.height = 0; return signature;
  });
}

async function moving(page, peers, survivor) {
  const signatures = [new Set(), new Set()];
  try { await waitFixtureValue(page, screenSignatures, peers, { timeout: 12000, accept: values => {
    if (survivor && values[0] !== null) return false;
    values.forEach((v, i) => { if (v !== null && signatures[i].size < 2) signatures[i].add(v); });
    return signatures[1].size === 2 && (survivor || signatures[0].size === 2);
  } }); } catch {
    const error = new Error("test_multi_screen_deadline");
    error.observation = await page.evaluate(async peers => ({
      transformErrors: window.__transformErrors.length,
      iceEvents: window.__testIce,
      screens: peers.map(peer => [...document.querySelectorAll('.remote-media[data-source="screen"]')]
        .filter(el => el.dataset.peerId === peer).slice(0, 2).map(el => {
          const video = el.querySelector("video"); return { width: video?.videoWidth || 0,
            height: video?.videoHeight || 0, ready: video?.readyState || 0, stream: Boolean(video?.srcObject) };
        })),
      connections: await Promise.all(window.__pcs.slice(0, 4).map(async pc => ({
        connection: pc.connectionState, ice: pc.iceConnectionState, signaling: pc.signalingState,
        gathering: pc.iceGatheringState, sctp: pc.sctp?.state || "absent",
        dtls: pc.sctp?.transport?.state || "absent", policy: pc.getConfiguration().iceTransportPolicy,
        localDescription: pc.localDescription?.type || "absent", remoteDescription: pc.remoteDescription?.type || "absent",
        video: [...(await pc.getStats()).values()].filter(s => s.type === "inbound-rtp" && s.kind === "video")
          .slice(0, 2).map(s => ({ packets: s.packetsReceived || 0, frames: s.framesDecoded || 0 })),
      }))),
    }), peers);
    throw error;
  }
  return { moving: signatures.map(s => s.size === 2), departedAbsent: survivor };
}

async function run() {
  const cleanup = []; let stage = "setup", timer, fixture, media;
  const reply = value => process.stdout.write(JSON.stringify(value) + "\n");
  try {
    const icePath = multiHubIcePath(process.env.MEET_MULTI_WORKER_ICE_PATH);
    const f = await machineBrowserFixture({ after: fn => cleanup.push(fn) }, {
      listenHost: "127.0.0.2", tlsPortProxy: true, lifetimeSeconds: 300, tlsConnectionLimit: 32,
      icePath, relayParticipants: 3,
      observeStage(value) { stage = "setup-" + value; },
      hubPublicKey: await fs.readFile(process.env.MEET_TEST_HUB_PUBLIC_KEY, "utf8"),
    });
    fixture = f;
    const reconnect = process.env.MEET_MULTI_WORKER_RECONNECT_GATE === "1" ? new MultiHubReconnect(f.app.registry, f.roomId) : null;
    f.human.setDefaultTimeout(12000);
    media = process.env.MEET_MULTI_WORKER_MEDIA_GATE === "1" ? await multiHubMedia(f) : null;
    if (media) cleanup.push(() => media.close());
    reply({ origin: f.origin, room_id: f.roomId, certificate: f.certificatePath, test_network: f.testNetwork,
      ...(icePath !== "direct" ? { ice_path: icePath, turn_url: f.turnUrl } : {}) });
    let peers = null, commands = 0;
    timer = setTimeout(() => process.stdin.destroy(), 240000);
    for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      if (++commands > (reconnect && media ? 32 : 24) || line.length > 1024) throw new Error("test_multi_bridge_budget");
      if (line === "stop") break;
      const input = JSON.parse(line);
      if (media && peers && ["consent", "ask", "answers", "media", "floor-start", "floor-result", ...(reconnect ? ["recovered-media", "answer-count"] : [])].includes(input.command)) {
        stage = input.command === "media" && ["avatars", "first-speech", "both-speech", "first-revoked", "survivor"].includes(input.phase)
          ? "media-" + input.phase : input.command;
        reply(await media.command(input, peers)); continue;
      }
      if (input.command === "bind") {
        stage = "bind";
        if (peers || Object.keys(input).length !== 2 || !Array.isArray(input.subjects) || input.subjects.length !== 2
          || input.subjects[0] === input.subjects[1] || !input.subjects.every(v => typeof v === "string" && /^org-agent-[a-f0-9]{64}$/.test(v))) {
          throw new Error("test_multi_binding_invalid");
        }
        stage = "bind-participants";
        await f.human.locator("#participant-count", { hasText: "3 / 20" }).waitFor();
        stage = "bind-identities";
        const members = input.subjects.map(subject => f.app.registry.members(f.roomId).filter(member =>
          member.machine && member.principal === "https://synthetic-hub.example.test|machine:" + subject));
        if (members.some(group => group.length !== 1) || members[0][0].deviceFingerprint === members[1][0].deviceFingerprint) {
          throw new Error("test_multi_binding_invalid");
        }
        peers = members.map(group => group[0].id);
        reply({ matchedPrincipals: 2, distinctDevices: true, participants: 3 });
      } else if (reconnect && peers && Object.keys(input).length === 1 && input.command === "disconnect") {
        stage = "disconnect";
        reply(await interruptMultiHubMember(f.human, reconnect, peers));
      } else if (reconnect && peers && Object.keys(input).length === 1 && input.command === "recovered") {
        stage = "recovered";
        await f.human.locator("#participant-count", { hasText: "3 / 20" }).waitFor();
        peers = reconnect.replace(peers);
        reply({ rejoined: true, participants: 3, retiredAbsent: true, sameDevice: true });
      } else if (Object.keys(input).length === 1 && ["screens", "survivor"].includes(input.command) && peers) {
        stage = input.command;
        await f.human.locator(".nav-item").filter({ hasText: /^Live/ }).click();
        if (stage === "survivor") await f.human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
        const screen = await moving(f.human, peers, stage === "survivor");
        reply({ ...screen, ...(icePath !== "direct" ? {
          relay: await observeMultiHubRelay(f.human, stage === "survivor" ? 1 : 2, icePath.slice(5)),
        } : {}) });
      } else if (Object.keys(input).length === 1 && input.command === "alone") {
        stage = "alone";
        await f.human.locator("#participant-count", { hasText: "1 / 20" }).waitFor();
        reply({ alone: true, connectionDrops: f.proxyObservation().connectionDrops,
          captures: await f.human.evaluate(() => window.__captures),
          transformErrors: await f.human.evaluate(() => window.__transformErrors.length) });
      } else throw new Error("test_multi_command_invalid");
    }
  } catch (error) {
    reply({ bridge_error: "test_multi_bridge_failed", stage,
      ...(typeof error.message === "string" && /^test_docker_command_failed:(create|start|inspect|image|network|rm|logs|unknown):(unknown|\d{1,3}):(unknown|image_unavailable|image_platform|network_subnet|network_address|cpu_limit|permission|container_conflict|deadline)$/.test(error.message)
        ? { infrastructure: error.message } : {}),
      ...(["floor-start", "floor-result"].includes(stage) ? { floor_error: [
        "test_floor_observer_binding_invalid", "test_floor_observer_connection_invalid",
        "test_floor_observer_audio_unavailable", "test_floor_observation_failed",
        "test_fixture_wait_deadline", "test_fixture_wait_non_value",
      ].find(code => String(error.message).includes(code)) || "unclassified" } : {}),
      proxy: fixture?.proxyObservation(),
      ...(media ? { media: media.diagnostic(), timeout: error.name === "TimeoutError" } : {}),
      ...(error.message === "test_multi_screen_deadline" ? { observation: error.observation } : {}) }); process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    for (const close of cleanup.reverse()) { try { await close(); } catch { process.exitCode = 1; } }
  }
}

if (process.env.MEET_MULTI_WORKER_GATE === "1" && process.env.MEET_TEST_HUB_PUBLIC_KEY) await run();
else process.stdout.write("SKIP private two-Worker bridge: isolated gate not enabled\n");
