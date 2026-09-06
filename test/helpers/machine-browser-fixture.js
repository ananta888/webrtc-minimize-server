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

export async function machineBrowserFixture(t, { listenHost = "127.0.0.1", listenPort = 0, hubPublicKey, tlsPortProxy = false,
  lifetimeSeconds = 180, humanEngine = "chromium" } = {}) {
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 180 || lifetimeSeconds > 7380) throw new Error("test_lifetime_invalid");
  if (!["chromium", "firefox"].includes(humanEngine)) throw new Error("test_engine_invalid");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meet-machine-tls-"));
  let app, browser, humanBrowser, tls, proxyName;
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
      if (proxyName) { try { execFileSync("docker", ["stop", "-t", "1", proxyName], { stdio: "ignore" }); } catch { /* Bounded self-expiry. */ } }
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", `/CN=${listenHost}`, "-addext", `subjectAltName=IP:${listenHost}`,
    "-keyout", path.join(directory, "key.pem"), "-out", path.join(directory, "cert.pem")], { stdio: "ignore" });
  tls = https.createServer({ key: await fs.readFile(path.join(directory, "key.pem")),
    cert: await fs.readFile(path.join(directory, "cert.pem")) });
  await new Promise((resolve, reject) => { tls.once("error", reject); tls.listen(listenPort, listenHost, resolve); });
  const origin = `https://${listenHost}${tlsPortProxy || tls.address().port === 443 ? "" : ":" + tls.address().port}`;
  if (tlsPortProxy) {
    // Own loopback-only opaque TLS forwarder; no global sysctl/capability change,
    // host filesystem mount, production certificate or existing container edit.
    const image = execFileSync("docker", ["image", "inspect", process.env.MEET_TEST_PROXY_IMAGE || "webrtc-ci-local-webrtc:latest",
      "--format", "{{.Id}}"], { encoding: "utf8" }).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("test_proxy_image_missing");
    const name = "meet-test-tls-" + randomUUID();
    proxyName = name;
    const code = `const net=require('node:net');const server=net.createServer(s=>{const o=net.connect(${tls.address().port},${JSON.stringify(listenHost)});
      s.setTimeout(120000,()=>s.destroy());s.on('error',()=>o.destroy());o.on('error',()=>s.destroy());s.on('close',()=>o.destroy());o.on('close',()=>s.destroy());s.pipe(o);o.pipe(s)});
      server.maxConnections=16;server.listen(443,${JSON.stringify(listenHost)});setTimeout(()=>process.exit(0),${lifetimeSeconds * 1000})`;
    execFileSync("docker", ["run", "--rm", "-d", "--name", name, "--network=host", "--user=0:0", "--read-only",
      "--cap-drop=ALL", "--cap-add=NET_BIND_SERVICE", "--security-opt=no-new-privileges", "--memory=128m", "--pids-limit=32", "--cpus=.5",
      "--entrypoint=node", image, "--max-old-space-size=32", "-e", code], { stdio: "ignore" });
  }
  const keys = generateKeyPairSync("ed25519"), humanKeys = generateKeyPairSync("ed25519");
  const issuer = "https://synthetic-hub.example.test";
  const config = { host: "127.0.0.1", port: 0, publicOrigin: origin, authMode: "required",
    oidcIssuer: issuer, oidcAudience: "human", oidcClientId: "human-browser", oidcAlgorithms: ["EdDSA"],
    oidcJwksUrl: issuer + "/jwks", machineHubIssuer: issuer,
    machineHubPublicKey: hubPublicKey || keys.publicKey.export({ type: "spki", format: "pem" }),
    stunUrls: [], turnServers: [], mediaE2eeMode: "required", signalRateLimit: 400 };
  const oidcVerifier = createOidcVerifier(config, { jwks: createLocalJWKSet({ keys: [await exportJWK(humanKeys.publicKey)] }) });
  app = createAppServer({ config, oidcVerifier });
  tls.on("request", (req, res) => app.server.emit("request", req, res));
  tls.on("upgrade", (req, socket, head) => app.server.emit("upgrade", req, socket, head));
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  if (tlsPortProxy) {
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
  browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  humanBrowser = humanEngine === "chromium" ? browser : await firefox.launch({ headless: true });
  async function page(machine = false) {
    const context = await (machine ? browser : humanBrowser).newContext({ permissions: [], ignoreHTTPSErrors: true });
    await context.addInitScript(({ machine }) => {
      window.__captures = 0; window.__pcs = []; window.__transformErrors = [];
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
      window.RTCPeerConnection = class extends Native { constructor(...args) { super(...args); window.__pcs.push(this); } };
    }, { machine });
    if (!machine) {
      const token = await new SignJWT({ preferred_username: "Synthetic Human" }).setIssuer(issuer).setAudience("human")
        .setSubject(randomUUID()).setIssuedAt().setExpirationTime("3h").setProtectedHeader({ alg: "EdDSA" }).sign(humanKeys.privateKey);
      await context.addInitScript(value => sessionStorage.setItem("webrtc.oidc.access-token", value), token);
    }
    return context.newPage();
  }
  const human = await page();
  await human.goto(origin); await human.locator("#create-room").click();
  await human.waitForFunction(() => document.querySelector("#room-id")?.value.startsWith("room-"));
  const roomId = await human.locator("#room-id").inputValue();
  await human.locator("#join-room").click();
  await human.locator("#connection-status", { hasText: "Signaling verbunden" }).waitFor();
  const binding = { roomId, taskId: randomUUID(), tenantId: "synthetic", projectId: "synthetic",
    runtimeId: randomUUID(), sessionId: randomUUID() };
  async function grant(capabilities, version = 2) {
    const claims = { ...binding, ...(version === 2 ? { capabilities } : {}) };
    if (version === 1) { delete claims.runtimeId; delete claims.sessionId; }
    return new SignJWT(claims).setIssuer(issuer).setAudience(`ananta-meet-machine-v${version}`).setSubject("synthetic-machine")
      .setIssuedAt().setExpirationTime("2m").setJti(randomUUID())
      .setProtectedHeader({ alg: "EdDSA", typ: version === 2 ? "ananta-meet-machine-v2+jwt" : "ananta-meet-machine+jwt" }).sign(keys.privateKey);
  }
  const machine = await page(true); await machine.goto(origin + "/machine");
  await machine.waitForFunction(() => Boolean(window.anantaMachine));
  return { human, machine, roomId, binding, grant, browser, app, origin, certificatePath: path.join(directory, "cert.pem") };
}
