import assert from "node:assert/strict";
import test from "node:test";

import { admitNativePackager } from "../src/native-packager-policy.js";
import {
  estimatePackagerDemand,
  PackagerCapacityError,
  PackagerCapacityLedger,
} from "../src/packager-capacity-ledger.js";

const now = 1_800_000_000_000;
const capability = {
  capabilityVersion: 1, agentId: "capacity-agent", tenantId: "tn_aaaaaaaaaaaaaaaa",
  ownerSubjectRef: "sub_aaaaaaaaaaaaaaaa", deviceRef: "dev_aaaaaaaaaaaaaaaa",
  agentVersion: "1.0.0", ffmpegVersion: "6.1.1", videoEncoders: ["libx264"], audioEncoders: ["aac"],
  hardwareClass: "large", cpuClass: "high", gpuClass: "none", uploadClass: "over-15mbit",
  energyClass: "ac", health: "healthy", maximumRenditions: 3,
  maximumPixelsPerSecond: 1280 * 720 * 30, consentedRoomIds: ["room-capacity"],
  observedAt: now, expiresAt: now + 30_000,
};
const admission = admitNativePackager(capability, {
  requestVersion: 1, trigger: "user-action", tenantId: capability.tenantId,
  ownerSubjectRef: capability.ownerSubjectRef, roomId: "room-capacity",
  programId: "prg_aaaaaaaaaaaaaaaa", programEpoch: 4, resourceRef: "res_aaaaaaaaaaaaaaaa",
  requestedRenditions: 3, allowHardwareAcceleration: false,
}, now);

test("capacity ledger atomically reserves CPU, memory, encoders and egress", () => {
  const demand = estimatePackagerDemand(admission);
  const ledger = new PackagerCapacityLedger({ ...demand, gpuSlots: 0 });
  const request = { reservationId: "rsv_aaaaaaaaaaaaaaaa", now, expiresAt: now + 30_000 };
  const reserved = ledger.reserveBestEffort(admission, request);
  assert.equal(reserved.degraded, false);
  assert.deepEqual(ledger.snapshot(now).used, demand);
  assert.equal(ledger.reserveBestEffort(admission, request), reserved);
  assert.throws(() => ledger.reserveBestEffort(admission, {
    ...request, reservationId: "rsv_bbbbbbbbbbbbbbbb",
  }), (error) => error instanceof PackagerCapacityError && error.code === "packager_capacity_exhausted");
  assert.throws(() => ledger.release({
    reservationId: request.reservationId, programId: admission.programId, programEpoch: 5,
  }, now), /fence_mismatch/);
  assert.equal(ledger.release({
    reservationId: request.reservationId, programId: admission.programId, programEpoch: 4,
  }, now), true);
  assert.equal(ledger.snapshot(now).activeReservations, 0);
});

test("capacity ledger degrades the ladder before refusing and expires stale leases", () => {
  const lowDemand = estimatePackagerDemand({ ...admission, renditions: admission.renditions.slice(0, 1) });
  const ledger = new PackagerCapacityLedger({ ...lowDemand, gpuSlots: 0 });
  const request = { reservationId: "rsv_cccccccccccccccc", now, expiresAt: now + 20_000 };
  const reserved = ledger.reserveBestEffort(admission, request);
  assert.equal(reserved.degraded, true);
  assert.deepEqual(reserved.admission.renditions.map(({ id }) => id), ["low"]);
  assert.equal(ledger.snapshot(now + 20_001).activeReservations, 0);
  assert.deepEqual(ledger.snapshot(now + 20_001).used, {
    cpuUnits: 0, memoryMiB: 0, encoderSlots: 0, gpuSlots: 0, egressBitsPerSecond: 0,
  });
});

test("reservation IDs cannot be replayed with changed admission", () => {
  const demand = estimatePackagerDemand(admission);
  const ledger = new PackagerCapacityLedger({ ...demand, gpuSlots: 0 });
  const request = { reservationId: "rsv_dddddddddddddddd", now, expiresAt: now + 30_000 };
  ledger.reserveBestEffort(admission, request);
  assert.throws(() => ledger.reserveBestEffort({ ...admission, programEpoch: 5 }, request), /reservation_conflict/);
});
