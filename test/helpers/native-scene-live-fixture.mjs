import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { SignJWT, createLocalJWKSet, exportJWK } from "jose";
import { chromium } from "playwright";
import { createAppServer } from "../../src/server.js";
import { createOidcVerifier } from "../../src/oidc-verifier.js";
import { NativePackagerControlRegistry } from "../../src/native-packager-control.js";
import { nativeSceneProcesses } from "./native-scene-processes.mjs";
import { machineFixtureAssets } from "./machine-fixture-assets.mjs";
import { waitFixtureValue } from "./machine-browser-wait.mjs";
import { recordNativeSceneReply } from "./native-scene-reply-observation.mjs";

const execute = promisify(execFile);
async function unusedLoopbackPort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve)); return port;
}

export async function nativeSceneLiveFixture(t, { allowSyntheticScreen = false, allowSyntheticAudio = false, allowSyntheticScreenAudio = false } = {}) {
  assert.equal(typeof allowSyntheticScreen, "boolean");
  assert.equal(typeof allowSyntheticAudio, "boolean");
  assert.equal(typeof allowSyntheticScreenAudio, "boolean");
  assert.ok(!allowSyntheticScreenAudio || allowSyntheticScreen);
  let browser, tls, app;
  const observation = { http: [], native: [], scene: [] };
  t.after(async () => {
    await browser?.close();
    if (app) {
      for (const server of [app.webSocketServer, app.nativePackagerWebSocketServer, app.mediaAgentWebSocketServer].filter(Boolean)) {
        for (const socket of server.clients) socket.terminate();
        await new Promise(resolve => server.close(resolve));
      }
      app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    }
    if (tls?.listening) { tls.closeAllConnections(); await new Promise(resolve => tls.close(resolve)); }
  });
  const processes = await nativeSceneProcesses(t), directory = processes.directory;
  try {
    await execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", path.join(directory, "key.pem"), "-out", path.join(directory, "cert.pem")],
    { timeout: 10_000, maxBuffer: 16_384, signal: t.signal });
  } catch { throw new Error("scene_fixture_certificate_failed"); }
  await fs.chmod(path.join(directory, "key.pem"), 0o600);
  const certificate = await fs.readFile(path.join(directory, "cert.pem"));
  tls = https.createServer({ key: await fs.readFile(path.join(directory, "key.pem")), cert: certificate });
  await new Promise((resolve, reject) => { tls.once("error", reject); tls.listen(0, "127.0.0.1", resolve); });
  const origin = `https://127.0.0.1:${tls.address().port}`, issuer = "https://synthetic-identity.example/realm/scene";
  const identityKeys = generateKeyPairSync("ed25519"), signingKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const agentKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = { ...agentKeys.publicKey.export({ format: "jwk" }), ext: true };
  const packagerId = "pkr_aaaaaaaaaaaaaaaa", principal = `${issuer}|owner`;
  const definition = { id: packagerId, ownerPrincipal: principal, label: "Coupled scene fixture", platform: "linux", publicKey,
    keyFingerprint: createHash("sha256").update(`P-256\0${publicKey.x}\0${publicKey.y}`).digest("base64url") };
  await fs.writeFile(path.join(directory, "agent.pem"), agentKeys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  const gatewayPort = await unusedLoopbackPort();
  const gateway = processes.start("origin", { BROADCAST_ORIGIN_ROOT: processes.output, BROADCAST_ORIGIN_ADDRESS: `127.0.0.1:${gatewayPort}` });
  const config = { publicOrigin: origin, authMode: "required", oidcIssuer: issuer, oidcAudience: "human", oidcClientId: "human-browser",
    oidcAlgorithms: ["EdDSA"], nativePackagerSelfServiceEnabled: true, mediaE2eeMode: "required", stunUrls: [], turnServers: [],
    broadcastNativeOutputEnabled: true, broadcastGatewayOrigin: `http://127.0.0.1:${gatewayPort}`,
    broadcastSigningPrivateKey: signingKeys.privateKey.export({ type: "pkcs8", format: "pem" }), broadcastSigningKeyId: "fixture-key" };
  const oidcVerifier = createOidcVerifier(config, { jwks: createLocalJWKSet({ keys: [await exportJWK(identityKeys.publicKey)] }) });
  app = createAppServer({ config, oidcVerifier, publicDir: await machineFixtureAssets(process.env.MEET_TEST_PUBLIC_DIR),
    nativePackagers: new NativePackagerControlRegistry({ definitions: [definition] }),
    nativePackagerEnrollmentStore: { definitions: () => [definition], list: owner => owner === principal
      ? [{ ...definition, createdAt: 1, lastAuthenticatedAt: 1, revokedAt: 0 }] : [] },
    nativePackagerInstallerService: { availableTargets: () => [] } });
  app.nativePackagerWebSocketServer.on("connection", socket => socket.on("message", bytes => {
    if (bytes.length > 65536) return;
    try {
      const value = JSON.parse(bytes.toString());
      recordNativeSceneReply(observation.scene, value);
      if (observation.native.length < 32 && ["assignment-status", "trusted-source-status"].includes(value.type)) {
        const fixed = input => typeof input === "string" && /^[a-zA-Z_-]{1,64}$/.test(input) ? input : null;
        observation.native.push({ type: value.type, state: fixed(value.state), code: fixed(value.reasonCode) });
      }
    } catch { /* Never output raw protocol input. */ }
  }));
  tls.on("request", (req, res) => app.server.emit("request", req, res));
  tls.on("upgrade", (req, socket, head) => app.server.emit("upgrade", req, socket, head));
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const agent = processes.start("packager", { NATIVE_PACKAGER_CONTROL_URL: origin.replace("https:", "wss:") + "/native-packager",
    NATIVE_PACKAGER_ID: packagerId, NATIVE_PACKAGER_IDENTITY_FILE: path.join(directory, "agent.pem"),
    NATIVE_PACKAGER_OUTPUT_ROOT: processes.output, NATIVE_PACKAGER_SOURCE_PROGRAMS: "enabled", NATIVE_PACKAGER_SOURCE_BUDGET: "compact-v1",
    NATIVE_PACKAGER_MAX_RENDITIONS: "1", NATIVE_PACKAGER_FFMPEG: "ffmpeg" });
  const spki = createHash("sha256").update(new X509Certificate(certificate).publicKey.export({ type: "spki", format: "der" })).digest("base64");
  browser = await chromium.launch({ headless: true, args: [`--ignore-certificate-errors-spki-list=${spki}`] });
  const token = await new SignJWT({}).setIssuer(issuer).setAudience("human").setSubject("owner").setIssuedAt()
    .setExpirationTime("3m").setProtectedHeader({ alg: "EdDSA" }).sign(identityKeys.privateKey);
  const context = await browser.newContext({ permissions: [] });
  await context.addInitScript(({ token, allowSyntheticScreen, allowSyntheticAudio, allowSyntheticScreenAudio }) => {
    sessionStorage.setItem("webrtc.oidc.access-token", token);
    window.__sceneCaptures = 0;
    const syntheticVideo = color => {
      ++window.__sceneCaptures;
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
      const draw = canvas.getContext("2d"); let frame = 0;
      const paint = () => { draw.fillStyle = color === "#2020e0" && frame % 20 >= 10 ? "#2020b0" : color; draw.fillRect(0, 0, 640, 360);
        draw.fillStyle = "#404040"; draw.fillRect((frame++ % 20) * 20, 0, 20, 20); };
      paint(); const stream = canvas.captureStream(10), timer = setInterval(paint, 100);
      const track = stream.getVideoTracks()[0], stop = track.stop.bind(track);
      track.stop = () => { clearInterval(timer); canvas.width = canvas.height = 0; stop(); };
      return stream;
    };
    const syntheticAudio = async frequency => {
        const audio = new AudioContext({ sampleRate: 48000 }), tone = audio.createOscillator();
        const gain = audio.createGain(), destination = audio.createMediaStreamDestination();
        gain.gain.value = .25; tone.frequency.value = frequency;
        tone.connect(gain).connect(destination); tone.start(); await audio.resume();
        const track = destination.stream.getAudioTracks()[0], stop = track.stop.bind(track);
        let closed = false;
        track.stop = () => {
          if (closed) return; closed = true;
          tone.stop(); tone.disconnect(); gain.disconnect(); stop(); void audio.close();
        };
        return destination.stream;
    };
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (allowSyntheticAudio && constraints?.audio && !constraints.video) {
        ++window.__sceneCaptures;
        return syntheticAudio(440);
      }
      if (!constraints?.video || constraints.audio) throw new Error("fixture_capture_profile_denied");
      return syntheticVideo("#e02020");
    };
    navigator.mediaDevices.getDisplayMedia = async constraints => {
      if (!allowSyntheticScreen) throw new Error("fixture_display_capture_denied");
      const stream = syntheticVideo("#2020e0");
      if (allowSyntheticScreenAudio && constraints?.audio) {
        try { stream.addTrack((await syntheticAudio(880)).getAudioTracks()[0]); }
        catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
      }
      return stream;
    };
  }, { token, allowSyntheticScreen, allowSyntheticAudio, allowSyntheticScreenAudio });
  const page = await context.newPage();
  page.on("response", async response => {
    const pathname = new URL(response.url()).pathname;
    if (!pathname.startsWith("/api/broadcasts") || observation.http.length >= 32) return;
    const last = pathname.split("/").at(-1);
    const row = { status: response.status(), operation: ["broadcasts", "public", "mine", "native-source-programs", "native-handoff-control"].includes(last) ? last : "program", code: null };
    observation.http.push(row);
    if (last === "native-source-programs" && response.status() === 201) try {
      const body = await response.json(), a = body.assignment, p = body.program;
      row.shape = { top: Object.keys(body), assignment: Object.keys(a), program: Object.keys(p),
        inputMode: a.inputMode, profileId: a.profileId, state: a.state, reasonCode: a.reasonCode,
        revision: p.programRevision, epoch: p.programEpoch, assignmentEpoch: a.programEpoch,
        remainingMs: a.expiresAt - Date.now(), createdMs: a.createdAt, updatedMs: a.updatedAt };
    } catch { /* No raw response on malformed input. */ }
    if (response.status() >= 400) try {
      const body = await response.json(), code = body.error?.code ?? body.error;
      if (typeof code === "string" && /^[a-z_-]{1,80}$/.test(code)) row.code = code;
    } catch { /* Fixed status only for malformed responses. */ }
  });
  await page.goto(origin);
  await waitFixtureValue(page, () => Boolean(document.querySelector("#join-room")));
  const request = (method, pathname, body) => page.evaluate(async ({ method, pathname, body }) => {
    const response = await fetch(pathname, { method, headers: { "content-type": "application/json",
      authorization: `Bearer ${sessionStorage.getItem("webrtc.oidc.access-token")}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }, { method, pathname, body });
  const room = await request("POST", "/api/rooms", { mode: "room", title: "Coupled scene", visibility: "private" });
  assert.equal(room.status, 201);
  await page.goto(`${origin}/?room=${room.body.roomId}&mode=room`);
  await page.locator("#display-name").fill("Synthetic scene director");
  await page.locator("#join-room:not([disabled])").waitFor(); await page.locator("#join-room").press("Enter");
  await page.locator("#participant-count", { hasText: "1 / 20" }).waitFor({ timeout: 10_000 });
  return { app, browser, context, page, origin, roomId: room.body.roomId, packagerId, request, agent, gateway, output: processes.output, observation };
}
