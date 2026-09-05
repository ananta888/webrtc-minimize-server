import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

test("native packager control schemas are closed and reject authority injection", async () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const load = async (name) => JSON.parse(await readFile(new URL(`../contracts/native-packager/${name}`, import.meta.url), "utf8"));
  const client = ajv.compile(await load("client-control.v1.schema.json"));
  const server = ajv.compile(await load("server-control.v1.schema.json"));
  const assignmentV2 = ajv.compile(await load("assignment-prepare.v2.schema.json"));
  const authentication = { version: 1, type: "authenticate", packagerId: "pkr_0123456789abcdef", timestamp: 1_800_000_000_000, proof: "A".repeat(86) };
  assert.equal(client(authentication), true, JSON.stringify(client.errors));
  assert.equal(client({ ...authentication, roomAuthority: true }), false);
  assert.equal(server({ version: 1, type: "room-consent-sync", roomIds: ["room-1234"] }), true, JSON.stringify(server.errors));
  assert.equal(server({ version: 1, type: "room-consent-sync", roomIds: ["room-1234"], decryptKey: "forbidden" }), false);
  const assignment = {
    version: 1, type: "assignment-prepare", assignmentId: "asn_0123456789abcdef",
    roomId: "room-1234", programId: "prg_0123456789abcdef", publisherPeerId: "0123456789abcdef", programEpoch: 2,
    leaseId: "lea_0123456789abcdef", fencingRevision: 3, resourceRef: "res_0123456789abcdef",
    profile: { profileId: "h264-aac-720p-v1", maximumQueueFrames: 60, keyframeIntervalSeconds: 2,
      renditions: [{ id: "low", width: 640, height: 360, framesPerSecond: 15,
        videoBitsPerSecond: 500_000, audioBitsPerSecond: 64_000 }] },
    expiresAt: 1_800_000_060_000,
  };
  assert.equal(server(assignment), true, JSON.stringify(server.errors));
  assert.equal(server({ ...assignment, decryptKey: "forbidden" }), false);
  const v2 = {
    ...assignment,
    version: 2,
    profile: { ...assignment.profile, videoEncoder: "h264_nvenc", softwareFallback: "libx264" },
  };
  assert.equal(assignmentV2(v2), true, JSON.stringify(assignmentV2.errors));
  assert.equal(assignmentV2({ ...v2, profile: { ...v2.profile, decryptKey: "forbidden" } }), false);
  assert.equal(assignmentV2({ ...v2, profile: { ...v2.profile, videoEncoder: "h264_vaapi" } }), false);
  assert.equal(client({
    version: 1, type: "assignment-status", assignmentId: assignment.assignmentId,
    programEpoch: 2, fencingRevision: 3, state: "ready", reasonCode: "CAPABILITY_READY",
    observedAt: 1_800_000_000_001,
  }), true, JSON.stringify(client.errors));
  const offer = { type: "offer", sdp: "v=0\r\n" };
  assert.equal(server({
    version: 1, type: "assignment-peer-signal", assignmentId: assignment.assignmentId,
    publisherPeerId: assignment.publisherPeerId, programEpoch: 2, fencingRevision: 3, description: offer,
  }), true, JSON.stringify(server.errors));
  assert.equal(client({
    version: 1, type: "assignment-signal", assignmentId: assignment.assignmentId,
    programEpoch: 2, fencingRevision: 3, description: { type: "answer", sdp: "v=0\r\n" },
  }), true, JSON.stringify(client.errors));
  assert.equal(client({
    version: 1, type: "assignment-signal", assignmentId: assignment.assignmentId,
    programEpoch: 2, fencingRevision: 3, description: offer, token: "forbidden",
  }), false);
});
