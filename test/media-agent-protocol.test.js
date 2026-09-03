import assert from "node:assert/strict";
import test from "node:test";

import {
  mediaAgentAuthProof,
  parseBrowserMediaAgentMessage,
  parseMediaAgentMessage,
} from "../src/media-agent-protocol.js";

test("browser media-agent contracts are closed and epoch-bound", () => {
  assert.deepEqual(parseBrowserMediaAgentMessage(Buffer.from(JSON.stringify({
    type: "media-agent-signal",
    agentId: "laptop-edge",
    roomId: "room-123456",
    routeEpoch: 2,
    description: { type: "offer", sdp: "v=0\r\n" },
  }))).description.type, "offer");
  assert.throws(() => parseBrowserMediaAgentMessage(Buffer.from(JSON.stringify({
    type: "media-agent-signal",
    agentId: "laptop-edge",
    roomId: "room-123456",
    routeEpoch: 2,
    negotiationSequence: 1,
    description: { type: "offer", sdp: "v=0\r\n" },
  }))), /invalid_agent_negotiation_sequence/);
  assert.deepEqual(parseBrowserMediaAgentMessage(Buffer.from(JSON.stringify({
    version: 1,
    type: "media-agent-consent-set",
    agentIds: ["minipc-edge", "laptop-edge"],
    automaticTakeover: true,
  }))), {
    version: 1,
    type: "media-agent-consent-set",
    agentIds: ["laptop-edge", "minipc-edge"],
    automaticTakeover: true,
  });
  assert.deepEqual(parseBrowserMediaAgentMessage(Buffer.from(JSON.stringify({
    version: 1,
    type: "media-agent-consent-set",
    agentIds: [],
    automaticTakeover: false,
  }))).agentIds, []);
  for (const agentIds of [
    ["laptop-edge", "laptop-edge"],
    ["one", "two", "three", "four"],
    [7],
  ]) {
    assert.throws(() => parseBrowserMediaAgentMessage(Buffer.from(JSON.stringify({
      version: 1,
      type: "media-agent-consent-set",
      agentIds,
      automaticTakeover: false,
    }))), /invalid_media_agent_consent_set/);
  }
  assert.throws(() => parseBrowserMediaAgentMessage(Buffer.from(JSON.stringify({
    version: 1,
    type: "media-agent-consent-set",
    agentIds: ["laptop-edge"],
    automaticTakeover: false,
    roomId: "room-123456",
  }))), /unknown_media_agent_consent_set_field/);
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
    version: 1,
    type: "media-agent-subscription-intent",
    agentId: "laptop-edge",
    roomId: "room-123456",
    routeEpoch: 2,
    publisherPeerId: "0123456789abcdef",
    publicationId: "camera-track",
    enabled: true,
    preferredLayer: "medium",
    maximumLayer: "high",
  }))).preferredLayer, "medium");
  assert.equal(parseBrowserMediaAgentMessage(Buffer.from(JSON.stringify({
    version: 1,
    type: "media-agent-subscription-ack",
    agentId: "laptop-edge",
    roomId: "room-123456",
    routeEpoch: 2,
    publisherPeerId: "0123456789abcdef",
    publicationId: "camera-track",
    revision: 4,
    ready: true,
  }))).ready, true);
  assert.throws(() => parseBrowserMediaAgentMessage(Buffer.from(JSON.stringify({
    type: "media-agent-subscription-ack",
    agentId: "laptop-edge",
    roomId: "room-123456",
    routeEpoch: 2,
    publisherPeerId: "0123456789abcdef",
    publicationId: "camera-track",
    revision: 4,
    ready: true,
  }))), /unknown_agent_subscription_ack_field/);
});

test("native agent contracts validate auth, capability, track and exact fields", () => {
  const proof = mediaAgentAuthProof("x".repeat(32), "laptop-edge", "nonce", 1_000);
  assert.equal(proof.length, 43);
  assert.deepEqual(parseMediaAgentMessage(Buffer.from(JSON.stringify({
    type: "authenticate", agentId: "laptop-edge", timestamp: 1_000, proof,
  }))), { type: "authenticate", agentId: "laptop-edge", timestamp: 1_000, proof });
  assert.equal(parseMediaAgentMessage(Buffer.from(JSON.stringify({
    version: 2, type: "authenticate", agentId: "laptop-edge", timestamp: 1_000,
    proof: "A".repeat(86),
  }))).version, 2);
  assert.equal(parseMediaAgentMessage(Buffer.from(JSON.stringify({
    version: 1,
    type: "enroll",
    agentId: "edge-0123456789abcdef",
    enrollmentToken: "A".repeat(43),
    timestamp: 1_000,
    publicKey: { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "B".repeat(43), ext: true },
    proof: "C".repeat(86),
  }))).type, "enroll");
  assert.throws(() => parseMediaAgentMessage(Buffer.from(JSON.stringify({
    version: 1,
    type: "enroll",
    agentId: "edge-0123456789abcdef",
    enrollmentToken: "A".repeat(43),
    timestamp: 1_000,
    publicKey: { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "B".repeat(43), ext: true },
    proof: "C".repeat(86),
    authority: "room-owner",
  }))), /unknown_agent_enrollment_field/);
  assert.equal(parseMediaAgentMessage(Buffer.from(JSON.stringify({
    type: "capability", visible: true, battery: "mains", network: "fast",
    capacity: 80, load: 5, maxRooms: 8, maxPeers: 20, maxTracks: 80,
  }))).maxRooms, 8);
  assert.equal(parseMediaAgentMessage(Buffer.from(JSON.stringify({
    type: "media-agent-signal",
    peerId: "0123456789abcdef",
    roomId: "room-123456",
    routeEpoch: 7,
    negotiationSequence: 3,
    description: { type: "offer", sdp: "v=0\r\n" },
  }))).negotiationSequence, 3);
  assert.throws(() => parseMediaAgentMessage(Buffer.from(JSON.stringify({
    type: "media-agent-signal",
    peerId: "0123456789abcdef",
    roomId: "room-123456",
    routeEpoch: 7,
    description: { type: "offer", sdp: "v=0\r\n" },
  }))), /invalid_agent_negotiation_sequence/);
  assert.throws(() => parseMediaAgentMessage(Buffer.from(JSON.stringify({
    type: "capability", visible: true, battery: "mains", network: "fast",
    capacity: 80, load: 5, maxRooms: 0, maxPeers: 20, maxTracks: 80,
  }))), /invalid_agent_max_rooms/);
  assert.deepEqual(parseMediaAgentMessage(Buffer.from(JSON.stringify({
    version: 2,
    type: "track-state",
    roomId: "room-123456",
    peerId: "0123456789abcdef",
    routeEpoch: 7,
    publicationId: "camera-track",
    layer: "high",
    rid: "f",
    active: true,
  }))).publicationId, "camera-track");
  assert.equal(parseMediaAgentMessage(Buffer.from(JSON.stringify({
    version: 2, type: "subscription-state", roomId: "room-123456", routeEpoch: 7,
    publisherPeerId: "0123456789abcdef", publicationId: "camera-track",
    subscriberPeerId: "fedcba9876543210", selectedLayer: "low", revision: 3, ready: true,
  }))).selectedLayer, "low");
  assert.equal(parseMediaAgentMessage(Buffer.from(JSON.stringify({
    version: 1,
    type: "federation-signal",
    recipientAgentId: "remote-edge",
    roomId: "room-123456",
    routeEpoch: 7,
    linkId: "abcdefghijklmnopqrstuv",
    candidate: null,
  }))).recipientAgentId, "remote-edge");
  assert.equal(parseMediaAgentMessage(Buffer.from(JSON.stringify({
    version: 1,
    type: "federation-state",
    roomId: "room-123456",
    routeEpoch: 7,
    linkId: "abcdefghijklmnopqrstuv",
    remoteAgentId: "remote-edge",
    connected: true,
  }))).connected, true);
  assert.throws(() => parseMediaAgentMessage(Buffer.from(JSON.stringify({
    version: 1,
    type: "federation-signal",
    recipientAgentId: "remote-edge",
    roomId: "room-123456",
    routeEpoch: 7,
    linkId: "abcdefghijklmnopqrstuv",
    candidate: null,
    authority: true,
  }))), /unknown_federation_signal_field/);
  assert.throws(() => parseMediaAgentMessage(Buffer.from(JSON.stringify({
    type: "track-state",
    roomId: "room-123456",
    peerId: "0123456789abcdef",
    routeEpoch: 7,
    publicationId: "camera-track",
    layer: "high",
    rid: "f",
    active: true,
  }))), /unknown_agent_track_state_field/);
  assert.throws(() => parseMediaAgentMessage(Buffer.from(JSON.stringify({
    type: "draining", enabled: true, reason: "secret",
  }))), /unknown_agent_draining_field/);
});
