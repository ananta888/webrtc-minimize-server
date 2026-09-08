// Ephemeral TLS + cryptographically verified synthetic identities. No production
// key, auth bypass, human capture, live OIDC provider or Internet ICE dependency.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { SignJWT, createLocalJWKSet, exportJWK } from "jose";
import { chromium, firefox } from "playwright";
import { createAppServer } from "../../src/server.js";
import { createOidcVerifier } from "../../src/oidc-verifier.js";
import { privateMachineTlsProxy } from "./machine-tls-proxy.js";
import { observeBrowserStartup } from "./machine-browser-startup.mjs";
import { navigateFixture } from "./machine-browser-navigation.mjs";
import { waitFixtureValue } from "./machine-browser-wait.mjs";
import { machineFixtureAssets } from "./machine-fixture-assets.mjs";
import { installReceiverKeyDelay } from "./machine-receiver-key-delay.mjs";

export async function machineBrowserFixture(t, { listenHost = "127.0.0.1", listenPort = 0, hubPublicKey, tlsPortProxy = false,
  lifetimeSeconds = 180, humanEngine = "chromium", observeStage = () => {},
  publicDir = process.env.MEET_TEST_PUBLIC_DIR, receiverKeyDelay = false } = {}) {
  if (typeof receiverKeyDelay !== "boolean") throw new Error("test_receiver_key_delay_invalid");
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 180 || lifetimeSeconds > 7380) throw new Error("test_lifetime_invalid");
  if (!["chromium", "firefox"].includes(humanEngine)) throw new Error("test_engine_invalid");
  observeStage("test-assets");
  const fixturePublicDir = await machineFixtureAssets(publicDir);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meet-machine-tls-"));
  let app, browser, humanBrowser, tls, proxy;
  t.after(async () => {
    try {
      await browser?.close();
      if (humanBrowser && humanBrowser !== browser) await humanBrowser.close();
      if (app) {
        for (const socket of app.webSocketServer.clients) socket.terminate();
        await new Promise(resolve => app.webSocketServer.close(resolve));
      }
      if (tls?.listening) { tls.closeAllConnections(); await new Promise(resolve => tls.close(resolve)); }
      if (app?.server.listening) { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); }
    } finally {
      try { proxy?.close(); } finally { await fs.rm(directory, { recursive: true, force: true }); }
    }
  });
  if (tlsPortProxy) {
    observeStage("private-network");
    proxy = privateMachineTlsProxy(lifetimeSeconds);
    listenHost = proxy.listenHost;
  }
  const originHost = proxy?.originHost || listenHost;
  observeStage("certificate");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", `/CN=${originHost}`, "-addext", `subjectAltName=IP:${originHost}`,
    "-keyout", path.join(directory, "key.pem"), "-out", path.join(directory, "cert.pem")], { stdio: "ignore" });
  tls = https.createServer({ key: await fs.readFile(path.join(directory, "key.pem")),
    cert: await fs.readFile(path.join(directory, "cert.pem")) });
  observeStage("tls-listen");
  await new Promise((resolve, reject) => { tls.once("error", reject); tls.listen(listenPort, listenHost, resolve); });
  const origin = `https://${originHost}${tlsPortProxy || tls.address().port === 443 ? "" : ":" + tls.address().port}`;
  observeStage("private-proxy-start"); proxy?.start(tls.address().port);
  const keys = generateKeyPairSync("ed25519"), humanKeys = generateKeyPairSync("ed25519");
  const issuer = "https://synthetic-hub.example.test";
  const config = { host: "127.0.0.1", port: 0, publicOrigin: origin, authMode: "required",
    oidcIssuer: issuer, oidcAudience: "human", oidcClientId: "human-browser", oidcAlgorithms: ["EdDSA"],
    oidcJwksUrl: issuer + "/jwks", machineHubIssuer: issuer,
    machineHubPublicKey: hubPublicKey || keys.publicKey.export({ type: "spki", format: "pem" }),
    stunUrls: proxy ? [proxy.stunUrl] : [], turnServers: [], mediaE2eeMode: "required", signalRateLimit: 400 };
  const oidcVerifier = createOidcVerifier(config, { jwks: createLocalJWKSet({ keys: [await exportJWK(humanKeys.publicKey)] }) });
  observeStage("signaling-server"); app = createAppServer({ config, oidcVerifier, publicDir: fixturePublicDir });
  tls.on("request", (req, res) => app.server.emit("request", req, res));
  tls.on("upgrade", (req, socket, head) => app.server.emit("upgrade", req, socket, head));
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  if (tlsPortProxy) {
    observeStage("private-proxy-health");
    const ca = await fs.readFile(path.join(directory, "cert.pem")), deadline = Date.now() + 5000;
    for (;;) {
      const ready = await new Promise(resolve => {
        const request = https.get(origin + "/healthz", { ca, timeout: 300 }, response => {
          response.resume(); resolve(response.statusCode === 200);
        });
        request.on("timeout", () => request.destroy()); request.on("error", () => resolve(false));
      });
      if (ready) break;
      if (Date.now() >= deadline) throw new Error("test_tls_proxy_not_ready");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  observeStage("browser-launch");
  browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  humanBrowser = humanEngine === "chromium" ? browser : await firefox.launch({ headless: true });
  async function page(machine = false) {
    const context = await (machine ? browser : humanBrowser).newContext({ permissions: [], ignoreHTTPSErrors: true });
    if (!machine && receiverKeyDelay) await context.addInitScript(installReceiverKeyDelay);
    await context.addInitScript(({ machine }) => {
      window.__captures = 0; window.__pcs = []; window.__transformErrors = [];
      window.__testIce = { emitted: 0, mdns: 0, received: 0, failed: 0 };
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker { constructor(...args) {
        super(...args); this.addEventListener("error", () => window.__transformErrors.push("worker_load_or_runtime_error"));
        this.addEventListener("message", ({ data }) => {
          if (data?.type === "transform-error") window.__transformErrors.push(data.code);
        });
      } };
      navigator.mediaDevices.getDisplayMedia = () => { ++window.__captures; throw new Error("human_display_forbidden"); };
      navigator.mediaDevices.getUserMedia = async () => {
        ++window.__captures;
        if (machine) throw new Error("human_capture_forbidden");
        // Human fixture only: a visible UI click starts an oscillator, never a device.
        const audio = new AudioContext(), oscillator = audio.createOscillator(), dest = audio.createMediaStreamDestination();
        oscillator.frequency.value = 440; oscillator.connect(dest); oscillator.start(); await audio.resume();
        dest.stream.getAudioTracks()[0].addEventListener("ended", () => audio.close());
        return dest.stream;
      };
      const Native = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Native {
        constructor(...args) { super(...args); window.__pcs.push(this);
          this.addEventListener("icecandidate", e => { if (e.candidate) {
            window.__testIce.emitted++; if (e.candidate.candidate.includes(".local")) window.__testIce.mdns++;
          } });
        }
        async addIceCandidate(candidate) { window.__testIce.received++;
          try { return await super.addIceCandidate(candidate); }
          catch (e) { window.__testIce.failed++; throw e; }
        }
      };
    }, { machine });
    if (!machine) {
      const token = await new SignJWT({ preferred_username: "Synthetic Human" }).setIssuer(issuer).setAudience("human")
        .setSubject(randomUUID()).setIssuedAt().setExpirationTime("3h").setProtectedHeader({ alg: "EdDSA" }).sign(humanKeys.privateKey);
      await context.addInitScript(value => sessionStorage.setItem("webrtc.oidc.access-token", value), token);
    }
    return context.newPage();
  }
  const human = await page();
  const humanStartup = observeBrowserStartup(human);
  let roomId;
  try {
    observeStage("human-navigation");
    await navigateFixture(human, origin, () => document.querySelector("#create-room")?.disabled === false);
    observeStage("human-room-create"); await human.locator("#create-room").click();
    await waitFixtureValue(human, () => document.querySelector("#room-id")?.value.startsWith("room-"));
    roomId = await human.locator("#room-id").inputValue();
    observeStage("human-room-join"); await human.locator("#join-room").click();
    await human.locator("#connection-status", { hasText: "Signaling verbunden" }).waitFor();
  } catch (error) { error.startupObservation = humanStartup; throw error; }
  function identity(subject) {
    const binding = { roomId, taskId: randomUUID(), tenantId: "synthetic", projectId: "synthetic",
      runtimeId: randomUUID(), sessionId: randomUUID() };
    async function grant(capabilities, version = 2, { expiresAt } = {}) {
      if (expiresAt !== undefined && (!Number.isInteger(expiresAt) || expiresAt <= Date.now() / 1000
        || expiresAt > Date.now() / 1000 + 120)) throw new Error("test_grant_expiry_invalid");
      const claims = { ...binding, ...(version === 2 ? { capabilities } : {}) };
      if (version === 1) { delete claims.runtimeId; delete claims.sessionId; }
      return new SignJWT(claims).setIssuer(issuer).setAudience(`ananta-meet-machine-v${version}`).setSubject(subject)
        .setIssuedAt().setExpirationTime(expiresAt ?? "2m").setJti(randomUUID())
        .setProtectedHeader({ alg: "EdDSA", typ: version === 2 ? "ananta-meet-machine-v2+jwt" : "ananta-meet-machine+jwt" }).sign(keys.privateKey);
    }
    return { binding, grant };
  }
  const { binding, grant } = identity("synthetic-machine");
  observeStage("machine-navigation");
  const machine = await page(true), startup = observeBrowserStartup(machine);
  try {
    await navigateFixture(machine, origin + "/machine", () => Boolean(window.anantaMachine));
    observeStage("machine-ready");
  } catch (error) { error.startupObservation = startup; throw error; }
  let additionalMachineCreated = false;
  async function additionalMachine() {
    if (additionalMachineCreated) throw new Error("test_machine_fixture_capacity");
    additionalMachineCreated = true;
    const second = await page(true);
    await navigateFixture(second, origin + "/machine", () => Boolean(window.anantaMachine));
    return { machine: second, ...identity("synthetic-machine-secondary") };
  }
  return { human, machine, roomId, binding, grant, additionalMachine, browser, app, origin, testNetwork: proxy?.network,
    certificatePath: path.join(directory, "cert.pem") };
}
