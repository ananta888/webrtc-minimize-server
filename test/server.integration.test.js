import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";

import { createAppServer } from "../src/server.js";

async function startTestServer(overrides = {}) {
  const config = {
    host: "127.0.0.1",
    port: 0,
    publicOrigin: "",
    stunUrls: ["stun:stun.test:3478"],
    turnServers: [],
    maxRoomParticipants: 20,
    roomIdleTtlMs: 60_000,
    signalRateLimit: 120,
    ...overrides,
  };
  const app = createAppServer({ config });
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

test("HTTP surface serves health, runtime config, rooms and app", async (context) => {
  const app = await startTestServer();
  context.after(() => app.close());

  const health = await fetch(`${app.httpUrl}/healthz`).then((response) => response.json());
  assert.deepEqual(health, { status: "ok", rooms: 0, participants: 0 });

  const configResponse = await fetch(`${app.httpUrl}/config`);
  assert.deepEqual(await configResponse.json(), {
    iceServers: [{ urls: "stun:stun.test:3478" }], maxRoomParticipants: 20,
  });
  assert.match(configResponse.headers.get("content-security-policy"), /default-src 'self'/);

  const roomResponse = await fetch(`${app.httpUrl}/api/rooms`, { method: "POST" });
  assert.equal(roomResponse.status, 201);
  const room = await roomResponse.json();
  assert.match(room.roomId, /^room-[a-f0-9]{18}$/);
  assert.equal(room.inviteUrl, `${app.httpUrl}/?room=${room.roomId}`);

  const indexResponse = await fetch(app.httpUrl);
  assert.equal(indexResponse.status, 200);
  assert.match(await indexResponse.text(), /WebRTC Räume/);
});

test("two room peers receive membership and target-bound signals", async (context) => {
  const app = await startTestServer();
  context.after(() => app.close());
  const origin = app.httpUrl;
  const ada = connect(`${app.wsUrl}/signal?room=room-alpha&name=Ada`, origin);
  const adaWelcome = await ada.next((message) => message.type === "welcome");
  const grace = connect(`${app.wsUrl}/signal?room=room-alpha&name=Grace`, origin);
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

  grace.socket.close();
  const left = await ada.next((message) => message.type === "peer-left");
  assert.equal(left.peerId, graceWelcome.peerId);
  ada.socket.close();
});

test("signaling admits 20 peers, rejects peer 21 and isolates another room", async (context) => {
  const app = await startTestServer();
  context.after(() => app.close());
  const peers = [];
  for (let index = 1; index <= 20; index += 1) {
    const peer = connect(
      `${app.wsUrl}/signal?room=room-twenty&name=Peer%20${index}`,
      app.httpUrl,
    );
    const welcome = await peer.next((message) => message.type === "welcome");
    assert.equal(welcome.maxParticipants, 20);
    assert.equal(welcome.peers.length, index - 1);
    peers.push(peer);
  }

  const overflow = connect(
    `${app.wsUrl}/signal?room=room-twenty&name=Peer%2021`,
    app.httpUrl,
  );
  const overflowError = await overflow.next((message) => message.type === "error");
  assert.equal(overflowError.code, "room_full");

  const otherRoom = connect(
    `${app.wsUrl}/signal?room=room-other&name=Independent`,
    app.httpUrl,
  );
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
  const invalid = new WebSocket(`${app.wsUrl}/signal?room=room-alpha&name=Eve`, {
    origin: "https://evil.example",
  });
  const invalidStatus = await new Promise((resolve) => invalid.on("unexpected-response", (_request, response) => resolve(response.statusCode)));
  assert.equal(invalidStatus, 403);

  const first = connect(`${app.wsUrl}/signal?room=room-alpha&name=Ada`, app.httpUrl);
  await first.next((message) => message.type === "welcome");
  const second = connect(`${app.wsUrl}/signal?room=room-alpha&name=Grace`, app.httpUrl);
  await second.next((message) => message.type === "welcome");
  const third = connect(`${app.wsUrl}/signal?room=room-alpha&name=Linus`, app.httpUrl);
  const error = await third.next((message) => message.type === "error");
  assert.equal(error.code, "room_full");
  first.socket.close();
  second.socket.close();
  third.socket.close();
});
