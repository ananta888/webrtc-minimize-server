import assert from "node:assert/strict";
import test from "node:test";

import { MediaAgentRegistry } from "../src/media-agent-registry.js";
import { mediaAgentAuthProof } from "../src/media-agent-protocol.js";

const issuer = "https://identity.test/realms/ananta";
const secret = "agent-secret-that-is-long-enough-123456";

function peer(id, principal, creator = false) {
  return { id, roomId: "room-123456", principal, creator };
}

function authenticate(registry, socket, now = 10_000) {
  const challenge = registry.issueChallenge(socket, now);
  return registry.authenticate(socket, {
    type: "authenticate",
    agentId: "creator-edge",
    timestamp: now,
    proof: mediaAgentAuthProof(secret, "creator-edge", challenge.nonce, now),
  }, now);
}

test("agent auth consumes one challenge, binds exact owner and never exposes the shared secret", () => {
  const registry = new MediaAgentRegistry({ definitions: [{
    id: "creator-edge", ownerPrincipal: `${issuer}|owner`, sharedSecret: secret,
  }] });
  const socket = {};
  const authenticated = authenticate(registry, socket);
  assert.equal(authenticated.id, "creator-edge");
  assert.equal(JSON.stringify(registry.connection(socket)).includes(secret), false);
  assert.throws(() => registry.authenticate(socket, {
    type: "authenticate", agentId: "creator-edge", timestamp: 10_000, proof: "x".repeat(43),
  }, 10_000), /agent_authentication_failed/);
  assert.throws(() => registry.setConsent(peer("0123456789abcdef", `${issuer}|other`), {
    enabled: true, agentId: "creator-edge", automaticTakeover: false,
  }), /media_agent_not_owned/);
});

test("creator agent becomes primary, readiness requires both endpoints and stale epochs fail closed", () => {
  const registry = new MediaAgentRegistry({
    definitions: [{ id: "creator-edge", ownerPrincipal: `${issuer}|owner`, sharedSecret: secret }],
    leaseMs: 30_000,
  });
  const socket = {};
  authenticate(registry, socket);
  registry.setCapability(socket, {
    visible: true, battery: "mains", network: "fast", capacity: 80, load: 5,
    maxRooms: 8, maxPeers: 20, maxTracks: 80,
  }, 10_000);
  const owner = peer("0123456789abcdef", `${issuer}|owner`, true);
  const guest = peer("fedcba9876543210", `${issuer}|guest`);
  registry.setConsent(owner, {
    enabled: true, agentId: "creator-edge", automaticTakeover: false,
  }, owner.principal, 10_000);
  const state = registry.reconcile(owner.roomId, [owner, guest], 1, 10_000);
  assert.equal(state.primary.id, "creator-edge");
  assert.equal(state.primary.creatorPreferred, true);
  registry.setBrowserPeerState(owner.roomId, "creator-edge", state.routeEpoch, owner.id, true, 10_001);
  assert.deepEqual(registry.snapshot(owner.roomId, [owner, guest]).readiness[0].readyPeerIds, []);
  registry.setAgentPeerState(socket, owner.roomId, owner.id, state.routeEpoch, true, 10_001);
  assert.deepEqual(registry.snapshot(owner.roomId, [owner, guest]).readiness[0].readyPeerIds, [owner.id]);
  assert.throws(() => registry.setBrowserPeerState(
    owner.roomId, "creator-edge", state.routeEpoch - 1, guest.id, true, 10_001,
  ), /stale_agent_route/);
  assert.throws(() => registry.heartbeat(socket, [], 11_000), /stale_agent_lease/);
  registry.heartbeat(socket, [{ roomId: owner.roomId, routeEpoch: state.routeEpoch }], 39_000);
  assert.equal(registry.reconcile(owner.roomId, [owner, guest], 1, 40_000).primary.id, "creator-edge");
});

test("reported room capacity prevents the control plane from over-leasing an agent", () => {
  const registry = new MediaAgentRegistry({ definitions: [{
    id: "creator-edge", ownerPrincipal: `${issuer}|owner`, sharedSecret: secret,
  }] });
  const socket = {};
  authenticate(registry, socket);
  registry.setCapability(socket, {
    visible: true, battery: "mains", network: "fast", capacity: 80, load: 5,
    maxRooms: 1, maxPeers: 20, maxTracks: 80,
  });
  const first = peer("0123456789abcdef", `${issuer}|owner`, true);
  const second = { ...peer("fedcba9876543210", `${issuer}|owner`, true), roomId: "room-654321" };
  registry.setConsent(first, {
    enabled: true, agentId: "creator-edge", automaticTakeover: false,
  }, first.principal, 10_000);
  registry.setConsent(second, {
    enabled: true, agentId: "creator-edge", automaticTakeover: false,
  }, second.principal, 10_000);
  assert.equal(registry.reconcile(first.roomId, [first], 1, 10_000).primary.id, "creator-edge");
  assert.equal(registry.reconcile(second.roomId, [second], 1, 10_001).primary, null);
});

test("primary disconnect creates a bounded takeover request instead of granting authority", () => {
  const secondSecret = "second-agent-secret-that-is-long-123456";
  const definitions = [
    { id: "creator-edge", ownerPrincipal: `${issuer}|owner`, sharedSecret: secret },
    { id: "guest-edge", ownerPrincipal: `${issuer}|guest`, sharedSecret: secondSecret },
  ];
  const registry = new MediaAgentRegistry({ definitions, leaseMs: 30_000, takeoverTtlMs: 20_000 });
  const firstSocket = {};
  authenticate(registry, firstSocket);
  const secondSocket = {};
  const secondChallenge = registry.issueChallenge(secondSocket, 10_000);
  registry.authenticate(secondSocket, {
    type: "authenticate",
    agentId: "guest-edge",
    timestamp: 10_000,
    proof: mediaAgentAuthProof(secondSecret, "guest-edge", secondChallenge.nonce, 10_000),
  }, 10_000);
  const owner = peer("0123456789abcdef", `${issuer}|owner`, true);
  const guest = peer("fedcba9876543210", `${issuer}|guest`);
  registry.setConsent(owner, { enabled: true, agentId: "creator-edge", automaticTakeover: false }, owner.principal, 10_000);
  registry.setConsent(guest, { enabled: true, agentId: "guest-edge", automaticTakeover: false }, owner.principal, 10_000);
  assert.equal(registry.reconcile(owner.roomId, [owner, guest], 1, 10_000).primary.id, "creator-edge");
  registry.disconnect(firstSocket);
  const awaiting = registry.reconcile(owner.roomId, [owner, guest], 1, 11_000);
  assert.equal(awaiting.primary, null);
  const request = registry.takeoverRequest(owner.roomId);
  assert.equal(request.agentId, "guest-edge");
  registry.respondToTakeover(guest, { requestId: request.requestId, accepted: true }, 12_000);
  const promoted = registry.reconcile(owner.roomId, [owner, guest], 1, 12_000);
  assert.equal(promoted.primary.id, "guest-edge");
  assert.ok(promoted.routeEpoch > awaiting.routeEpoch);
});

test("large rooms receive control-plane-owned publisher sharding across bounded agents", () => {
  const helperSecret = "helper-agent-secret-that-is-long-123456";
  const registry = new MediaAgentRegistry({
    definitions: [
      { id: "creator-edge", ownerPrincipal: `${issuer}|owner`, sharedSecret: secret },
      { id: "helper-edge", ownerPrincipal: `${issuer}|helper`, sharedSecret: helperSecret },
    ],
    shardMinParticipants: 6,
  });
  const creatorSocket = {};
  authenticate(registry, creatorSocket);
  const helperSocket = {};
  const challenge = registry.issueChallenge(helperSocket, 10_000);
  registry.authenticate(helperSocket, {
    type: "authenticate",
    agentId: "helper-edge",
    timestamp: 10_000,
    proof: mediaAgentAuthProof(helperSecret, "helper-edge", challenge.nonce, 10_000),
  }, 10_000);
  const members = [
    peer("0000000000000000", `${issuer}|owner`, true),
    peer("1111111111111111", `${issuer}|helper`),
    peer("2222222222222222", `${issuer}|two`),
    peer("3333333333333333", `${issuer}|three`),
    peer("4444444444444444", `${issuer}|four`),
    peer("5555555555555555", `${issuer}|five`),
  ];
  registry.setConsent(members[0], {
    enabled: true, agentId: "creator-edge", automaticTakeover: false,
  }, members[0].principal, 10_000);
  registry.setConsent(members[1], {
    enabled: true, agentId: "helper-edge", automaticTakeover: false,
  }, members[0].principal, 10_000);
  const small = registry.reconcile(members[0].roomId, members.slice(0, 2), 1, 10_000);
  assert.deepEqual(small.forwarderIds, ["creator-edge"]);
  assert.deepEqual(
    registry.roomLeases("helper-edge", () => members.slice(0, 2), () => [])[0].peers.map(({ publish }) => publish),
    [false, false],
  );
  const state = registry.reconcile(members[0].roomId, members, 2, 11_000);
  assert.equal(state.version, 2);
  assert.ok(state.routeEpoch > small.routeEpoch);
  assert.equal(state.primary.id, "creator-edge");
  assert.deepEqual(state.forwarderIds, ["creator-edge", "helper-edge"]);
  assert.equal(state.publisherAssignments.length, members.length);
  assert.deepEqual(state.publisherAssignments.find(({ peerId }) => peerId === members[0].id), {
    peerId: members[0].id,
    agentId: "creator-edge",
  });
  const helperPublishers = state.publisherAssignments
    .filter(({ agentId }) => agentId === "helper-edge").map(({ peerId }) => peerId);
  assert.ok(helperPublishers.length > 0);
  const [lease] = registry.roomLeases("helper-edge", () => members, () => []);
  assert.equal(lease.version, 2);
  assert.equal(lease.role, "standby");
  assert.deepEqual(lease.peers.filter(({ publish }) => publish).map(({ id }) => id), helperPublishers);
  assert.equal(registry.authorizePublisher(
    members[0].roomId, "helper-edge", state.routeEpoch, helperPublishers[0], 11_001,
  ), true);
  assert.equal(registry.authorizePublisher(
    members[0].roomId, "creator-edge", state.routeEpoch, helperPublishers[0], 11_001,
  ), false);
});

test("empty-room cleanup revokes every route and lease", () => {
  const registry = new MediaAgentRegistry({ definitions: [{
    id: "creator-edge", ownerPrincipal: `${issuer}|owner`, sharedSecret: secret,
  }] });
  const socket = {};
  authenticate(registry, socket);
  const owner = peer("0123456789abcdef", `${issuer}|owner`, true);
  registry.setConsent(owner, {
    enabled: true, agentId: "creator-edge", automaticTakeover: false,
  }, owner.principal, 10_000);
  const route = registry.reconcile(owner.roomId, [owner], 1, 10_000);
  assert.equal(registry.authorize(owner.roomId, "creator-edge", route.routeEpoch, owner.id, 10_001), true);
  assert.equal(registry.removeRoom(owner.roomId), true);
  assert.equal(registry.snapshot(owner.roomId), null);
  assert.deepEqual(registry.roomLeases("creator-edge", () => [], () => []), []);
  assert.equal(registry.authorize(owner.roomId, "creator-edge", route.routeEpoch, owner.id, 10_001), false);
});
