import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BROADCAST_LEAKAGE_CANARIES,
  scanPathsForCanaries,
} from "../scripts/leakage-canary-scanner.mjs";
import { createAppServer, startServer } from "../src/server.js";

test("streaming leakage scanner finds split-boundary canaries and rejects symlinks", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "broadcast-leakage-"));
  const safe = path.join(directory, "safe.bin");
  const leaking = path.join(directory, "leaking.bin");
  const link = path.join(directory, "link.bin");
  writeFileSync(safe, Buffer.alloc(70_000, 120));
  writeFileSync(leaking, `${"x".repeat(65_530)}${BROADCAST_LEAKAGE_CANARIES[0]}`);
  symlinkSync(safe, link);
  assert.deepEqual(await scanPathsForCanaries([safe]), { files: 1, bytes: 70_000 });
  await assert.rejects(() => scanPathsForCanaries([leaking]), /broadcast_leakage_canary_found/);
  await assert.rejects(() => scanPathsForCanaries([link]), /leakage_scan_symlink_forbidden/);
});

test("public responses, headers and application shell never expose server-side canaries", async (context) => {
  const app = createAppServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      publicOrigin: "",
      stunUrls: [],
      turnServers: [],
      turnUrls: ["turn:turn.test:3478"],
      turnSharedSecret: BROADCAST_LEAKAGE_CANARIES[1],
      edgeTurnServers: [{
        id: "edge-one",
        urls: ["turn:edge.test:3478"],
        sharedSecret: BROADCAST_LEAKAGE_CANARIES[2],
        realm: "edge.test",
      }],
      mediaAgents: [],
      maxRoomParticipants: 20,
      roomIdleTtlMs: 60_000,
      signalRateLimit: 120,
      pairWorkspaceEnabled: false,
      mediaE2eeMode: "required",
    },
  });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  context.after(async () => new Promise((resolve) => app.server.close(resolve)));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const outputs = [];
  for (const pathname of ["/", "/config", "/healthz", "/readyz", `/${BROADCAST_LEAKAGE_CANARIES[3]}`]) {
    const response = await fetch(`${origin}${pathname}`);
    outputs.push(JSON.stringify(Object.fromEntries(response.headers)), await response.text());
  }
  const serialized = outputs.join("\n");
  for (const canary of BROADCAST_LEAKAGE_CANARIES) assert.equal(serialized.includes(canary), false);
});

test("normal startup logs never serialize configured secret canaries", async () => {
  const messages = [];
  const originalLog = console.log;
  console.log = (...values) => messages.push(values.join(" "));
  let app;
  try {
    app = await startServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        publicOrigin: "",
        stunUrls: [],
        turnServers: [],
        turnUrls: ["turn:turn.test:3478"],
        turnSharedSecret: BROADCAST_LEAKAGE_CANARIES[1],
        edgeTurnServers: [],
        mediaAgents: [],
        maxRoomParticipants: 20,
        roomIdleTtlMs: 60_000,
        signalRateLimit: 120,
        pairWorkspaceEnabled: false,
        mediaE2eeMode: "required",
      },
    });
  } finally {
    console.log = originalLog;
    if (app) await new Promise((resolve) => app.server.close(resolve));
  }
  const serialized = messages.join("\n");
  assert.match(serialized, /WebRTC room server listening/);
  for (const canary of BROADCAST_LEAKAGE_CANARIES) assert.equal(serialized.includes(canary), false);
});
