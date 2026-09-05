import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { build } from "esbuild";
import { chromium } from "playwright";

import { broadcastGrantDeviceProofMessage } from "../src/broadcast-device-proof.js";
import {
  BroadcastGrantAuthority,
  broadcastGrantPathHash,
} from "../src/broadcast-grant-authority.js";
import { broadcastSubjectRef, broadcastTenantRef, oidcPrincipal } from "../src/broadcast-identifiers.js";
import { deviceFingerprint } from "../src/device-proof.js";
import { MediaMtxExternalAuthError, MediaMtxExternalAuthService } from "../src/mediamtx-external-auth.js";

if (process.env.RUN_LIVE_MEDIAMTX_SECURE_AUTH !== "1") {
  console.log("SKIP secure MediaMTX authorization gate: set RUN_LIVE_MEDIAMTX_SECURE_AUTH=1 with Docker");
  process.exit(0);
}

const IMAGE = "bluenviron/mediamtx:1.20.1@sha256:1b029d11049be75630e9b73bb0d5f47b08a7db4eaee89a80bf8f53bc40e56414";
const RESOURCE = "res_aaaaaaaaaaaaaaaa";
const OTHER_RESOURCE = "res_bbbbbbbbbbbbbbbb";
const ROOM = "room-secure-gate";
const PROGRAM = "prg_aaaaaaaaaaaaaaaa";
const POLICY = "pol_aaaaaaaaaaaaaaaa";
const ISSUER = "https://identity.test/realms/ananta";
const container = `webrtc-mediamtx-secure-${process.pid}`;
const now = Date.now();
let sequence = 0;
let proofSequence = 0;
let authServer;
let browserServer;
let browser;
let temporaryDirectory;

function docker(args, options = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`docker_failed:${result.stderr.trim().slice(0, 1_000)}`);
  }
  return result.stdout.trim();
}

function signingKey(kid) {
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { kid, privateKey: pair.privateKey, publicKey: pair.publicKey };
}

function fixture(epoch = 7) {
  const identity = Object.freeze({
    issuer: ISSUER,
    subject: "secure-gate-owner",
    audience: "webrtc-room-server",
    algorithm: "RS256",
    issuedAt: now - 1_000,
    expiresAt: now + 5 * 60_000,
    displayName: "Secure gate",
  });
  const tenantId = broadcastTenantRef(identity.issuer);
  const subjectRef = broadcastSubjectRef(identity);
  const keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = keys.publicKey.export({ format: "jwk" });
  const fingerprint = deviceFingerprint(publicKey);
  const program = Object.freeze({
    contractVersion: 1,
    type: "broadcast-program",
    tenantId,
    ownerSubjectRef: subjectRef,
    roomId: ROOM,
    programId: PROGRAM,
    revision: 4,
    programEpoch: epoch,
    state: "degraded",
    visibility: "private",
    sourceIds: [],
    viewerPolicyId: POLICY,
    createdAt: now - 10_000,
    updatedAt: now - 1_000,
  });
  const membership = Object.freeze({
    active: true,
    tenantId,
    roomId: ROOM,
    subjectRef,
    principal: oidcPrincipal(identity),
    role: "owner",
    deviceFingerprint: fingerprint,
  });
  const grantee = Object.freeze({
    authorized: true,
    audienceRef: subjectRef,
    ownerSubjectRef: subjectRef,
    deviceFingerprint: fingerprint,
  });
  const viewerPolicy = Object.freeze({
    contractVersion: 1,
    type: "viewer-policy",
    tenantId,
    ownerSubjectRef: subjectRef,
    roomId: ROOM,
    programId: PROGRAM,
    policyId: POLICY,
    revision: 3,
    programEpoch: epoch,
    visibility: "private",
    authentication: "required",
    directoryListed: false,
    anonymousAllowed: false,
    allowedOriginHashes: [],
    updatedAt: now - 1_000,
  });
  return { identity, tenantId, subjectRef, keys, publicKey, fingerprint, program, membership, grantee, viewerPolicy };
}

function proof(input, value) {
  proofSequence += 1;
  const timestamp = Date.now();
  const nonce = Buffer.from(`secure-auth-proof-${proofSequence}`.padEnd(24, "x")).toString("base64url");
  const context = {
    tenantId: value.tenantId,
    subjectRef: value.subjectRef,
    roomId: input.roomId,
    programId: input.programId,
    programRevision: input.programRevision,
    programEpoch: input.programEpoch,
    grantKind: input.kind,
    tokenAudience: `broadcast-${input.kind}`,
    audienceRef: input.audienceRef,
    resourceRef: input.resourceRef,
    pathHash: broadcastGrantPathHash(input.pathPrefix),
    actions: [...input.actions].sort(),
  };
  return {
    publicKey: value.publicKey,
    timestamp,
    nonce,
    signature: crypto.sign(
      "sha256",
      Buffer.from(broadcastGrantDeviceProofMessage(context, timestamp, nonce)),
      { key: value.keys.privateKey, dsaEncoding: "ieee-p1363" },
    ).toString("base64url"),
  };
}

async function issue(authority, value, kind) {
  const playback = kind === "playback";
  const input = {
    grantVersion: 1,
    kind,
    roomId: ROOM,
    programId: PROGRAM,
    programRevision: value.program.revision,
    programEpoch: value.program.programEpoch,
    audienceRef: value.subjectRef,
    actions: playback ? ["playback:manifest", "playback:segment"] : ["whip:create"],
    resourceRef: RESOURCE,
    pathPrefix: playback ? `/broadcast/play/${RESOURCE}` : `/broadcast/ingest/${RESOURCE}`,
    ...(playback ? { policyId: POLICY, policyRevision: value.viewerPolicy.revision } : {}),
  };
  return authority.issue({ ...input, deviceProof: proof(input, value) }, {
    identity: value.identity,
    membership: value.membership,
    grantee: value.grantee,
    program: value.program,
    ...(playback ? { viewerPolicy: value.viewerPolicy } : {}),
  });
}

function readBody(request, maximum = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maximum) {
        reject(new Error("auth_body_too_large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function mappedPort(port, protocol = "tcp") {
  const mapping = docker(["port", container, `${port}/${protocol}`]);
  const match = mapping.match(/:(\d+)$/);
  assert.ok(match, `missing mapped port ${port}/${protocol}`);
  return Number(match[1]);
}

async function request(url, options, expected) {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000), ...options });
  assert.ok(expected.includes(response.status), `${options?.method || "GET"} ${new URL(url).pathname}: ${response.status}`);
  await response.body?.cancel();
  return response.status;
}

async function waitForGateway(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const status = await request(`http://127.0.0.1:${port}/unknown/whip`, {
        method: "POST",
        headers: { "content-type": "application/sdp" },
        body: "v=0\r\n",
      }, [401, 404]);
      if (status) return;
    } catch { /* bounded startup retry */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("secure_mediamtx_start_timeout");
}

try {
  const authority = new BroadcastGrantAuthority({
    issuer: "https://webrtc.test/broadcast-grants",
    oidcIssuer: ISSUER,
    oidcAudience: "webrtc-room-server",
    oidcAlgorithms: ["RS256"],
    signingKeys: [signingKey("secure-gate-1")],
    activeKid: "secure-gate-1",
    idFactory: () => `grt_${String(++sequence).padStart(16, "a")}`,
  });
  const authorized = [];
  const denied = [];
  const callbacks = [];
  const service = new MediaMtxExternalAuthService({
    authority,
    onAuthorized: ({ request: value, grant }) => authorized.push({
      action: value.action,
      protocol: value.protocol,
      resource: value.path,
      epoch: grant.programEpoch,
    }),
  });
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "webrtc-secure-mediamtx-"));
  const bundlePath = path.join(temporaryDirectory, "gate.js");
  await build({
    entryPoints: ["scripts/fixtures/whip-browser-live-gate.ts"],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome120"],
    outfile: bundlePath,
    logLevel: "silent",
  });
  const bundle = await readFile(bundlePath);
  const html = Buffer.from('<!doctype html><meta charset="utf-8"><button id="run-whip-gate">Run</button><script src="/gate.js"></script>');
  browserServer = http.createServer((incoming, response) => {
    const content = incoming.url === "/gate.js" ? bundle : html;
    response.writeHead(200, {
      "content-type": incoming.url === "/gate.js" ? "text/javascript" : "text/html",
      "content-length": content.length,
      "cache-control": "no-store",
    });
    response.end(content);
  });
  await new Promise((resolve, reject) => {
    browserServer.once("error", reject);
    browserServer.listen(8080, "127.0.0.1", resolve);
  });
  const browserAddress = browserServer.address();
  assert.ok(browserAddress && typeof browserAddress === "object");
  authServer = http.createServer(async (incoming, response) => {
    if (incoming.method !== "POST" || incoming.url !== "/internal/broadcast/mediamtx-auth"
      || incoming.headers["content-type"]?.split(";", 1)[0] !== "application/json") {
      response.writeHead(404).end();
      return;
    }
    let callback = null;
    try {
      const body = JSON.parse(await readBody(incoming));
      callback = {
        action: body.action,
        protocol: body.protocol,
        path: body.path,
        hasQuery: typeof body.query === "string" && body.query.length > 0,
        allowed: false,
      };
      callbacks.push(callback);
      const grant = await service.authorize(body);
      callback.allowed = true;
      callback.epoch = grant.programEpoch;
      response.writeHead(204).end();
    } catch (error) {
      const status = error instanceof MediaMtxExternalAuthError ? error.status : 400;
      denied.push(error instanceof Error ? error.message : "unknown_auth_error");
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "authorization_denied" }));
    }
  });
  await new Promise((resolve, reject) => {
    authServer.once("error", reject);
    authServer.listen(0, "0.0.0.0", resolve);
  });
  const address = authServer.address();
  assert.ok(address && typeof address === "object");

  docker([
    "run", "-d", "--rm", "--name", container,
    "--user", "65532:65532", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532",
    "--add-host", "host.docker.internal:host-gateway",
    "-p", "127.0.0.1::8888/tcp", "-p", "127.0.0.1::8889/tcp", "-p", "127.0.0.1:8189:8189/udp",
    "-v", `${process.cwd()}/infra/mediamtx/mediamtx.yml:/etc/mediamtx/mediamtx.yml:ro`,
    "-e", "MTX_AUTHMETHOD=http",
    "-e", `MTX_AUTHHTTPADDRESS=http://host.docker.internal:${address.port}/internal/broadcast/mediamtx-auth`,
    "-e", 'MTX_AUTHHTTPEXCLUDE=[{"action":"api"},{"action":"metrics"}]',
    "-e", "MTX_WEBRTCADDITIONALHOSTS=127.0.0.1",
    IMAGE, "/etc/mediamtx/mediamtx.yml",
  ]);
  const hlsPort = mappedPort(8888);
  const whipPort = mappedPort(8889);
  await waitForGateway(whipPort);

  const value = fixture();
  const publisher = await issue(authority, value, "publisher");
  const livePublisher = await issue(authority, value, "publisher");
  const playback = await issue(authority, value, "playback");
  const bearer = (token) => ({ authorization: `Bearer ${token}` });
  const invalidSdp = { method: "POST", headers: { "content-type": "application/sdp" }, body: "v=0\r\n" };

  await request(`http://127.0.0.1:${hlsPort}/${RESOURCE}/index.m3u8`, {
    redirect: "follow",
    headers: bearer(publisher.token),
  }, [401]);
  await request(`http://127.0.0.1:${whipPort}/${RESOURCE}/whip`, {
    ...invalidSdp, headers: { ...invalidSdp.headers, ...bearer(playback.token) },
  }, [401]);
  await request(`http://127.0.0.1:${hlsPort}/${OTHER_RESOURCE}/index.m3u8`, {
    redirect: "follow",
    headers: bearer(playback.token),
  }, [401]);
  await request(`http://127.0.0.1:${hlsPort}/${RESOURCE}/index.m3u8?token=${encodeURIComponent(playback.token)}`, {
    redirect: "follow",
  }, [401]);

  const publishStatus = await request(`http://127.0.0.1:${whipPort}/${RESOURCE}/whip`, {
    ...invalidSdp, headers: { ...invalidSdp.headers, ...bearer(publisher.token) },
  }, [406]);
  assert.equal(publishStatus, 406);
  assert.deepEqual(authorized.at(-1), { action: "publish", protocol: "webrtc", resource: RESOURCE, epoch: 7 });
  await request(`http://127.0.0.1:${whipPort}/${RESOURCE}/whip`, {
    ...invalidSdp, headers: { ...invalidSdp.headers, ...bearer(publisher.token) },
  }, [401]);

  const crossOriginPreflight = await fetch(`http://127.0.0.1:${whipPort}/${RESOURCE}/whip`, {
    method: "OPTIONS",
    headers: {
      origin: "https://evil.test",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  assert.notEqual(crossOriginPreflight.headers.get("access-control-allow-origin"), "*");
  assert.notEqual(crossOriginPreflight.headers.get("access-control-allow-origin"), "https://evil.test");
  await crossOriginPreflight.body?.cancel();
  const browserOrigin = `http://127.0.0.1:${browserAddress.port}`;
  const allowedPreflight = await fetch(`http://127.0.0.1:${whipPort}/${RESOURCE}/whip`, {
    method: "OPTIONS",
    headers: {
      origin: browserOrigin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(allowedPreflight.headers.get("access-control-allow-origin"), browserOrigin);
  await allowedPreflight.body?.cancel();

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${browserAddress.port}/`, { waitUntil: "networkidle" });
  await page.evaluate(({ endpoint, token }) => {
    window.__WHIP_GATE_ENDPOINT__ = endpoint;
    window.__WHIP_GATE_TOKEN__ = token;
    window.__WHIP_GATE_HOLD_MS__ = 20_000;
    window.__WHIP_GATE_SWITCHES__ = 0;
    window.__WHIP_GATE_VIDEO_CODEC__ = "video/h264";
  }, {
    endpoint: `http://127.0.0.1:${whipPort}/${RESOURCE}/whip`,
    token: livePublisher.token,
  });
  await page.click("#run-whip-gate");
  await page.waitForFunction(() => window.__whipGateConnected === true || Boolean(window.__whipGateResult), null, {
    timeout: 20_000,
  });
  const startupResult = await page.evaluate(() => window.__whipGateResult || null);
  assert.equal(await page.evaluate(() => window.__whipGateConnected), true, JSON.stringify(startupResult));
  let manifestStatus = 0;
  let manifestFound = false;
  let protectedManifestUrl = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const masterUrl = `http://127.0.0.1:${hlsPort}/${RESOURCE}/index.m3u8`;
      const response = await fetch(masterUrl, {
        headers: bearer(playback.token),
        redirect: "follow",
        signal: AbortSignal.timeout(10_000),
      });
      manifestStatus = response.status;
      const content = await response.text();
      const child = content.split(/\r?\n/).find((line) => line && !line.startsWith("#"));
      if (response.status === 200 && content.startsWith("#EXTM3U") && child) {
        protectedManifestUrl = new URL(child, masterUrl).href;
        const media = await fetch(protectedManifestUrl, {
          headers: bearer(playback.token),
          redirect: "follow",
          signal: AbortSignal.timeout(10_000),
        });
        manifestStatus = media.status;
        const mediaContent = await media.text();
        manifestFound = media.status === 200 && mediaContent.startsWith("#EXTM3U");
      }
    } catch (error) {
      if (error?.name !== "TimeoutError") throw error;
    }
    if (manifestFound) break;
    assert.notEqual(manifestStatus, 401, "valid epoch-bound HLS grant was rejected");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(manifestFound, true);
  assert.ok(callbacks.some(({ action, protocol, path: resource, epoch, allowed }) => (
    action === "read" && protocol === "hls" && resource === RESOURCE && epoch === 7 && allowed
  )));
  authority.revokeProgramEpoch(value.tenantId, PROGRAM, 7);
  await request(`${protectedManifestUrl}?revoked=1`, {
    redirect: "follow",
    headers: bearer(playback.token),
  }, [401]);

  const next = fixture(8);
  const beforeRotation = await issue(authority, next, "playback");
  authority.rotateSigningKey(signingKey("secure-gate-2"));
  await request(`${protectedManifestUrl}?rotation=1`, {
    redirect: "follow",
    headers: bearer(beforeRotation.token),
  }, [401]);
  await page.waitForFunction(() => Boolean(window.__whipGateResult), null, { timeout: 40_000 });
  const browserResult = await page.evaluate(() => window.__whipGateResult);
  assert.equal(browserResult?.connected, true);
  assert.equal(browserResult?.stopped, true);

  const inspect = JSON.parse(docker(["inspect", container]))[0];
  assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspect.HostConfig.Privileged, false);
  assert.ok(inspect.HostConfig.CapDrop.includes("ALL"));
  assert.deepEqual(Object.keys(inspect.NetworkSettings.Ports).filter((port) => (
    inspect.NetworkSettings.Ports[port] !== null
  )).sort(), ["8189/udp", "8888/tcp", "8889/tcp"]);
  assert.ok(authorized.some(({ action, protocol, epoch }) => action === "publish" && protocol === "webrtc" && epoch === 7));
  assert.ok(callbacks.some(({ action, protocol, epoch, allowed }) => (
    action === "read" && protocol === "hls" && epoch === 7 && allowed
  )));
  assert.ok(denied.length >= 5);
  console.log("PASS secure MediaMTX authorization: action/path/protocol binding, single-use publish, HLS read, epoch revoke and key rotation fail closed");
} finally {
  if (browser) await browser.close();
  try { docker(["rm", "-f", container], { stdio: "ignore" }); } catch { /* primary failure wins */ }
  if (authServer) await new Promise((resolve) => authServer.close(resolve));
  if (browserServer) await new Promise((resolve) => browserServer.close(resolve));
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
