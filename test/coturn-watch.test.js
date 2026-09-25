import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SCRIPT = path.resolve("infra/deployment/ananta-coturn-watch.sh");
const MAGIC = 0x2112a442;
const SECRET = "watch-shared-secret";
const REALM = "turn.test";
const python = spawnSync("python3", ["--version"]).status === 0;

function attribute(type, value) {
  const padding = (4 - (value.length % 4)) % 4;
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(value.length, 2);
  return Buffer.concat([header, value, Buffer.alloc(padding)]);
}

function stunMessage(type, tid, attributes = []) {
  const body = Buffer.concat(attributes);
  const header = Buffer.alloc(8);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(body.length, 2);
  header.writeUInt32BE(MAGIC, 4);
  return Buffer.concat([header, tid, body]);
}

function errorCode(code) {
  return attribute(0x0009, Buffer.from([0, 0, Math.floor(code / 100), code % 100]));
}

function parse(data) {
  const attributes = new Map();
  let integrityOffset = -1;
  for (let offset = 20; offset + 4 <= data.length;) {
    const type = data.readUInt16BE(offset);
    const length = data.readUInt16BE(offset + 2);
    if (type === 0x0008) integrityOffset = offset;
    attributes.set(type, data.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length + ((4 - (length % 4)) % 4);
  }
  return { type: data.readUInt16BE(0), tid: data.subarray(8, 20), attributes, integrityOffset };
}

/** Minimal coturn stand-in: STUN binding plus long-term-credential Allocate/Refresh. */
async function fakeTurn(mode) {
  const socket = dgram.createSocket("udp4");
  const seen = { binding: 0, challenges: 0, authenticated: [], releases: 0 };
  socket.on("message", (data, remote) => {
    if (mode === "silent") return;
    const message = parse(data);
    const reply = (type, attributes) => socket.send(stunMessage(type, message.tid, attributes), remote.port, remote.address);
    if (message.type === 0x0001) {
      seen.binding += 1;
      reply(0x0101, []);
      return;
    }
    if (mode === "stun-only") return;
    const username = message.attributes.get(0x0006);
    if (!username) {
      seen.challenges += 1;
      reply(0x0113, [errorCode(401), attribute(0x0014, Buffer.from(REALM)), attribute(0x0015, Buffer.from("nonce-1"))]);
      return;
    }
    const password = crypto.createHmac("sha1", mode === "wrong-secret" ? "other" : SECRET).update(username).digest("base64");
    const key = crypto.createHash("md5").update(`${username}:${REALM}:${password}`).digest();
    const signed = Buffer.from(data.subarray(0, message.integrityOffset));
    signed.writeUInt16BE(message.integrityOffset + 24 - 20, 2);
    const integrity = crypto.createHmac("sha1", key).update(signed).digest();
    const expiry = Number(String(username).split(":")[0]);
    const valid = message.integrityOffset > 0 && integrity.equals(message.attributes.get(0x0008))
      && expiry * 1000 > Date.now();
    if (!valid) {
      reply(message.type | 0x0110, [errorCode(401), attribute(0x0014, Buffer.from(REALM)), attribute(0x0015, Buffer.from("nonce-1"))]);
      return;
    }
    if (message.type === 0x0003) {
      seen.authenticated.push(String(username));
      reply(0x0103, [attribute(0x0016, Buffer.from([0, 1, 0x12, 0x34, 1, 2, 3, 4]))]);
    } else if (message.type === 0x0004) {
      if (message.attributes.get(0x000d)?.readUInt32BE(0) === 0) seen.releases += 1;
      reply(0x0104, []);
    }
  });
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return { port: socket.address().port, seen, close: () => new Promise((resolve) => socket.close(resolve)) };
}

async function runWatch(context, { mode, secret = SECRET, lastRestart = 0 }) {
  const server = await fakeTurn(mode);
  context.after(() => server.close());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coturn-watch-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const docker = path.join(directory, "docker");
  fs.writeFileSync(docker, `#!/bin/sh\necho "$@" >> "${directory}/docker.calls"\n`, { mode: 0o755 });
  const secretFile = path.join(directory, "secret");
  if (secret) fs.writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, "state"), String(lastRestart));
  const child = spawn("bash", [SCRIPT], {
    env: {
      PATH: `${directory}:${process.env.PATH}`,
      ANANTA_COTURN_HOST: "127.0.0.1",
      ANANTA_COTURN_PORT: String(server.port),
      ANANTA_COTURN_CONTAINER: "coturn-under-test",
      ANANTA_COTURN_STATE: path.join(directory, "state"),
      ANANTA_COTURN_LOG: path.join(directory, "log"),
      ANANTA_COTURN_SECRET_FILE: secretFile,
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const status = await new Promise((resolve) => child.on("close", resolve));
  const read = (name) => (fs.existsSync(path.join(directory, name)) ? fs.readFileSync(path.join(directory, name), "utf8") : "");
  return { status, output, seen: server.seen, dockerCalls: read("docker.calls"), log: read("log") };
}

test("coturn watch performs and releases an authenticated TURN allocation with a fresh REST credential", { skip: !python && "python3 unavailable" }, async (context) => {
  const result = await runWatch(context, { mode: "ok" });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.seen.binding, 1);
  assert.equal(result.seen.challenges, 1);
  assert.equal(result.seen.authenticated.length, 1);
  assert.match(result.seen.authenticated[0], /^\d+:coturn-watch$/);
  assert.equal(result.seen.releases, 1, "the probe allocation is released again");
  assert.equal(result.dockerCalls, "");
  assert.equal(result.log, "");
  assert.equal(result.log.includes(SECRET) || result.output.includes(SECRET), false);
});

test("coturn watch restarts the relay when the authenticated allocation is refused", { skip: !python && "python3 unavailable" }, async (context) => {
  const result = await runWatch(context, { mode: "wrong-secret" });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.seen.binding, 1, "STUN alone still answers");
  assert.equal(result.dockerCalls.trim(), "restart coturn-under-test");
  assert.match(result.log, /coturn unhealthy \(allocate-rejected-401\) -> docker restart coturn-under-test/);
});

test("coturn watch restarts the relay when TURN allocations go unanswered", { skip: !python && "python3 unavailable" }, async (context) => {
  const result = await runWatch(context, { mode: "stun-only" });
  assert.equal(result.dockerCalls.trim(), "restart coturn-under-test");
  assert.match(result.log, /\(allocate-unanswered\)/);
});

test("coturn watch keeps the STUN probe, respects the cooldown and falls back without a secret", { skip: !python && "python3 unavailable" }, async (context) => {
  const silent = await runWatch(context, { mode: "silent" });
  assert.equal(silent.dockerCalls.trim(), "restart coturn-under-test");
  assert.match(silent.log, /\(stun-unanswered\)/);

  const cooling = await runWatch(context, { mode: "silent", lastRestart: Math.floor(Date.now() / 1000) });
  assert.equal(cooling.dockerCalls, "");
  assert.match(cooling.log, /\(stun-unanswered\), within cooldown/);

  const stunOnly = await runWatch(context, { mode: "ok", secret: "" });
  assert.equal(stunOnly.status, 0);
  assert.equal(stunOnly.seen.challenges, 0, "no allocate without a configured secret");
  assert.equal(stunOnly.dockerCalls, "");
});
