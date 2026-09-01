import assert from "node:assert/strict";
import test from "node:test";

import {
  mediaAgentAuthProof,
  parseBrowserMediaAgentMessage,
  parseMediaAgentMessage,
} from "../src/media-agent-protocol.js";

test("browser media-agent contracts are closed and epoch-bound", () => {
  assert.deepEqual(parseBrowserMediaAgentMessage(Buffer.from(JSON.stringify({
    type: "media-agent-consent",
    enabled: true,
    agentId: "laptop-edge",
    automaticTakeover: false,
  }))), {
    type: "media-agent-consent",
    enabled: true,
    agentId: "laptop-edge",
    automaticTakeover: false,
  });
  assert.throws(() => parseBrowserMediaAgentMessage(Buffer.from(JSON.stringify({
    type: "media-agent-consent",
    enabled: true,
    agentId: "laptop-edge",
    automaticTakeover: false,
    authority: "owner",
  }))), /unknown_media_agent_consent_field/);
  assert.throws(() => parseBrowserMediaAgentMessage(Buffer.from(JSON.stringify({
    type: "media-agent-signal",
    agentId: "laptop-edge",
    roomId: "room-123456",
    routeEpoch: 0,
    candidate: null,
  }))), /invalid_agent_route_epoch/);
  assert.deepEqual(parseBrowserMediaAgentMessage(Buffer.from(JSON.stringify({
    type: "media-agent-subscription-state",
    agentId: "laptop-edge",
    roomId: "room-123456",
    routeEpoch: 2,
    publisherPeerId: "0123456789abcdef",
    publicationId: "camera-track",
    ready: true,
  }))).ready, true);
});

test("native agent contracts validate auth, capability, track and exact fields", () => {
  const proof = mediaAgentAuthProof("x".repeat(32), "laptop-edge", "nonce", 1_000);
  assert.equal(proof.length, 43);
  assert.deepEqual(parseMediaAgentMessage(Buffer.from(JSON.stringify({
    type: "authenticate", agentId: "laptop-edge", timestamp: 1_000, proof,
  }))), { type: "authenticate", agentId: "laptop-edge", timestamp: 1_000, proof });
  assert.equal(parseMediaAgentMessage(Buffer.from(JSON.stringify({
    type: "capability", visible: true, battery: "mains", network: "fast",
    capacity: 80, load: 5, maxRooms: 8, maxPeers: 20, maxTracks: 80,
  }))).maxRooms, 8);
  assert.throws(() => parseMediaAgentMessage(Buffer.from(JSON.stringify({
    type: "capability", visible: true, battery: "mains", network: "fast",
    capacity: 80, load: 5, maxRooms: 0, maxPeers: 20, maxTracks: 80,
  }))), /invalid_agent_max_rooms/);
  assert.deepEqual(parseMediaAgentMessage(Buffer.from(JSON.stringify({
    type: "track-state",
    roomId: "room-123456",
    peerId: "0123456789abcdef",
    routeEpoch: 7,
    publicationId: "camera-track",
    active: true,
  }))).publicationId, "camera-track");
  assert.throws(() => parseMediaAgentMessage(Buffer.from(JSON.stringify({
    type: "draining", enabled: true, reason: "secret",
  }))), /unknown_agent_draining_field/);
});
