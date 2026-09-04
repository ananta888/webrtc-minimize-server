import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";

import { createAppServer } from "../src/server.js";
import { deviceProofMessage } from "../src/device-proof.js";
import {
  mediaAgentAuthProof,
  mediaAgentEnrollmentProofMessage,
  mediaAgentSignatureMessage,
} from "../src/media-agent-protocol.js";
import { AuthenticationError } from "../src/oidc-verifier.js";
import { MediaMtxExternalAuthError } from "../src/mediamtx-external-auth.js";
import { BroadcastHlsProxyError } from "../src/broadcast-hls-proxy.js";

async function startTestServer(overrides = {}, serverOptions = {}) {
  const config = {
    host: "127.0.0.1",
    port: 0,
    publicOrigin: "",
    stunUrls: ["stun:stun.test:3478"],
    turnServers: [],
    maxRoomParticipants: 20,
    roomIdleTtlMs: 60_000,
    signalRateLimit: 120,
    pairWorkspaceEnabled: false,
    ...overrides,
  };
  const app = createAppServer({ config, ...serverOptions });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const port = app.server.address().port;
  return {
    ...app,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    async close() {
      for (const socket of app.webSocketServer.clients) socket.terminate();
      await new Promise((resolve) => app.server.close(resolve));
    },
  };
}

function connect(url, origin) {
  const socket = new WebSocket(url, { origin });
  const messages = [];
  const waiters = new Set();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    for (const waiter of waiters) waiter();
  });
  return {
    socket,
    async next(predicate = () => true, timeoutMs = 2000) {
      const existing = messages.findIndex(predicate);
      if (existing >= 0) return messages.splice(existing, 1)[0];
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(check);
          reject(new Error("timed out waiting for WebSocket message"));
        }, timeoutMs);
        function check() {
          const index = messages.findIndex(predicate);
          if (index < 0) return;
          clearTimeout(timeout);
          waiters.delete(check);
          resolve(messages.splice(index, 1)[0]);
        }
        waiters.add(check);
      });
    },
  };
}

function createDevice() {
  return crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

function signedDeviceProof(device, { roomId, displayName, mode = "room" }, overrides = {}) {
  const timestamp = overrides.timestamp ?? Date.now();
  const nonce = overrides.nonce || crypto.randomBytes(24).toString("base64url");
  const signature = crypto.sign(
    "sha256",
    Buffer.from(deviceProofMessage({ roomId, displayName, mode, timestamp, nonce })),
    { key: device.privateKey, dsaEncoding: "ieee-p1363" },
  ).toString("base64url");
  return {
    publicKey: device.publicKey.export({ format: "jwk" }),
    timestamp,
    nonce,
    signature,
    ...overrides,
  };
}

async function authorize(app, roomId, displayName, options = {}) {
  const mode = options.mode || "room";
  const device = options.device || createDevice();
  const response = await fetch(`${app.httpUrl}/api/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: options.origin || app.httpUrl,
      ...(options.authorization ? { authorization: options.authorization } : {}),
    },
    body: JSON.stringify({
      roomId,
      displayName,
      mode,
      deviceProof: signedDeviceProof(device, { roomId, displayName, mode }, options.proofOverrides),
      ...(options.workspaceInvite ? { workspaceInvite: options.workspaceInvite } : {}),
    }),
  });
  const body = await response.json();
  return { response, body, device };
}

async function connectAuthorized(app, roomId, displayName, options = {}) {
  const authorization = await authorize(app, roomId, displayName, options);
  assert.equal(authorization.response.status, 201, JSON.stringify(authorization.body));
  return {
    ...connect(`${app.wsUrl}${authorization.body.signalingPath}`, options.wsOrigin || app.httpUrl),
    authorization,
  };
}

test("HTTP surface serves health, runtime config, rooms and app", async (context) => {
  const app = await startTestServer();
  context.after(() => app.close());

  const health = await fetch(`${app.httpUrl}/healthz`).then((response) => response.json());
  assert.deepEqual(health, { status: "ok", rooms: 0, participants: 0 });

  const configResponse = await fetch(`${app.httpUrl}/config`);
  assert.deepEqual(await configResponse.json(), {
    iceServers: [{ urls: "stun:stun.test:3478" }],
    maxRoomParticipants: 20,
    auth: {
      mode: "disabled", issuer: "", clientId: "webrtc-browser", audience: "webrtc-room-server",
    },
    pairParticipants: 2,
    turnConfigured: false,
    edgeRelayConfigured: false,
    mediaE2ee: {
      mode: "required",
      cipherSuite: "AES_128_GCM_SHA256_128",
      frameEnvelope: "codec-prefix-v1",
    },
    mediaAgents: {
      configured: false,
      selfService: false,
      targets: [],
      unsignedArtifacts: false,
      leaseMs: 30_000,
      maxStandbys: 2,
      minimumParticipants: 3,
      shardMinParticipants: 6,
    },
    broadcast: {
      whip: {
        configurationVersion: 1,
        compatibilityProfile: "rfc9725",
        enabled: false,
        endpointUrl: "",
        allowedRedirectOrigins: [],
        trickleIce: true,
        simulcast: { enabled: false, sendEncodings: [] },
        codecPreferences: {
          audio: ["audio/opus"],
          video: ["video/vp8", "video/h264"],
        },
        requestTimeoutMs: 8_000,
        iceGatheringTimeoutMs: 10_000,
        connectionTimeoutMs: 20_000,
        maximumResponseBytes: 128 * 1024,
        maximumSdpBytes: 64 * 1024,
        maximumIceFragmentBytes: 16 * 1024,
        maximumCandidates: 64,
        retryBudget: 1,
      },
    },
    optimization: {
      activeSpeakerLimit: 5,
      peerRelayEnabled: true,
      peerRelayMinParticipants: 3,
      peerRelayMaxChildren: 3,
      peerRelayMaxHops: 3,
      routeLeaseMs: 60_000,
      dataOverlayEnabled: true,
    },
    pairWorkspaceEnabled: false,
  });
  assert.match(configResponse.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(configResponse.headers.get("content-security-policy"), /script-src 'self' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(configResponse.headers.get("content-security-policy"), /'unsafe-eval'/);
  assert.match(configResponse.headers.get("content-security-policy"), /worker-src 'self' blob:/);
  assert.match(configResponse.headers.get("content-security-policy"), /connect-src[^;]+https:\/\/raw\.githubusercontent\.com/);
  assert.doesNotMatch(configResponse.headers.get("content-security-policy"), /connect-src[^;]+blob:/);

  const roomResponse = await fetch(`${app.httpUrl}/api/rooms`, { method: "POST" });
  assert.equal(roomResponse.status, 201);
  const room = await roomResponse.json();
  assert.match(room.roomId, /^room-[a-f0-9]{18}$/);
  assert.equal(room.mode, "room");
  assert.equal(room.inviteUrl, `${app.httpUrl}/?room=${room.roomId}&mode=room`);

  const indexResponse = await fetch(app.httpUrl);
  assert.equal(indexResponse.status, 200);
  assert.match(await indexResponse.text(), /<app-root>/);

  const workerResponse = await fetch(`${app.httpUrl}/assets/vosk-worker.js`);
  assert.equal(workerResponse.status, 200);
  assert.match(workerResponse.headers.get("content-security-policy"), /script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'/);
  assert.match(workerResponse.headers.get("content-security-policy"), /connect-src[^;]+blob:/);
  assert.match(await workerResponse.text(), /new RecognizerWorker\(\)/);
});

test("internal MediaMTX callback is default-deny, IP-bound and content-free", async (context) => {
  const disabled = await startTestServer();
  context.after(() => disabled.close());
  assert.equal((await fetch(`${disabled.httpUrl}/internal/broadcast/mediamtx-auth`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  })).status, 404);

  const requests = [];
  const service = {
    async authorize(value) {
      requests.push(value);
      if (value.token === "denied-token-value") throw new MediaMtxExternalAuthError("inactive_broadcast_grant", 401);
      return {};
    },
  };
  const enabled = await startTestServer({
    broadcastGatewayAuthEnabled: true,
    broadcastGatewayAuthAddresses: ["127.0.0.1"],
  }, { mediaMtxExternalAuthService: service });
  context.after(() => enabled.close());
  const body = {
    user: "", password: "", token: "valid-synthetic-token", ip: "172.30.40.3",
    action: "publish", path: "res_aaaaaaaaaaaaaaaa", protocol: "webrtc",
    id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8", query: "", userAgent: "MediaMTX/1.20.1",
  };
  const accepted = await fetch(`${enabled.httpUrl}/internal/broadcast/mediamtx-auth`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal(accepted.status, 204);
  assert.equal(await accepted.text(), "");
  assert.deepEqual(requests, [body]);

  assert.equal((await fetch(`${enabled.httpUrl}/internal/broadcast/mediamtx-auth`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.test" },
    body: JSON.stringify(body),
  })).status, 404);
  assert.equal((await fetch(`${enabled.httpUrl}/internal/broadcast/mediamtx-auth`, {
    method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body),
  })).status, 404);
  assert.equal((await fetch(`${enabled.httpUrl}/internal/broadcast/mediamtx-auth?token=forbidden`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })).status, 404);
  const denied = await fetch(`${enabled.httpUrl}/internal/broadcast/mediamtx-auth`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, token: "denied-token-value" }),
  });
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { error: "inactive_broadcast_grant" });
});

test("private broadcast delivery exchanges a bearer for HttpOnly cookie and proxies only scoped media", async (context) => {
  const calls = [];
  const broadcastHlsProxy = {
    async createSession(input) {
      calls.push({ kind: "create", input });
      if (input.authorizationHeader !== "Bearer playback-grant") {
        throw new BroadcastHlsProxyError("broadcast_playback_not_found", 404);
      }
      return {
        playbackSessionId: "pbs_aaaaaaaaaaaaaaaaaaaaaaaa",
        manifestUrl: "/broadcast/play/res_aaaaaaaaaaaaaaaa/index.m3u8",
        expiresAt: Date.now() + 60_000,
        setCookie: "__Secure-webrtc-broadcast-aaaaaaaaaaaa=pbs_aaaaaaaaaaaaaaaaaaaaaaaa; Path=/broadcast/play/res_aaaaaaaaaaaaaaaa/; Max-Age=60; Secure; HttpOnly; SameSite=Strict",
      };
    },
    async fetchMedia(input) {
      calls.push({ kind: "media", input });
      return {
        status: 200,
        headers: { "content-type": "application/vnd.apple.mpegurl", "cache-control": "private, no-store" },
        body: new Response("#EXTM3U\n").body,
      };
    },
    closeSession(input) {
      calls.push({ kind: "close", input });
      return "__Secure-webrtc-broadcast-aaaaaaaaaaaa=; Path=/broadcast/play/res_aaaaaaaaaaaaaaaa/; Max-Age=0; Secure; HttpOnly; SameSite=Strict";
    },
  };
  const app = await startTestServer({ publicOrigin: "https://webrtc.ananta.de" }, { broadcastHlsProxy });
  context.after(() => app.close());

  const opened = await fetch(`${app.httpUrl}/api/broadcast/playback-sessions`, {
    method: "POST",
    headers: {
      authorization: "Bearer playback-grant", "content-type": "application/json",
      origin: "https://webrtc.ananta.de",
    },
    body: JSON.stringify({ resourceRef: "res_aaaaaaaaaaaaaaaa" }),
  });
  assert.equal(opened.status, 201);
  assert.match(opened.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const session = await opened.json();
  assert.doesNotMatch(session.manifestUrl, /token|grant/i);
  const cookie = opened.headers.get("set-cookie").split(";", 1)[0];
  const manifest = await fetch(`${app.httpUrl}${session.manifestUrl}?_HLS_msn=3`, {
    headers: { cookie, origin: "https://webrtc.ananta.de" },
  });
  assert.equal(manifest.status, 200);
  assert.equal(await manifest.text(), "#EXTM3U\n");
  assert.equal(manifest.headers.get("cache-control"), "private, no-store");

  const closed = await fetch(`${app.httpUrl}/api/broadcast/playback-sessions/${session.playbackSessionId}`, {
    method: "DELETE", headers: { cookie, origin: "https://webrtc.ananta.de" },
  });
  assert.equal(closed.status, 204);
  assert.match(closed.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal(calls[1].input.query, "?_HLS_msn=3");
  assert.equal(calls[2].input.cookieHeader, cookie);

  assert.equal((await fetch(`${app.httpUrl}/api/broadcast/playback-sessions`, {
    method: "POST",
    headers: { authorization: "Bearer playback-grant", "content-type": "application/json", origin: "https://evil.test" },
    body: JSON.stringify({ resourceRef: "res_aaaaaaaaaaaaaaaa" }),
  })).status, 404);
});

test("two room peers receive membership and target-bound signals", async (context) => {
  const app = await startTestServer();
  context.after(() => app.close());
  const origin = app.httpUrl;
  const ada = await connectAuthorized(app, "room-alpha", "Ada");
  const adaWelcome = await ada.next((message) => message.type === "welcome");
  const grace = await connectAuthorized(app, "room-alpha", "Grace");
  const graceWelcome = await grace.next((message) => message.type === "welcome");
  const joined = await ada.next((message) => message.type === "peer-joined");
  assert.equal(joined.peer.id, graceWelcome.peerId);
  assert.deepEqual(graceWelcome.peers, [{ id: adaWelcome.peerId, name: "Ada" }]);

  grace.socket.send(JSON.stringify({
    type: "signal",
    to: adaWelcome.peerId,
    description: { type: "offer", sdp: "v=0\r\n" },
  }));
  const signal = await ada.next((message) => message.type === "signal");
  assert.equal(signal.from, graceWelcome.peerId);
  assert.equal(signal.fromName, "Grace");
  assert.deepEqual(signal.description, { type: "offer", sdp: "v=0\r\n" });
  assert.equal(Object.hasOwn(signal, "to"), false);

  const coordinate = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  grace.socket.send(JSON.stringify({
    type: "overlay-key",
    key: { kty: "EC", crv: "P-256", x: coordinate, y: coordinate, ext: true },
  }));
  const overlayKey = await ada.next((message) => message.type === "overlay-key");
  assert.equal(overlayKey.from, graceWelcome.peerId);
  assert.ok(overlayKey.membershipEpoch >= 2);

  grace.socket.close();
  const left = await ada.next((message) => message.type === "peer-left");
  assert.equal(left.peerId, graceWelcome.peerId);
  ada.socket.close();
});

test("explicit leave releases membership before the transport close completes", async (context) => {
  const app = await startTestServer();
  context.after(() => app.close());
  const observer = await connectAuthorized(app, "room-leave", "Observer");
  await observer.next((message) => message.type === "welcome");
  const leaving = await connectAuthorized(app, "room-leave", "Leaving");
  const leavingWelcome = await leaving.next((message) => message.type === "welcome");
  await observer.next((message) => message.type === "peer-joined");

  leaving.socket.send(JSON.stringify({ type: "leave" }));

  const left = await observer.next((message) => message.type === "peer-left");
  assert.equal(left.peerId, leavingWelcome.peerId);
  const health = await fetch(`${app.httpUrl}/healthz`).then((response) => response.json());
  assert.equal(health.participants, 1);
  observer.socket.close();
});

test("control plane publishes epoch-bound relay trees only after enough explicit consent", async (context) => {
  const app = await startTestServer({ mediaE2eeMode: "disabled" });
  context.after(() => app.close());
  const peers = [];
  const peerIds = [];
  for (let index = 0; index < 6; index += 1) {
    const peer = await connectAuthorized(app, "room-relay", `Peer ${index + 1}`);
    peerIds.push((await peer.next((message) => message.type === "welcome")).peerId);
    peers.push(peer);
  }
  const mesh = await peers[0].next((message) => message.type === "topology-state"
    && message.routes.length === 6
    && message.routes.every((route) => route.mode === "adaptive_mesh"));
  peers[0].socket.send(JSON.stringify({ type: "relay-consent", enabled: true }));
  peers[1].socket.send(JSON.stringify({ type: "relay-consent", enabled: true }));
  const relayed = await peers[0].next((message) => message.type === "topology-state"
    && message.routes.length === 6
    && message.routes.every((route) => route.mode === "trusted_peer_relay"));
  assert.ok(relayed.topologyEpoch > mesh.topologyEpoch);
  assert.ok(relayed.routeEpoch > mesh.routeEpoch);
  assert.equal(relayed.membershipEpoch, mesh.membershipEpoch);
  for (const route of relayed.routes) {
    assert.equal(route.edges.length, 5);
    assert.ok(route.edges.every((edge) => edge.depth >= 1 && edge.depth <= 3));
    assert.equal(new Set(route.edges.map((edge) => edge.childPeerId)).size, 5);
  }
  const unhealthyRelayId = peerIds[0];
  const badObservation = {
    type: "relay-observation",
    relayPeerId: unhealthyRelayId,
    routeEpoch: relayed.routeEpoch,
    sampleCount: 8,
    deliveryRatio: 0.4,
    delayMs: 4_000,
    observedCapacity: 20,
  };
  for (const observer of peers.slice(2, 5)) observer.socket.send(JSON.stringify(badObservation));
  const failedOver = await peers[1].next((message) => message.type === "topology-state"
    && message.routeEpoch > relayed.routeEpoch);
  assert.ok(failedOver.routes
    .filter((route) => route.rootPeerId !== unhealthyRelayId)
    .every((route) => route.edges.every((edge) => edge.parentPeerId !== unhealthyRelayId)));

  peers[5].socket.close();
  await peers[0].next((message) => message.type === "peer-left");
  const degraded = await peers[0].next((message) => message.type === "topology-state"
    && message.routes.length === 5 && message.topologyEpoch > relayed.topologyEpoch);
  assert.ok(degraded.topologyEpoch > relayed.topologyEpoch);
  assert.ok(degraded.membershipEpoch > relayed.membershipEpoch);
  assert.ok(degraded.routes.some((route) => route.mode === "trusted_peer_relay"));
  assert.ok(degraded.routes.filter((route) => route.mode === "trusted_peer_relay")
    .every((route) => route.edges.filter((edge) => edge.parentPeerId === route.rootPeerId).length <= 3));
  for (const peer of peers.slice(0, 5)) peer.socket.close();
});

test("required SFrame never authorizes the decrypting browser relay", async (context) => {
  const app = await startTestServer({ mediaE2eeMode: "required" });
  context.after(() => app.close());
  const peers = [];
  for (let index = 0; index < 5; index += 1) {
    const peer = await connectAuthorized(app, "room-required-relay", `Peer ${index + 1}`);
    await peer.next((message) => message.type === "welcome");
    peers.push(peer);
  }
  const initial = await peers[0].next((message) => (
    message.type === "topology-state" && message.routes.length === 5
  ));
  peers[0].socket.send(JSON.stringify({ type: "relay-consent", enabled: true }));
  const firstConsent = await peers[0].next((message) => (
    message.type === "topology-state" && message.routeEpoch > initial.routeEpoch
  ));
  peers[1].socket.send(JSON.stringify({ type: "relay-consent", enabled: true }));
  const secondConsent = await peers[0].next((message) => (
    message.type === "topology-state" && message.routeEpoch > firstConsent.routeEpoch
  ));
  assert.ok(secondConsent.routes.every((route) => (
    route.mode === "adaptive_mesh" && route.edges.length === 0
  )));
  for (const peer of peers) peer.socket.close();
});

test("signaling admits 20 peers, rejects peer 21 and isolates another room", async (context) => {
  const app = await startTestServer();
  context.after(() => app.close());
  const peers = [];
  for (let index = 1; index <= 20; index += 1) {
    const peer = await connectAuthorized(app, "room-twenty", `Peer ${index}`);
    const welcome = await peer.next((message) => message.type === "welcome");
    assert.equal(welcome.maxParticipants, 20);
    assert.equal(welcome.peers.length, index - 1);
    peers.push(peer);
  }

  const overflow = await connectAuthorized(app, "room-twenty", "Peer 21");
  const overflowError = await overflow.next((message) => message.type === "error");
  assert.equal(overflowError.code, "room_full");

  const otherRoom = await connectAuthorized(app, "room-other", "Independent");
  const otherWelcome = await otherRoom.next((message) => message.type === "welcome");
  assert.deepEqual(otherWelcome.peers, []);
  assert.equal(app.registry.participantCount, 21);
  assert.equal(app.registry.roomCount, 2);

  for (const peer of peers) peer.socket.close();
  overflow.socket.close();
  otherRoom.socket.close();
});

test("signaling rejects cross-origin browsers and caps rooms", async (context) => {
  const app = await startTestServer({ maxRoomParticipants: 2 });
  context.after(() => app.close());
  const eve = await authorize(app, "room-alpha", "Eve");
  const invalid = new WebSocket(`${app.wsUrl}${eve.body.signalingPath}`, {
    origin: "https://evil.example",
  });
  const invalidStatus = await new Promise((resolve) => invalid.on("unexpected-response", (_request, response) => resolve(response.statusCode)));
  assert.equal(invalidStatus, 403);

  const first = await connectAuthorized(app, "room-alpha", "Ada");
  await first.next((message) => message.type === "welcome");
  const second = await connectAuthorized(app, "room-alpha", "Grace");
  await second.next((message) => message.type === "welcome");
  const third = await connectAuthorized(app, "room-alpha", "Linus");
  const error = await third.next((message) => message.type === "error");
  assert.equal(error.code, "room_full");
  first.socket.close();
  second.socket.close();
  third.socket.close();
});

test("session authorization requires a fresh device proof and tickets cannot be replayed", async (context) => {
  const app = await startTestServer();
  context.after(() => app.close());
  const missingProof = await fetch(`${app.httpUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: app.httpUrl },
    body: JSON.stringify({ roomId: "room-alpha", displayName: "Ada", mode: "room" }),
  });
  assert.equal(missingProof.status, 400);
  assert.deepEqual(await missingProof.json(), { error: "device_proof_required" });

  const unknownDevice = createDevice();
  const unknownField = await fetch(`${app.httpUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: app.httpUrl },
    body: JSON.stringify({
      roomId: "room-alpha",
      displayName: "Ada",
      mode: "room",
      deviceProof: signedDeviceProof(unknownDevice, {
        roomId: "room-alpha", displayName: "Ada", mode: "room",
      }),
      authority: "client-supplied",
    }),
  });
  assert.equal(unknownField.status, 400);
  assert.deepEqual(await unknownField.json(), { error: "unknown_request_field" });

  const authorization = await authorize(app, "room-alpha", "Ada");
  assert.equal(authorization.response.status, 201);
  const first = connect(`${app.wsUrl}${authorization.body.signalingPath}`, app.httpUrl);
  await first.next((message) => message.type === "welcome");
  const replay = new WebSocket(`${app.wsUrl}${authorization.body.signalingPath}`, { origin: app.httpUrl });
  const replayStatus = await new Promise((resolve) => replay.on("unexpected-response", (_request, response) => resolve(response.statusCode)));
  assert.equal(replayStatus, 401);
  first.socket.close();
});

test("pair sessions admit two distinct devices and reject duplicate device or room mode", async (context) => {
  const app = await startTestServer();
  context.after(() => app.close());
  const firstDevice = createDevice();
  const first = await connectAuthorized(app, "pair-alpha", "Ada", { mode: "pair", device: firstDevice });
  await first.next((message) => message.type === "welcome");
  const duplicate = await connectAuthorized(app, "pair-alpha", "Ada second tab", { mode: "pair", device: firstDevice });
  const duplicateError = await duplicate.next((message) => message.type === "error");
  assert.equal(duplicateError.code, "duplicate_pair_device");

  const second = await connectAuthorized(app, "pair-alpha", "Grace", { mode: "pair" });
  const secondWelcome = await second.next((message) => message.type === "welcome");
  assert.equal(secondWelcome.maxParticipants, 2);
  assert.equal(secondWelcome.mode, "pair");

  const wrongMode = await connectAuthorized(app, "pair-alpha", "Wrong mode", { mode: "room" });
  const modeError = await wrongMode.next((message) => message.type === "error");
  assert.equal(modeError.code, "room_mode_mismatch");
  first.socket.close();
  duplicate.socket.close();
  second.socket.close();
  wrongMode.socket.close();
});

test("required OIDC mode denies missing tokens and binds verified identity to a session", async (context) => {
  const oidcVerifier = {
    async verify(token) {
      if (token !== "valid-token") throw new AuthenticationError("invalid_access_token");
      return { issuer: "https://identity.test/realms/webrtc", subject: "user-123", displayName: "Ada" };
    },
  };
  const app = await startTestServer({
    authMode: "required",
    oidcIssuer: "https://identity.test/realms/webrtc",
    oidcJwksUrl: "https://identity.test/certs",
    oidcAudience: "webrtc-room-server",
    oidcClientId: "webrtc-browser",
  }, { oidcVerifier });
  context.after(() => app.close());
  const denied = await authorize(app, "room-auth", "Ada");
  assert.equal(denied.response.status, 401);
  assert.equal(denied.body.error, "authentication_required");
  const invalid = await authorize(app, "room-auth", "Ada", { authorization: "Bearer wrong-token" });
  assert.equal(invalid.response.status, 401);
  assert.equal(invalid.body.error, "invalid_access_token");
  const allowed = await authorize(app, "room-auth", "Ada", { authorization: "Bearer valid-token" });
  assert.equal(allowed.response.status, 201);
  assert.deepEqual(allowed.body.identity, { authenticated: true, displayName: "Ada" });
});

test("operator-bound media agent uses challenge auth, creator preference and epoch-bound signaling", async (context) => {
  const issuer = "https://identity.test/realms/webrtc";
  const principal = `${issuer}|owner`;
  const sharedSecret = "native-media-agent-secret-0123456789";
  const oidcVerifier = {
    async verify(token) {
      if (token !== "owner") throw new AuthenticationError("invalid_access_token");
      return { issuer, subject: "owner", displayName: "Owner" };
    },
  };
  const app = await startTestServer({
    authMode: "required",
    oidcIssuer: issuer,
    oidcJwksUrl: "https://identity.test/certs",
    oidcAudience: "webrtc-room-server",
    oidcClientId: "webrtc-browser",
    mediaAgents: [{ id: "owner-edge", ownerPrincipal: principal, sharedSecret }],
    mediaAgentLeaseMs: 30_000,
    mediaAgentRenewMs: 10_000,
  }, { oidcVerifier });
  context.after(() => app.close());

  const agent = connect(`${app.wsUrl}/media-agent`);
  const challenge = await agent.next((message) => message.type === "agent-challenge");
  assert.equal(challenge.version, 1);
  const timestamp = Date.now();
  agent.socket.send(JSON.stringify({
    type: "authenticate",
    agentId: "owner-edge",
    timestamp,
    proof: mediaAgentAuthProof(sharedSecret, "owner-edge", challenge.nonce, timestamp),
  }));
  assert.equal((await agent.next((message) => message.type === "agent-authenticated")).version, 1);
  agent.socket.send(JSON.stringify({
    type: "capability",
    visible: true,
    battery: "mains",
    network: "fast",
    capacity: 90,
    load: 5,
    maxRooms: 8,
    maxPeers: 20,
    maxTracks: 80,
  }));

  const create = await fetch(`${app.httpUrl}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: app.httpUrl, authorization: "Bearer owner" },
    body: JSON.stringify({ mode: "room", title: "Agent room", visibility: "private" }),
  });
  const room = await create.json();
  const browser = await connectAuthorized(app, room.roomId, "ignored", { authorization: "Bearer owner" });
  const welcome = await browser.next((message) => message.type === "welcome");
  assert.equal(welcome.roomCreator, true);
  assert.deepEqual(welcome.mediaAgents, [{ id: "owner-edge", online: true }]);
  const observerA = await connectAuthorized(app, room.roomId, "Observer A", { authorization: "Bearer owner" });
  await observerA.next((message) => message.type === "welcome");
  const observerB = await connectAuthorized(app, room.roomId, "Observer B", { authorization: "Bearer owner" });
  await observerB.next((message) => message.type === "welcome");

  browser.socket.send(JSON.stringify({
    type: "media-agent-consent",
    enabled: true,
    agentId: "owner-edge",
    automaticTakeover: false,
  }));
  const route = await browser.next((message) => message.type === "media-agent-state" && message.primary?.id === "owner-edge");
  assert.equal(route.version, 3);
  assert.equal(route.primary.creatorPreferred, true);
  assert.ok(route.leaseExpiresAt > Date.now());
  const sync = await agent.next((message) => message.type === "agent-sync"
    && message.leases.some((lease) => lease.roomId === room.roomId));
  assert.equal(sync.version, 1);
  assert.equal(sync.leases.find((lease) => lease.roomId === room.roomId).role, "primary");
  assert.equal(sync.leases.find((lease) => lease.roomId === room.roomId).version, 3);
  assert.equal(sync.leases.find((lease) => lease.roomId === room.roomId).peers[0].publish, true);

  browser.socket.send(JSON.stringify({
    type: "media-agent-signal",
    agentId: "owner-edge",
    roomId: room.roomId,
    routeEpoch: route.routeEpoch,
    description: { type: "offer", sdp: "v=0\r\n" },
  }));
  const peerSignal = await agent.next((message) => message.type === "peer-signal");
  assert.equal(peerSignal.version, 1);
  assert.equal(peerSignal.peerId, welcome.peerId);
  assert.equal(JSON.stringify(peerSignal).includes("owner-edge"), false);

  agent.socket.send(JSON.stringify({
    type: "media-agent-signal",
    peerId: welcome.peerId,
    roomId: room.roomId,
    routeEpoch: route.routeEpoch,
    description: { type: "answer", sdp: "v=0\r\n" },
  }));
  const answer = await browser.next((message) => message.type === "media-agent-signal");
  assert.equal(answer.version, 1);
  assert.equal(answer.agentId, "owner-edge");
  assert.equal(answer.routeEpoch, route.routeEpoch);

  agent.socket.send(JSON.stringify({
    type: "media-agent-signal",
    peerId: welcome.peerId,
    roomId: room.roomId,
    routeEpoch: route.routeEpoch,
    negotiationSequence: 3,
    description: { type: "offer", sdp: "v=0\r\n" },
  }));
  const grantedOffer = await browser.next((message) => (
    message.type === "media-agent-signal" && message.description?.type === "offer"
  ));
  assert.equal(grantedOffer.negotiationSequence, 3);
  assert.equal(grantedOffer.agentId, "owner-edge");

  agent.socket.send(JSON.stringify({
    type: "media-agent-signal",
    peerId: welcome.peerId,
    roomId: room.roomId,
    routeEpoch: route.routeEpoch,
    description: { type: "offer", sdp: "v=0\r\n" },
  }));
  assert.equal((await agent.next((message) => message.type === "agent-error")).code,
    "invalid_agent_negotiation_sequence");

  browser.socket.send(JSON.stringify({
    type: "media-agent-peer-state",
    agentId: "owner-edge",
    roomId: room.roomId,
    routeEpoch: route.routeEpoch,
    connected: true,
  }));
  agent.socket.send(JSON.stringify({
    type: "peer-state",
    roomId: room.roomId,
    peerId: welcome.peerId,
    routeEpoch: route.routeEpoch,
    connected: true,
  }));
  const ready = await browser.next((message) => message.type === "media-agent-state"
    && message.readiness.some((entry) => entry.readyPeerIds.includes(welcome.peerId)));
  assert.deepEqual(ready.readiness[0].readyPeerIds, [welcome.peerId]);

  browser.socket.send(JSON.stringify({
    type: "media-agent-signal",
    agentId: "owner-edge",
    roomId: room.roomId,
    routeEpoch: route.routeEpoch - 1,
    candidate: null,
  }));
  assert.equal((await browser.next((message) => message.type === "error")).code, "stale_agent_route");
  agent.socket.close();
  const availability = await browser.next((message) => message.type === "media-agent-availability");
  assert.equal(availability.version, 1);
  assert.deepEqual(availability.agents, [{ id: "owner-edge", online: false }]);
  const fallback = await browser.next((message) => message.type === "media-agent-state"
    && message.primary === null && message.routeEpoch > route.routeEpoch);
  assert.ok(fallback.routeEpoch > route.routeEpoch);
  browser.socket.close();
  observerA.socket.close();
  observerB.socket.close();
});

test("OIDC owner downloads, enrolls, authenticates and revokes a self-service media agent", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "media-agent-self-service-"));
  fs.writeFileSync(path.join(directory, "media-edge-agent-linux-amd64"), "verified agent artifact");
  const issuer = "https://identity.test/realms/ananta";
  const oidcVerifier = {
    async verify(token) {
      if (token === "owner-token") {
        return { issuer, subject: "owner", displayName: "Owner" };
      }
      if (token === "other-token") {
        return { issuer, subject: "other", displayName: "Other" };
      }
      throw new AuthenticationError("invalid_token");
    },
  };
  const publicOrigin = "https://webrtc.example";
  const app = await startTestServer({
    publicOrigin,
    authMode: "required",
    oidcIssuer: issuer,
    oidcAudience: "webrtc-room-server",
    oidcClientId: "webrtc-browser",
    mediaAgentSelfServiceEnabled: true,
    mediaAgentRegistrationDb: path.join(directory, "registrations.sqlite"),
    mediaAgentArtifactDir: directory,
  }, { oidcVerifier });
  context.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const runtime = await fetch(`${app.httpUrl}/config`).then((response) => response.json());
  assert.equal(runtime.mediaAgents.selfService, true);
  assert.deepEqual(runtime.mediaAgents.targets.map(({ id }) => id), ["linux-amd64"]);

  const unauthenticated = await fetch(`${app.httpUrl}/api/media-agents`);
  assert.equal(unauthenticated.status, 401);
  const unknownField = await fetch(`${app.httpUrl}/api/media-agents/enrollments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: publicOrigin,
      authorization: "Bearer owner-token",
    },
    body: JSON.stringify({ label: "Arbeitszimmer", target: "linux-amd64", authority: "room-owner" }),
  });
  assert.equal(unknownField.status, 400);
  assert.equal((await unknownField.json()).error, "unknown_request_field");
  const enrollmentResponse = await fetch(`${app.httpUrl}/api/media-agents/enrollments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: publicOrigin,
      authorization: "Bearer owner-token",
    },
    body: JSON.stringify({ label: "Arbeitszimmer", target: "linux-amd64" }),
  });
  assert.equal(enrollmentResponse.status, 201);
  const enrollment = await enrollmentResponse.json();
  assert.match(enrollment.agentId, /^edge-[a-f0-9]{16}$/);
  assert.match(enrollment.artifactSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(enrollment, "enrollmentToken"), false);
  assert.match(enrollment.installer, new RegExp(enrollment.agentId));
  assert.doesNotMatch(enrollment.installer, /owner-token/);

  const artifact = await fetch(`${app.httpUrl}/downloads/media-edge-agent/linux-amd64`);
  assert.equal(artifact.status, 200);
  assert.equal(artifact.headers.get("x-content-sha256"), enrollment.artifactSha256);
  assert.equal(await artifact.text(), "verified agent artifact");

  const tokenMatch = enrollment.installer.match(/enrollment_token='([A-Za-z0-9_-]{43})'/);
  assert.ok(tokenMatch);
  const enrollmentToken = tokenMatch[1];
  const keyPair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = { ...keyPair.publicKey.export({ format: "jwk" }), ext: true };
  const enrollingAgent = connect(`${app.wsUrl}/media-agent`);
  const enrollmentChallenge = await enrollingAgent.next((message) => message.type === "agent-challenge");
  const enrollmentTimestamp = Date.now();
  const enrollmentProof = crypto.sign(
    "sha256",
    Buffer.from(mediaAgentEnrollmentProofMessage(
      enrollment.agentId,
      enrollmentChallenge.nonce,
      enrollmentTimestamp,
      enrollmentToken,
      publicKey,
    )),
    { key: keyPair.privateKey, dsaEncoding: "ieee-p1363" },
  ).toString("base64url");
  enrollingAgent.socket.send(JSON.stringify({
    version: 1,
    type: "enroll",
    agentId: enrollment.agentId,
    enrollmentToken,
    timestamp: enrollmentTimestamp,
    publicKey,
    proof: enrollmentProof,
  }));
  const enrolled = await enrollingAgent.next((message) => message.type === "agent-enrolled");
  assert.equal(enrolled.agentId, enrollment.agentId);
  assert.match(enrolled.keyFingerprint, /^[A-Za-z0-9_-]{43}$/);

  const registeredAgent = connect(`${app.wsUrl}/media-agent`);
  const authChallenge = await registeredAgent.next((message) => message.type === "agent-challenge");
  const timestamp = Date.now();
  const proof = crypto.sign(
    "sha256",
    Buffer.from(mediaAgentSignatureMessage(enrollment.agentId, authChallenge.nonce, timestamp)),
    { key: keyPair.privateKey, dsaEncoding: "ieee-p1363" },
  ).toString("base64url");
  registeredAgent.socket.send(JSON.stringify({
    version: 2,
    type: "authenticate",
    agentId: enrollment.agentId,
    timestamp,
    proof,
  }));
  const authenticated = await registeredAgent.next((message) => message.type === "agent-authenticated");
  assert.equal(authenticated.agentId, enrollment.agentId);

  const ownerList = await fetch(`${app.httpUrl}/api/media-agents`, {
    headers: { authorization: "Bearer owner-token" },
  }).then((response) => response.json());
  assert.deepEqual(ownerList.agents.map(({ id, label, platform, online, revokedAt }) => ({
    id, label, platform, online, revokedAt,
  })), [{
    id: enrollment.agentId,
    label: "Arbeitszimmer",
    platform: "linux",
    online: true,
    revokedAt: 0,
  }]);

  const forbiddenRevocation = await fetch(`${app.httpUrl}/api/media-agents/${enrollment.agentId}`, {
    method: "DELETE",
    headers: { origin: publicOrigin, authorization: "Bearer other-token" },
  });
  assert.equal(forbiddenRevocation.status, 404);
  const closed = new Promise((resolve) => registeredAgent.socket.once("close", resolve));
  const revocation = await fetch(`${app.httpUrl}/api/media-agents/${enrollment.agentId}`, {
    method: "DELETE",
    headers: { origin: publicOrigin, authorization: "Bearer owner-token" },
  });
  assert.equal(revocation.status, 200);
  await closed;
  const revokedList = await fetch(`${app.httpUrl}/api/media-agents`, {
    headers: { authorization: "Bearer owner-token" },
  }).then((response) => response.json());
  assert.equal(revokedList.agents[0].revokedAt > 0, true);
  assert.equal(revokedList.agents[0].online, false);
});

test("one browser atomically authorizes two owned agents for federation and cross-shard readiness", async (context) => {
  const issuer = "https://identity.test/realms/webrtc";
  const identities = Object.fromEntries(["owner", "helper", "two", "three", "four", "five"].map((subject) => [
    subject,
    { issuer, subject, displayName: subject },
  ]));
  const oidcVerifier = {
    async verify(token) {
      const identity = identities[token];
      if (!identity) throw new AuthenticationError("invalid_access_token");
      return identity;
    },
  };
  const agentDefinitions = [
    {
      id: "owner-edge",
      ownerPrincipal: `${issuer}|owner`,
      sharedSecret: "owner-edge-federation-secret-0123456789",
    },
    {
      id: "helper-edge",
      ownerPrincipal: `${issuer}|owner`,
      sharedSecret: "helper-edge-federation-secret-01234567",
    },
  ];
  const app = await startTestServer({
    authMode: "required",
    oidcIssuer: issuer,
    oidcJwksUrl: "https://identity.test/certs",
    oidcAudience: "webrtc-room-server",
    oidcClientId: "webrtc-browser",
    mediaAgents: agentDefinitions,
    mediaAgentLeaseMs: 30_000,
    mediaAgentRenewMs: 10_000,
    mediaAgentShardMinParticipants: 6,
  }, { oidcVerifier });
  context.after(() => app.close());

  const agents = new Map();
  for (const definition of agentDefinitions) {
    const client = connect(`${app.wsUrl}/media-agent`);
    agents.set(definition.id, client);
    const challenge = await client.next((message) => message.type === "agent-challenge");
    const timestamp = Date.now();
    client.socket.send(JSON.stringify({
      type: "authenticate",
      agentId: definition.id,
      timestamp,
      proof: mediaAgentAuthProof(definition.sharedSecret, definition.id, challenge.nonce, timestamp),
    }));
    await client.next((message) => message.type === "agent-authenticated");
    client.socket.send(JSON.stringify({
      type: "capability",
      visible: true,
      battery: "mains",
      network: "fast",
      capacity: 90,
      load: 5,
      maxRooms: 8,
      maxPeers: 20,
      maxTracks: 80,
    }));
  }

  const create = await fetch(`${app.httpUrl}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: app.httpUrl, authorization: "Bearer owner" },
    body: JSON.stringify({ mode: "room", title: "Federated room", visibility: "private" }),
  });
  const room = await create.json();
  const browsers = [];
  for (const subject of Object.keys(identities)) {
    const client = await connectAuthorized(app, room.roomId, subject, { authorization: `Bearer ${subject}` });
    const welcome = await client.next((message) => message.type === "welcome");
    browsers.push({ subject, client, peerId: welcome.peerId });
  }
  const owner = browsers.find(({ subject }) => subject === "owner");
  owner.client.socket.send(JSON.stringify({
    version: 1,
    type: "media-agent-consent-set",
    agentIds: ["owner-edge", "helper-edge"],
    automaticTakeover: false,
  }));
  const route = await owner.client.next((message) => (
    message.type === "media-agent-state" && message.forwarderIds?.length === 2
      && message.federationLinks?.length === 1
  ), 5_000);
  assert.equal(route.version, 3);
  const link = route.federationLinks[0];
  const senderAgentId = link.leftAgentId;
  const recipientAgentId = link.rightAgentId;
  const senderAgent = agents.get(senderAgentId);
  const recipientAgent = agents.get(recipientAgentId);
  await Promise.all([...agents.values()].map((client) => client.next((message) => (
    message.type === "agent-sync" && message.leases.some((lease) => (
      lease.roomId === room.roomId && lease.routeEpoch === route.routeEpoch
        && lease.federationLinks.some(({ linkId }) => linkId === link.linkId)
    ))
  ), 5_000)));

  senderAgent.socket.send(JSON.stringify({
    version: 1,
    type: "federation-signal",
    recipientAgentId,
    roomId: room.roomId,
    routeEpoch: route.routeEpoch,
    linkId: link.linkId,
    candidate: null,
  }));
  const brokered = await recipientAgent.next((message) => message.type === "federation-peer-signal");
  assert.equal(brokered.fromAgentId, senderAgentId);
  assert.equal(brokered.recipientAgentId, undefined);
  assert.equal(brokered.linkId, link.linkId);
  senderAgent.socket.send(JSON.stringify({
    version: 1,
    type: "federation-signal",
    recipientAgentId,
    roomId: room.roomId,
    routeEpoch: route.routeEpoch - 1,
    linkId: link.linkId,
    candidate: null,
  }));
  assert.equal((await senderAgent.next((message) => message.type === "agent-error")).code, "stale_federation_link");

  for (const [agentId, remoteAgentId] of [
    [senderAgentId, recipientAgentId],
    [recipientAgentId, senderAgentId],
  ]) {
    agents.get(agentId).socket.send(JSON.stringify({
      version: 1,
      type: "federation-state",
      roomId: room.roomId,
      routeEpoch: route.routeEpoch,
      linkId: link.linkId,
      remoteAgentId,
      connected: true,
    }));
  }
  const federated = await owner.client.next((message) => (
    message.type === "media-agent-state"
      && message.routeEpoch === route.routeEpoch
      && message.federationLinks?.some((candidate) => (
        candidate.linkId === link.linkId && candidate.readyAgentIds.length === 2
      ))
  ), 5_000);
  assert.deepEqual(
    federated.federationLinks.find(({ linkId }) => linkId === link.linkId).readyAgentIds,
    [senderAgentId, recipientAgentId].sort(),
  );

  const publisherAssignment = route.publisherAssignments.find(({ agentId }) => agentId === "owner-edge");
  const subscriberAssignment = route.subscriberAssignments.find(({ agentId, peerId }) => (
    agentId === "helper-edge" && publisherAssignment.peerId !== peerId
  ));
  const publisher = browsers.find(({ peerId }) => peerId === publisherAssignment.peerId);
  const subscriber = browsers.find(({ peerId }) => peerId === subscriberAssignment.peerId);
  publisher.client.socket.send(JSON.stringify({
    type: "media-state",
    source: "camera",
    active: true,
    trackId: "camera-track",
  }));
  await subscriber.client.next((message) => (
    message.type === "media-state" && message.from === publisher.peerId
      && message.trackId === "camera-track"
  ));
  agents.get("owner-edge").socket.send(JSON.stringify({
    version: 2,
    type: "track-state",
    roomId: room.roomId,
    peerId: publisher.peerId,
    routeEpoch: route.routeEpoch,
    publicationId: "camera-track",
    layer: "high",
    rid: "f",
    active: true,
  }));
  await subscriber.client.next((message) => (
    message.type === "media-agent-track-state"
      && message.peerId === publisher.peerId
      && message.publicationId === "camera-track"
      && message.layer === "high"
  ));
  subscriber.client.socket.send(JSON.stringify({
    version: 1,
    type: "media-agent-subscription-intent",
    agentId: "helper-edge",
    roomId: room.roomId,
    routeEpoch: route.routeEpoch,
    publisherPeerId: publisher.peerId,
    publicationId: "camera-track",
    enabled: true,
    preferredLayer: "high",
    maximumLayer: "high",
  }));
  const pending = await publisher.client.next((message) => (
    message.type === "media-agent-subscription-state"
      && message.publicationId === "camera-track"
      && message.subscriberPeerId === subscriber.peerId
      && message.ready === false
  ));
  assert.equal(pending.selectedLayer, "high");
  assert.equal(pending.revision, 1);
  const helperSync = await agents.get("helper-edge").next((message) => (
    message.type === "agent-sync" && message.leases.some((lease) => (
      lease.roomId === room.roomId
        && lease.subscriptions.some(({ publicationId }) => publicationId === "camera-track")
        && lease.federationDemands.some(({ publicationId }) => publicationId === "camera-track")
    ))
  ), 5_000);
  const helperLease = helperSync.leases.find((lease) => lease.roomId === room.roomId);
  assert.equal(helperLease.subscriptions[0].subscriberPeerId, subscriber.peerId);
  assert.equal(helperLease.federationDemands[0].layer, "high");
  agents.get("helper-edge").socket.send(JSON.stringify({
    version: 2,
    type: "subscription-state",
    roomId: room.roomId,
    routeEpoch: route.routeEpoch,
    publisherPeerId: publisher.peerId,
    publicationId: "camera-track",
    subscriberPeerId: subscriber.peerId,
    selectedLayer: "high",
    revision: helperLease.subscriptions[0].revision,
    ready: true,
  }));
  const subscriberReady = await subscriber.client.next((message) => (
    message.type === "media-agent-subscription-state"
      && message.publicationId === "camera-track"
      && message.subscriberPeerId === subscriber.peerId
      && message.revision === helperLease.subscriptions[0].revision
      && message.ready === true
  ));
  subscriber.client.socket.send(JSON.stringify({
    version: 1,
    type: "media-agent-subscription-ack",
    agentId: "helper-edge",
    roomId: room.roomId,
    routeEpoch: route.routeEpoch,
    publisherPeerId: publisher.peerId,
    publicationId: "camera-track",
    revision: subscriberReady.revision,
    ready: true,
  }));
  const ready = await publisher.client.next((message) => (
    message.type === "media-agent-subscription-state"
      && message.publicationId === "camera-track" && message.ready === true
  ));
  assert.equal(ready.agentId, "helper-edge");
  assert.equal(ready.subscriberPeerId, subscriber.peerId);
  assert.equal(ready.revision, helperLease.subscriptions[0].revision);

  owner.client.socket.send(JSON.stringify({
    version: 1,
    type: "media-agent-consent-set",
    agentIds: [],
    automaticTakeover: false,
  }));
  const revoked = await owner.client.next((message) => (
    message.type === "media-agent-state" && message.forwarderIds?.length === 0
  ), 5_000);
  assert.equal(revoked.primary, null);

  for (const { client } of browsers) client.socket.close();
  for (const client of agents.values()) client.socket.close();
});

test("room directory separates public and owned rooms and enforces owner-only visibility changes", async (context) => {
  const identities = {
    owner: { issuer: "https://identity.test/realms/webrtc", subject: "owner", displayName: "Owner" },
    stranger: { issuer: "https://identity.test/realms/webrtc", subject: "stranger", displayName: "Stranger" },
  };
  const oidcVerifier = {
    async verify(token) {
      const identity = identities[token];
      if (!identity) throw new AuthenticationError("invalid_access_token");
      return identity;
    },
  };
  const app = await startTestServer({
    authMode: "required",
    oidcIssuer: "https://identity.test/realms/webrtc",
    oidcJwksUrl: "https://identity.test/certs",
    oidcAudience: "webrtc-room-server",
    oidcClientId: "webrtc-browser",
  }, { oidcVerifier });
  context.after(() => app.close());

  const create = async (title, visibility) => {
    const response = await fetch(`${app.httpUrl}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.httpUrl, authorization: "Bearer owner" },
      body: JSON.stringify({ mode: "room", title, visibility }),
    });
    assert.equal(response.status, 201);
    return response.json();
  };
  const publicRoom = await create("Offene Runde", "public");
  const privateRoom = await create("Nur per Einladung", "private");

  const participant = await connectAuthorized(app, publicRoom.roomId, "ignored", {
    authorization: "Bearer owner",
  });
  await participant.next((message) => message.type === "welcome");

  const anonymousList = await fetch(`${app.httpUrl}/api/rooms`).then((response) => response.json());
  assert.deepEqual(anonymousList.publicRooms.map((room) => room.roomId), [publicRoom.roomId]);
  assert.equal(anonymousList.publicRooms[0].participantCount, 1);
  assert.deepEqual(anonymousList.ownRooms, []);
  assert.equal(JSON.stringify(anonymousList).includes("issuer|owner"), false);

  const ownerList = await fetch(`${app.httpUrl}/api/rooms`, {
    headers: { authorization: "Bearer owner" },
  }).then((response) => response.json());
  assert.deepEqual(new Set(ownerList.ownRooms.map((room) => room.roomId)), new Set([
    publicRoom.roomId,
    privateRoom.roomId,
  ]));

  const strangerList = await fetch(`${app.httpUrl}/api/rooms`, {
    headers: { authorization: "Bearer stranger" },
  }).then((response) => response.json());
  assert.deepEqual(strangerList.ownRooms, []);
  const forbidden = await fetch(`${app.httpUrl}/api/rooms/${publicRoom.roomId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: app.httpUrl, authorization: "Bearer stranger" },
    body: JSON.stringify({ visibility: "private" }),
  });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: "room_owner_required" });

  const hidden = await fetch(`${app.httpUrl}/api/rooms/${publicRoom.roomId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: app.httpUrl, authorization: "Bearer owner" },
    body: JSON.stringify({ visibility: "private" }),
  });
  assert.equal(hidden.status, 200);
  assert.equal((await hidden.json()).room.visibility, "private");
  assert.deepEqual((await fetch(`${app.httpUrl}/api/rooms`).then((response) => response.json())).publicRooms, []);

  const shown = await fetch(`${app.httpUrl}/api/rooms/${publicRoom.roomId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: app.httpUrl, authorization: "Bearer owner" },
    body: JSON.stringify({ title: "Wieder sichtbar", visibility: "public" }),
  });
  assert.equal(shown.status, 200);
  const finalPublic = await fetch(`${app.httpUrl}/api/rooms`).then((response) => response.json());
  assert.deepEqual(finalPublic.publicRooms.map(({ title, visibility }) => ({ title, visibility })), [
    { title: "Wieder sichtbar", visibility: "public" },
  ]);

  const unauthenticatedUpdate = await fetch(`${app.httpUrl}/api/rooms/${publicRoom.roomId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: app.httpUrl },
    body: JSON.stringify({ visibility: "private" }),
  });
  assert.equal(unauthenticatedUpdate.status, 401);
  const invalidUpdate = await fetch(`${app.httpUrl}/api/rooms/${publicRoom.roomId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: app.httpUrl, authorization: "Bearer owner" },
    body: JSON.stringify({ visibility: "listed" }),
  });
  assert.equal(invalidUpdate.status, 400);
  assert.deepEqual(await invalidUpdate.json(), { error: "invalid_room_visibility" });

  const unknownCreateField = await fetch(`${app.httpUrl}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: app.httpUrl, authorization: "Bearer owner" },
    body: JSON.stringify({ mode: "room", title: "Unknown", visibility: "private", owner: "client" }),
  });
  assert.equal(unknownCreateField.status, 400);
  assert.deepEqual(await unknownCreateField.json(), { error: "unknown_request_field" });
  const publicPair = await fetch(`${app.httpUrl}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: app.httpUrl, authorization: "Bearer owner" },
    body: JSON.stringify({ mode: "pair", visibility: "public" }),
  });
  assert.equal(publicPair.status, 400);
  assert.deepEqual(await publicPair.json(), { error: "room_visibility_requires_room" });
  const invalidTokenList = await fetch(`${app.httpUrl}/api/rooms`, {
    headers: { authorization: "Bearer invalid" },
  });
  assert.equal(invalidTokenList.status, 401);
  assert.deepEqual(await invalidTokenList.json(), { error: "invalid_access_token" });
  participant.socket.close();
});

test("persistent Pair Workspace binds two OIDC members and exposes an idempotent timeline", async (context) => {
  const identities = {
    owner: { issuer: "https://identity.test/realms/webrtc", subject: "owner", displayName: "Owner" },
    editor: { issuer: "https://identity.test/realms/webrtc", subject: "editor", displayName: "Editor" },
  };
  const oidcVerifier = {
    async verify(token) {
      const identity = identities[token];
      if (!identity) throw new AuthenticationError("invalid_access_token");
      return identity;
    },
  };
  const app = await startTestServer({
    authMode: "required",
    oidcIssuer: "https://identity.test/realms/webrtc",
    oidcJwksUrl: "https://identity.test/certs",
    oidcAudience: "webrtc-room-server",
    oidcClientId: "webrtc-browser",
    pairWorkspaceEnabled: true,
    pairWorkspaceDb: ":memory:",
  }, { oidcVerifier });
  context.after(() => app.close());
  const createdResponse = await fetch(`${app.httpUrl}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: app.httpUrl, authorization: "Bearer owner" },
    body: JSON.stringify({ mode: "pair", persistent: true, title: "Pair Dev" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.persistent, true);
  const invite = new URL(created.inviteUrl).searchParams.get("workspaceInvite");
  assert.ok(invite);
  const owner = await authorize(app, created.roomId, "ignored", {
    mode: "pair", authorization: "Bearer owner",
  });
  assert.equal(owner.response.status, 201);
  assert.deepEqual(owner.body.workspace, { workspaceId: created.workspaceId, role: "owner" });
  const editor = await authorize(app, created.roomId, "ignored", {
    mode: "pair", authorization: "Bearer editor", workspaceInvite: invite,
  });
  assert.equal(editor.response.status, 201);
  assert.equal(editor.body.workspace.role, "editor");

  const eventInput = { eventId: "decision-001", kind: "decision", payload: { text: "Ship it" } };
  const eventResponse = await fetch(`${app.httpUrl}/api/workspaces/${created.workspaceId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: app.httpUrl, authorization: "Bearer editor" },
    body: JSON.stringify(eventInput),
  });
  assert.equal(eventResponse.status, 201);
  const event = await eventResponse.json();
  const repeated = await fetch(`${app.httpUrl}/api/workspaces/${created.workspaceId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: app.httpUrl, authorization: "Bearer editor" },
    body: JSON.stringify(eventInput),
  }).then((response) => response.json());
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.sequence, event.sequence);
  const timeline = await fetch(`${app.httpUrl}/api/workspaces/${created.workspaceId}/events`, {
    headers: { origin: app.httpUrl, authorization: "Bearer owner" },
  }).then((response) => response.json());
  assert.equal(timeline.events.length, 1);
  assert.deepEqual(timeline.events[0].payload, { text: "Ship it" });
});

test("authorized sessions receive ephemeral TURN credentials", async (context) => {
  const app = await startTestServer({
    turnUrls: ["turn:turn.test:3478?transport=udp"],
    turnSharedSecret: "integration-secret",
    turnCredentialTtlMs: 600_000,
  });
  context.after(() => app.close());
  const authorization = await authorize(app, "room-turn", "Ada");
  assert.equal(authorization.response.status, 201);
  assert.equal(authorization.body.iceServers.length, 2);
  assert.deepEqual(authorization.body.icePolicy.directIceServers, [{ urls: "stun:stun.test:3478" }]);
  assert.deepEqual(authorization.body.icePolicy.peerRelayIceServers, []);
  assert.equal(authorization.body.icePolicy.infrastructureRelayIceServers.length, 1);
  assert.equal(authorization.body.icePolicy.peerRelayAfterMs, 4_000);
  assert.equal(authorization.body.icePolicy.infrastructureRelayAfterMs, 9_000);
  assert.match(authorization.body.iceServers[1].username, /^\d+:[a-f0-9]{20}$/);
  assert.equal(authorization.body.iceServers[1].credentialType, "password");
});

test("authorized sessions keep Edge-TURN credentials in the second ICE tier", async (context) => {
  const app = await startTestServer({
    edgeTurnServers: [{
      id: "edge-one",
      urls: ["turn:edge.test:3478?transport=udp"],
      sharedSecret: "0123456789abcdef0123456789abcdef",
      realm: "edge.test",
    }],
    turnCredentialTtlMs: 600_000,
  });
  context.after(() => app.close());
  const authorization = await authorize(app, "room-edge", "Ada");
  assert.equal(authorization.response.status, 201);
  assert.equal(authorization.body.icePolicy.peerRelayIceServers.length, 1);
  assert.match(authorization.body.icePolicy.peerRelayIceServers[0].username, /^\d+:[a-f0-9]{20}$/);
  assert.deepEqual(authorization.body.icePolicy.infrastructureRelayIceServers, []);
  assert.equal(JSON.stringify(authorization.body).includes("0123456789abcdef0123456789abcdef"), false);
});
