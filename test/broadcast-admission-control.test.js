import assert from "node:assert/strict";
import test from "node:test";

import {
  BoundedBroadcastQueue,
  BroadcastAbuseGuard,
  BroadcastAdmissionController,
  BroadcastAdmissionError,
  assertBroadcastPayloadBudget,
} from "../src/broadcast-admission-control.js";

const KEY = Buffer.alloc(32, 0x42);
const IDS = Object.freeze({
  tenantId: "tn_aaaaaaaaaaaaaaaa",
  principalRef: "sub_bbbbbbbbbbbbbbbb",
  programId: "prg_cccccccccccccccc",
  gatewayRef: "gtw_dddddddddddddddd",
});

function request(overrides = {}) {
  return {
    operationId: "op_eeeeeeeeeeeeeeee",
    ...IDS,
    requestBytes: 2_048,
    messageBytes: 1_024,
    sourceCount: 2,
    renditionCount: 3,
    encoderCount: 3,
    queueItems: 32,
    queueBytes: 4 * 1024 * 1024,
    storageBytes: 64 * 1024 * 1024,
    segmentWindowSeconds: 14,
    viewerSessions: 20,
    egressBitsPerSecond: 100_000_000,
    runtimeMs: 60_000,
    now: 1_000_000,
    ...overrides,
  };
}

test("admission checks every bounded resource before creating an idempotent lease", () => {
  const controller = new BroadcastAdmissionController({ key: KEY });
  const lease = controller.admit(request());
  assert.match(lease.admissionId, /^badm_/);
  assert.equal(controller.snapshot().activePrograms, 1);
  assert.equal(controller.admit(request()), lease);
  assert.equal(controller.snapshot().activePrograms, 1);
  assert.throws(() => controller.admit(request({ operationId: "op_ffffffffffffffff", sourceCount: 5 })), (error) => (
    error instanceof BroadcastAdmissionError
    && error.publicCode === "broadcast_temporarily_unavailable"
    && /^BCAST-[A-F0-9]{12}$/.test(error.diagnosticRef)
  ));
  assert.equal(controller.snapshot().activePrograms, 1);
  controller.destroy();
});

test("principal, tenant, gateway, deployment and start-flapping quotas precede allocation", () => {
  const controller = new BroadcastAdmissionController({
    key: KEY,
    limits: {
      maxActiveProgramsDeployment: 3,
      maxActiveProgramsTenant: 2,
      maxActiveProgramsPrincipal: 1,
      maxActiveProgramsGateway: 2,
      maxStartsPerWindow: 2,
    },
  });
  controller.admit(request());
  assert.throws(() => controller.admit(request({
    operationId: "op_1111111111111111",
    programId: "prg_1111111111111111",
  })), (error) => error.code === "broadcast_admission_active_principal" && error.status === 429);
  assert.equal(controller.snapshot().activePrograms, 1);
  assert.throws(() => controller.admit(request({
    operationId: "op_2222222222222222",
    programId: "prg_2222222222222222",
  })), (error) => error.code === "broadcast_admission_start_flapping");
  assert.equal(controller.snapshot().activePrograms, 1);
});

test("operation replay cannot mutate an existing admission", () => {
  const controller = new BroadcastAdmissionController({ key: KEY });
  controller.admit(request());
  assert.throws(() => controller.admit(request({ viewerSessions: 21 })), (error) => (
    error.code === "broadcast_admission_operation_replay" && error.status === 409
  ));
});

test("bounded queues drop stale realtime work but degrade and stop control or delivery", () => {
  const queue = new BoundedBroadcastQueue({ maximumItems: 2, maximumBytes: 2_000, maximumAgeMs: 1_000, stopAfterOverflows: 2 });
  assert.equal(queue.enqueue({ itemRef: "frm_aaaaaaaaaaaa", kind: "realtime-media", bytes: 900, createdAt: 1_000 }, 1_000).action, "enqueue");
  assert.equal(queue.enqueue({ itemRef: "frm_bbbbbbbbbbbb", kind: "caption", bytes: 900, createdAt: 1_000 }, 1_000).action, "enqueue");
  assert.deepEqual(queue.enqueue({ itemRef: "frm_cccccccccccc", kind: "realtime-media", bytes: 900, createdAt: 1_000 }, 1_000), {
    accepted: true, action: "drop-oldest", dropped: 1,
  });
  assert.equal(queue.enqueue({ itemRef: "seg_dddddddddddd", kind: "delivery", bytes: 900, createdAt: 1_000 }, 1_000).action, "degrade");
  assert.equal(queue.enqueue({ itemRef: "seg_eeeeeeeeeeee", kind: "delivery", bytes: 900, createdAt: 1_000 }, 1_000).action, "stop");
  queue.prune(2_001);
  assert.deepEqual(queue.snapshot(), { items: 0, bytes: 0, consecutiveOverflows: 2 });
});

test("abuse buckets cover probes, credentials, catalog, flapping and view bots without raw actor storage", () => {
  const guard = new BroadcastAbuseGuard({ key: KEY, maximumBuckets: 16 });
  for (let count = 0; count < 10; count += 1) {
    assert.equal(guard.allow({ action: "credential-attempt", actorRef: "198.51.100.14", now: 1_000 }), true);
  }
  assert.equal(guard.allow({ action: "credential-attempt", actorRef: "198.51.100.14", now: 1_000 }), false);
  assert.equal(guard.allow({ action: "unknown", actorRef: "198.51.100.14", now: 1_000 }), false);
  assert.equal(guard.size, 1);
  guard.prune(301_001);
  assert.equal(guard.size, 0);
  guard.destroy();
});

test("compressed payload and catalog limits reject JSON or archive bombs", () => {
  assert.deepEqual(assertBroadcastPayloadBudget({ wireBytes: 1_000, expandedBytes: 10_000, catalogEntries: 20 }), {
    wireBytes: 1_000, expandedBytes: 10_000, catalogEntries: 20,
  });
  assert.throws(() => assertBroadcastPayloadBudget({ wireBytes: 1_000, expandedBytes: 21_000, catalogEntries: 20 }), /broadcast_payload_rejected/);
  assert.throws(() => assertBroadcastPayloadBudget({ wireBytes: 1_000, expandedBytes: 10_000, catalogEntries: 257 }), /broadcast_payload_rejected/);
});
