import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { WebSocket } from "ws";

import { createAppServer } from "../src/server.js";
import { deviceProofMessage } from "../src/device-proof.js";
import { AuthenticationError } from "../src/oidc-verifier.js";

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
    },
    optimization: {
      activeSpeakerLimit: 5,
      peerRelayEnabled: true,
      peerRelayMinParticipants: 6,
      peerRelayMaxChildren: 3,
      peerRelayMaxHops: 3,
      routeLeaseMs: 60_000,
      dataOverlayEnabled: true,
    },
    pairWorkspaceEnabled: false,
  });
  assert.match(configResponse.headers.get("content-security-policy"), /default-src 'self'/);

  const roomResponse = await fetch(`${app.httpUrl}/api/rooms`, { method: "POST" });
  assert.equal(roomResponse.status, 201);
  const room = await roomResponse.json();
  assert.match(room.roomId, /^room-[a-f0-9]{18}$/);
  assert.equal(room.mode, "room");
  assert.equal(room.inviteUrl, `${app.httpUrl}/?room=${room.roomId}&mode=room`);

  const indexResponse = await fetch(app.httpUrl);
  assert.equal(indexResponse.status, 200);
  assert.match(await indexResponse.text(), /<app-root>/);
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

test("control plane publishes epoch-bound relay trees only after enough explicit consent", async (context) => {
  const app = await startTestServer();
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
  assert.ok(degraded.routes.every((route) => route.mode === "adaptive_mesh"));
  for (const peer of peers.slice(0, 5)) peer.socket.close();
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
