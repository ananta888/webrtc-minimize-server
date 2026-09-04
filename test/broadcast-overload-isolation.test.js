import assert from "node:assert/strict";
import test from "node:test";

import { BroadcastAdmissionController } from "../src/broadcast-admission-control.js";
import { RoomRegistry } from "../src/room-registry.js";
import { createTurnCredentials } from "../src/turn-credentials.js";

test("broadcast overload remains isolated from room membership and TURN credentials", () => {
  const controller = new BroadcastAdmissionController({
    key: Buffer.alloc(32, 0x61),
    limits: { maxActiveProgramsDeployment: 1, maxStartsPerWindow: 10_000 },
  });
  const base = {
    tenantId: "tn_aaaaaaaaaaaaaaaa",
    principalRef: "sub_bbbbbbbbbbbbbbbb",
    gatewayRef: "gtw_cccccccccccccccc",
    requestBytes: 1_000,
    messageBytes: 500,
    sourceCount: 1,
    renditionCount: 1,
    encoderCount: 1,
    queueItems: 1,
    queueBytes: 1_024,
    storageBytes: 1_024,
    segmentWindowSeconds: 2,
    viewerSessions: 1,
    egressBitsPerSecond: 100_000,
    runtimeMs: 60_000,
    now: 1_000_000,
  };
  controller.admit({ ...base, operationId: "op_0000000000000000", programId: "prg_0000000000000000" });
  for (let index = 1; index <= 1_000; index += 1) {
    assert.throws(() => controller.admit({
      ...base,
      operationId: `op_${String(index).padStart(16, "0")}`,
      programId: `prg_${String(index).padStart(16, "0")}`,
    }), /active_deployment/);
  }

  const rooms = new RoomRegistry({ maxParticipants: 20 });
  for (let index = 0; index < 20; index += 1) {
    rooms.join("room-isolated", {}, `Peer ${index}`, 1_000_000, { principal: `principal-${index}` });
  }
  assert.equal(rooms.participantCount, 20);
  assert.throws(() => rooms.join("room-isolated", {}, "Peer 21", 1_000_000), /room_full/);

  const credentials = createTurnCredentials({
    turnUrls: ["turn:turn.example.test:3478?transport=udp"],
    turnSharedSecret: "synthetic-shared-secret",
    turnCredentialTtlMs: 300_000,
  }, "issuer|subject", 1_000_000);
  assert.equal(credentials.length, 1);
  assert.match(credentials[0].username, /^\d+:[a-f0-9]{20}$/);
  assert.equal(controller.snapshot().activePrograms, 1);
});
