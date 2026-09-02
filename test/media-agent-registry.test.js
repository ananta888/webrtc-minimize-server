import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { MediaAgentEnrollmentStore } from "../src/media-agent-enrollment-store.js";
import { MediaAgentRegistry } from "../src/media-agent-registry.js";
import {
  mediaAgentAuthProof,
  mediaAgentEnrollmentProofMessage,
  mediaAgentSignatureMessage,
} from "../src/media-agent-protocol.js";

const issuer = "https://identity.test/realms/ananta";
const secret = "agent-secret-that-is-long-enough-123456";

function peer(id, principal, creator = false) {
  return { id, roomId: "room-123456", principal, creator };
}

function authenticateAgent(registry, socket, agentId, agentSecret, now = 10_000) {
  const challenge = registry.issueChallenge(socket, now);
  return registry.authenticate(socket, {
    type: "authenticate",
    agentId,
    timestamp: now,
    proof: mediaAgentAuthProof(agentSecret, agentId, challenge.nonce, now),
  }, now);
}

function authenticate(registry, socket, now = 10_000) {
  return authenticateAgent(registry, socket, "creator-edge", secret, now);
}

test("self-service enrollment proves possession and later authenticates without a shared secret", () => {
  const store = new MediaAgentEnrollmentStore();
  const enrollment = store.createEnrollment({
    principal: `${issuer}|owner`, label: "Arbeitszimmer", platform: "linux", now: 1_000,
  });
  const registry = new MediaAgentRegistry({ enrollmentStore: store });
  const keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = { ...keys.publicKey.export({ format: "jwk" }), ext: true };
  const enrollmentSocket = {};
  const challenge = registry.issueChallenge(enrollmentSocket, 1_001);
  const enrollmentProof = crypto.sign(
    "sha256",
    Buffer.from(mediaAgentEnrollmentProofMessage(
      enrollment.agentId, challenge.nonce, 1_002, enrollment.token, publicKey,
    )),
    { key: keys.privateKey, dsaEncoding: "ieee-p1363" },
  ).toString("base64url");
  const enrolled = registry.enroll(enrollmentSocket, {
    version: 1,
    type: "enroll",
    agentId: enrollment.agentId,
    enrollmentToken: enrollment.token,
    timestamp: 1_002,
    publicKey,
    proof: enrollmentProof,
  }, 1_002);
  assert.equal(enrolled.ownerPrincipal, `${issuer}|owner`);
  assert.throws(() => registry.enroll(enrollmentSocket, {
    version: 1, type: "enroll", agentId: enrollment.agentId, enrollmentToken: enrollment.token,
    timestamp: 1_002, publicKey, proof: enrollmentProof,
  }, 1_002), /agent_enrollment_failed/);

  const agentSocket = {};
  const authChallenge = registry.issueChallenge(agentSocket, 1_003);
  const proof = crypto.sign(
    "sha256",
    Buffer.from(mediaAgentSignatureMessage(enrollment.agentId, authChallenge.nonce, 1_004)),
    { key: keys.privateKey, dsaEncoding: "ieee-p1363" },
  ).toString("base64url");
  assert.equal(registry.authenticate(agentSocket, {
    version: 2, type: "authenticate", agentId: enrollment.agentId, timestamp: 1_004, proof,
  }, 1_004).id, enrollment.agentId);
  assert.equal(registry.configuredForPrincipal(enrolled.ownerPrincipal)[0].online, true);
  store.close();
});

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

test("one browser atomically consents multiple owned agents and leave removes the whole set", () => {
  const definitions = [
    { id: "laptop-edge", ownerPrincipal: `${issuer}|owner`, sharedSecret: "laptop-edge-secret-that-is-long-123456" },
    { id: "minipc-edge", ownerPrincipal: `${issuer}|owner`, sharedSecret: "minipc-edge-secret-that-is-long-123456" },
    { id: "foreign-edge", ownerPrincipal: `${issuer}|other`, sharedSecret: "foreign-edge-secret-that-is-long-123456" },
  ];
  const registry = new MediaAgentRegistry({ definitions, shardMinParticipants: 6 });
  for (const definition of definitions.slice(0, 2)) {
    const socket = {};
    authenticateAgent(registry, socket, definition.id, definition.sharedSecret);
    registry.setCapability(socket, {
      visible: true, battery: "mains", network: "fast", capacity: 90, load: 5,
      maxRooms: 8, maxPeers: 20, maxTracks: 80,
    });
  }
  const members = [
    peer("0000000000000000", `${issuer}|owner`, true),
    peer("1111111111111111", `${issuer}|one`),
    peer("2222222222222222", `${issuer}|two`),
    peer("3333333333333333", `${issuer}|three`),
    peer("4444444444444444", `${issuer}|four`),
    peer("5555555555555555", `${issuer}|five`),
  ];
  const owner = members[0];
  registry.setConsentSet(owner, {
    agentIds: ["minipc-edge", "laptop-edge"], automaticTakeover: false,
  }, owner.principal, 10_000);

  const small = registry.reconcile(owner.roomId, members.slice(0, 5), 1, 10_001);
  assert.equal(small.primary.id, "laptop-edge");
  assert.deepEqual(small.standbys.map(({ id }) => id), ["minipc-edge"]);
  assert.deepEqual(small.forwarderIds, ["laptop-edge"]);

  const sharded = registry.reconcile(owner.roomId, members, 2, 10_002);
  assert.deepEqual(sharded.forwarderIds, ["laptop-edge", "minipc-edge"]);
  assert.equal(sharded.federationLinks.length, 1);
  assert.throws(() => registry.setConsentSet(owner, {
    agentIds: ["laptop-edge", "foreign-edge"], automaticTakeover: false,
  }, owner.principal, 10_003), /media_agent_not_owned/);
  assert.deepEqual(
    registry.reconcile(owner.roomId, members, 3, 10_003).forwarderIds,
    ["laptop-edge", "minipc-edge"],
  );
  assert.throws(() => registry.setConsentSet(owner, {
    agentIds: ["laptop-edge", "minipc-edge", "foreign-edge", "fourth-edge"],
    automaticTakeover: false,
  }), /invalid_media_agent_consent_set/);

  registry.setConsent(owner, {
    enabled: true, agentId: "minipc-edge", automaticTakeover: true,
  }, owner.principal, 10_004);
  assert.deepEqual(registry.reconcile(owner.roomId, members, 4, 10_004).forwarderIds, ["minipc-edge"]);

  registry.setConsentSet(owner, {
    agentIds: ["laptop-edge", "minipc-edge"], automaticTakeover: false,
  }, owner.principal, 10_005);
  registry.leavePeer(owner);
  const direct = registry.reconcile(owner.roomId, members.slice(1), 5, 10_006);
  assert.equal(direct.primary, null);
  assert.deepEqual(direct.forwarderIds, []);
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
  const observer = peer("1111111111111111", `${issuer}|observer`);
  const members = [owner, guest, observer];
  registry.setConsent(owner, {
    enabled: true, agentId: "creator-edge", automaticTakeover: false,
  }, owner.principal, 10_000);
  const state = registry.reconcile(owner.roomId, members, 1, 10_000);
  assert.equal(state.primary.id, "creator-edge");
  assert.equal(state.primary.creatorPreferred, true);
  registry.setBrowserPeerState(owner.roomId, "creator-edge", state.routeEpoch, owner.id, true, 10_001);
  assert.deepEqual(registry.snapshot(owner.roomId, members).readiness[0].readyPeerIds, []);
  registry.setAgentPeerState(socket, owner.roomId, owner.id, state.routeEpoch, true, 10_001);
  assert.deepEqual(registry.snapshot(owner.roomId, members).readiness[0].readyPeerIds, [owner.id]);
  assert.throws(() => registry.setBrowserPeerState(
    owner.roomId, "creator-edge", state.routeEpoch - 1, guest.id, true, 10_001,
  ), /stale_agent_route/);
  assert.throws(() => registry.heartbeat(socket, [], 11_000), /stale_agent_lease/);
  registry.heartbeat(socket, [{ roomId: owner.roomId, routeEpoch: state.routeEpoch }], 39_000);
  assert.equal(registry.reconcile(owner.roomId, members, 1, 40_000).primary.id, "creator-edge");
});

test("a consented healthy media agent starts at three peers and revocation returns to direct media", () => {
  const registry = new MediaAgentRegistry({ definitions: [{
    id: "creator-edge", ownerPrincipal: `${issuer}|owner`, sharedSecret: secret,
  }] });
  const socket = {};
  authenticate(registry, socket);
  registry.setCapability(socket, {
    visible: true, battery: "mains", network: "fast", capacity: 80, load: 5,
    maxRooms: 8, maxPeers: 20, maxTracks: 80,
  }, 10_000);
  const members = [
    peer("0000000000000000", `${issuer}|owner`, true),
    peer("1111111111111111", `${issuer}|one`),
    peer("2222222222222222", `${issuer}|two`),
    peer("3333333333333333", `${issuer}|three`),
    peer("4444444444444444", `${issuer}|four`),
  ];
  registry.setConsent(members[0], {
    enabled: true, agentId: "creator-edge", automaticTakeover: false,
  }, members[0].principal, 10_000);

  const pair = registry.reconcile(members[0].roomId, members.slice(0, 2), 1, 10_000);
  assert.equal(pair.primary, null);
  assert.deepEqual(pair.publisherAssignments, []);
  for (const participantCount of [3, 4, 5]) {
    const state = registry.reconcile(
      members[0].roomId, members.slice(0, participantCount), participantCount, 10_000 + participantCount,
    );
    assert.equal(state.primary.id, "creator-edge");
    assert.deepEqual(state.forwarderIds, ["creator-edge"]);
    assert.equal(state.publisherAssignments.length, participantCount);
  }

  registry.setConsent(members[0], {
    enabled: false, agentId: "creator-edge", automaticTakeover: false,
  }, members[0].principal, 11_000);
  const direct = registry.reconcile(members[0].roomId, members, 6, 11_000);
  assert.equal(direct.primary, null);
  assert.deepEqual(direct.forwarderIds, []);
  assert.deepEqual(direct.publisherAssignments, []);
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
  const roomMembers = (owner) => [
    owner,
    { ...peer("1111111111111111", `${issuer}|guest-a`), roomId: owner.roomId },
    { ...peer("2222222222222222", `${issuer}|guest-b`), roomId: owner.roomId },
  ];
  registry.setConsent(first, {
    enabled: true, agentId: "creator-edge", automaticTakeover: false,
  }, first.principal, 10_000);
  registry.setConsent(second, {
    enabled: true, agentId: "creator-edge", automaticTakeover: false,
  }, second.principal, 10_000);
  assert.equal(registry.reconcile(first.roomId, roomMembers(first), 1, 10_000).primary.id, "creator-edge");
  assert.equal(registry.reconcile(second.roomId, roomMembers(second), 1, 10_001).primary, null);
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
  const observer = peer("1111111111111111", `${issuer}|observer`);
  const members = [owner, guest, observer];
  registry.setConsent(owner, { enabled: true, agentId: "creator-edge", automaticTakeover: false }, owner.principal, 10_000);
  registry.setConsent(guest, { enabled: true, agentId: "guest-edge", automaticTakeover: false }, owner.principal, 10_000);
  assert.equal(registry.reconcile(owner.roomId, members, 1, 10_000).primary.id, "creator-edge");
  registry.disconnect(firstSocket);
  const awaiting = registry.reconcile(owner.roomId, members, 1, 11_000);
  assert.equal(awaiting.primary, null);
  const request = registry.takeoverRequest(owner.roomId);
  assert.equal(request.agentId, "guest-edge");
  registry.respondToTakeover(guest, { requestId: request.requestId, accepted: true }, 12_000);
  const promoted = registry.reconcile(owner.roomId, members, 1, 12_000);
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
  const small = registry.reconcile(members[0].roomId, members.slice(0, 3), 1, 10_000);
  assert.deepEqual(small.forwarderIds, ["creator-edge"]);
  assert.deepEqual(
    registry.roomLeases("helper-edge", () => members.slice(0, 3), () => [])[0].peers.map(({ publish }) => publish),
    [false, false, false],
  );
  const state = registry.reconcile(members[0].roomId, members, 2, 11_000);
  assert.equal(state.version, 3);
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
  assert.equal(lease.version, 3);
  assert.equal(lease.role, "standby");
  assert.deepEqual(lease.peers.filter(({ publish }) => publish).map(({ id }) => id), helperPublishers);
  assert.deepEqual(lease.peers.filter(({ subscribe }) => subscribe).map(({ id }) => id), helperPublishers);
  assert.deepEqual(lease.peers.filter(({ connect }) => connect).map(({ id }) => id), helperPublishers);
  const helperPublisher = helperPublishers[0];
  const subscriber = members.find(({ id }) => helperPublishers.includes(id) && id !== helperPublisher);
  registry.setSubscriptionIntent(subscriber, {
    type: "media-agent-subscription-intent",
    agentId: "helper-edge",
    roomId: members[0].roomId,
    routeEpoch: state.routeEpoch,
    publisherPeerId: helperPublisher,
    publicationId: "camera-track",
    enabled: true,
    preferredLayer: "medium",
    maximumLayer: "high",
  }, { publicationId: "camera-track", source: "camera" }, 11_001);
  const [subscriptionLease] = registry.roomLeases("helper-edge", () => members, () => []);
  assert.deepEqual(subscriptionLease.subscriptions, [{
    subscriberPeerId: subscriber.id,
    publisherPeerId: helperPublisher,
    publicationId: "camera-track",
    source: "camera",
    enabled: true,
    preferredLayer: "medium",
    maximumLayer: "high",
    revision: 1,
  }]);
  assert.throws(() => registry.acknowledgeSubscription(subscriber, {
    agentId: "helper-edge",
    roomId: members[0].roomId,
    routeEpoch: state.routeEpoch,
    publisherPeerId: helperPublisher,
    publicationId: "camera-track",
    ready: true,
  }, 11_001), /stale_agent_subscription/);
  registry.setAgentSubscriptionState(
    members[0].roomId,
    "helper-edge",
    state.routeEpoch,
    subscriber.id,
    helperPublisher,
    "camera-track",
    1,
    "medium",
    true,
    11_001,
  );
  assert.equal(registry.acknowledgeSubscription(subscriber, {
    agentId: "helper-edge",
    roomId: members[0].roomId,
    routeEpoch: state.routeEpoch,
    publisherPeerId: helperPublisher,
    publicationId: "camera-track",
    revision: 1,
    ready: true,
  }, 11_001).selectedLayer, "medium");
  registry.setSubscriptionIntent(subscriber, {
    type: "media-agent-subscription-intent",
    agentId: "helper-edge",
    roomId: members[0].roomId,
    routeEpoch: state.routeEpoch,
    publisherPeerId: helperPublisher,
    publicationId: "camera-track",
    enabled: true,
    preferredLayer: "low",
    maximumLayer: "medium",
  }, { publicationId: "camera-track", source: "camera" }, 11_002);
  assert.throws(() => registry.setAgentSubscriptionState(
    members[0].roomId,
    "helper-edge",
    state.routeEpoch,
    subscriber.id,
    helperPublisher,
    "camera-track",
    1,
    "medium",
    true,
    11_002,
  ), /stale_agent_subscription/);
  assert.throws(() => registry.setAgentSubscriptionState(
    members[0].roomId,
    "helper-edge",
    state.routeEpoch,
    subscriber.id,
    helperPublisher,
    "camera-track",
    2,
    "medium",
    true,
    11_002,
  ), /stale_agent_subscription/);
  registry.setAgentSubscriptionState(
    members[0].roomId,
    "helper-edge",
    state.routeEpoch,
    subscriber.id,
    helperPublisher,
    "camera-track",
    2,
    "low",
    true,
    11_002,
  );
  assert.throws(() => registry.acknowledgeSubscription(subscriber, {
    agentId: "helper-edge",
    roomId: members[0].roomId,
    routeEpoch: state.routeEpoch,
    publisherPeerId: helperPublisher,
    publicationId: "camera-track",
    revision: 1,
    ready: true,
  }, 11_002), /stale_agent_subscription/);
  assert.equal(registry.acknowledgeSubscription(subscriber, {
    agentId: "helper-edge",
    roomId: members[0].roomId,
    routeEpoch: state.routeEpoch,
    publisherPeerId: helperPublisher,
    publicationId: "camera-track",
    revision: 2,
    ready: true,
  }, 11_002).selectedLayer, "low");
  assert.throws(() => registry.setSubscriptionIntent(subscriber, {
    type: "media-agent-subscription-intent",
    agentId: "helper-edge",
    roomId: members[0].roomId,
    routeEpoch: state.routeEpoch,
    publisherPeerId: helperPublisher,
    publicationId: "camera-track",
    enabled: true,
    preferredLayer: "audio",
    maximumLayer: "audio",
  }, { publicationId: "camera-track", source: "camera" }, 11_001), /invalid_agent_subscription_intent/);
  assert.equal(registry.authorizePublisher(
    members[0].roomId, "helper-edge", state.routeEpoch, helperPublishers[0], 11_001,
  ), true);
  assert.equal(registry.authorizePublisher(
    members[0].roomId, "creator-edge", state.routeEpoch, helperPublishers[0], 11_001,
  ), false);
});

test("three agents receive a bounded DAG and exact cross-shard layer demands", () => {
  const relayASecret = "relay-a-secret-that-is-long-enough-123456";
  const relayBSecret = "relay-b-secret-that-is-long-enough-123456";
  const definitions = [
    { id: "creator-edge", ownerPrincipal: `${issuer}|owner`, sharedSecret: secret },
    { id: "relay-a", ownerPrincipal: `${issuer}|relay-a`, sharedSecret: relayASecret },
    { id: "relay-b", ownerPrincipal: `${issuer}|relay-b`, sharedSecret: relayBSecret },
  ];
  const registry = new MediaAgentRegistry({ definitions, shardMinParticipants: 6, maxStandbys: 2 });
  const sockets = new Map(definitions.map((definition) => [definition.id, {}]));
  for (const definition of definitions) {
    authenticateAgent(registry, sockets.get(definition.id), definition.id, definition.sharedSecret);
  }
  const members = [
    peer("0000000000000000", `${issuer}|owner`, true),
    peer("1111111111111111", `${issuer}|relay-a`),
    peer("2222222222222222", `${issuer}|relay-b`),
    peer("3333333333333333", `${issuer}|three`),
    peer("4444444444444444", `${issuer}|four`),
    peer("5555555555555555", `${issuer}|five`),
  ];
  for (const [index, definition] of definitions.entries()) {
    registry.setConsent(members[index], {
      enabled: true,
      agentId: definition.id,
      automaticTakeover: false,
    }, members[0].principal, 10_000);
  }
  const state = registry.reconcile(members[0].roomId, members, 1, 10_000);
  assert.deepEqual(state.forwarderIds, ["creator-edge", "relay-a", "relay-b"]);
  assert.equal(state.publisherAssignments.length, members.length);
  assert.equal(state.subscriberAssignments.length, members.length);
  assert.equal(new Set(state.subscriberAssignments.map(({ peerId }) => peerId)).size, members.length);
  assert.equal(state.federationLinks.length, 2);
  for (const link of state.federationLinks) {
    assert.ok(new Set([link.leftAgentId, link.rightAgentId]).has("creator-edge"));
    assert.equal(link.readyAgentIds.length, 0);
  }
  const links = new Map(state.federationLinks.map((link) => [link.linkId, link]));
  for (const route of state.federationRoutes) {
    const visited = new Set([route.sourceAgentId]);
    const depth = new Map([[route.sourceAgentId, 0]]);
    for (const edge of route.edges) {
      const link = links.get(edge.linkId);
      assert.ok(link);
      assert.ok(visited.has(edge.fromAgentId));
      assert.equal(visited.has(edge.toAgentId), false);
      assert.ok(new Set([link.leftAgentId, link.rightAgentId]).has(edge.fromAgentId));
      assert.ok(new Set([link.leftAgentId, link.rightAgentId]).has(edge.toAgentId));
      depth.set(edge.toAgentId, depth.get(edge.fromAgentId) + 1);
      assert.ok(depth.get(edge.toAgentId) <= route.maximumHops);
      visited.add(edge.toAgentId);
    }
  }

  const publisher = members[1];
  const subscriber = members[2];
  assert.deepEqual(state.publisherAssignments.find(({ peerId }) => peerId === publisher.id), {
    peerId: publisher.id,
    agentId: "relay-a",
  });
  assert.deepEqual(state.subscriberAssignments.find(({ peerId }) => peerId === subscriber.id), {
    peerId: subscriber.id,
    agentId: "relay-b",
  });
  registry.setSubscriptionIntent(subscriber, {
    type: "media-agent-subscription-intent",
    agentId: "relay-b",
    roomId: publisher.roomId,
    routeEpoch: state.routeEpoch,
    publisherPeerId: publisher.id,
    publicationId: "camera-track",
    enabled: true,
    preferredLayer: "low",
    maximumLayer: "high",
  }, { publicationId: "camera-track", source: "camera" }, 10_001);
  const leases = new Map(state.forwarderIds.map((agentId) => [
    agentId,
    registry.roomLeases(agentId, () => members, () => [])[0],
  ]));
  assert.equal(leases.get("relay-a").subscriptions.length, 0);
  assert.equal(leases.get("creator-edge").subscriptions.length, 0);
  assert.equal(leases.get("relay-b").subscriptions.length, 1);
  assert.deepEqual(leases.get("relay-a").federationDemands.map(({ fromAgentId, toAgentId, layer }) => ({
    fromAgentId, toAgentId, layer,
  })), [{ fromAgentId: "relay-a", toAgentId: "creator-edge", layer: "low" }]);
  assert.deepEqual(leases.get("creator-edge").federationDemands.map((demand) => (
    `${demand.fromAgentId}>${demand.toAgentId}:${demand.layer}`
  )).sort(), ["creator-edge>relay-b:low", "relay-a>creator-edge:low"]);
  assert.deepEqual(leases.get("relay-b").federationDemands.map(({ fromAgentId, toAgentId, layer }) => ({
    fromAgentId, toAgentId, layer,
  })), [{ fromAgentId: "creator-edge", toAgentId: "relay-b", layer: "low" }]);

  registry.setPublicationLayerState(
    publisher.roomId, "relay-a", state.routeEpoch, publisher.id, "camera-track", "camera", "single", true, 10_002,
  );
  assert.deepEqual(
    registry.roomLeases("creator-edge", () => members, () => [])[0]
      .federationDemands.map(({ layer }) => layer),
    ["single", "single"],
  );
  registry.setPublicationLayerState(
    publisher.roomId, "relay-a", state.routeEpoch, publisher.id, "camera-track", "camera", "single", false, 10_003,
  );
  registry.setPublicationLayerState(
    publisher.roomId, "relay-a", state.routeEpoch, publisher.id, "camera-track", "camera", "low", true, 10_003,
  );
  registry.setPublicationLayerState(
    publisher.roomId, "relay-a", state.routeEpoch, publisher.id, "camera-track", "camera", "medium", true, 10_003,
  );
  registry.setSubscriptionIntent(subscriber, {
    type: "media-agent-subscription-intent",
    agentId: "relay-b",
    roomId: publisher.roomId,
    routeEpoch: state.routeEpoch,
    publisherPeerId: publisher.id,
    publicationId: "camera-track",
    enabled: true,
    preferredLayer: "high",
    maximumLayer: "high",
  }, { publicationId: "camera-track", source: "camera" }, 10_003);
  assert.deepEqual(
    registry.roomLeases("creator-edge", () => members, () => [])[0]
      .federationDemands.map(({ layer }) => layer),
    ["medium", "medium"],
  );
  registry.setPublicationLayerState(
    publisher.roomId, "relay-a", state.routeEpoch, publisher.id, "camera-track", "camera", "high", true, 10_004,
  );
  assert.deepEqual(
    registry.roomLeases("creator-edge", () => members, () => [])[0]
      .federationDemands.map(({ layer }) => layer),
    ["high", "high"],
  );
  for (const [agentId, lease] of leases) {
    assert.ok(lease.federationLinks.every((link) => (
      link.leftAgentId === agentId || link.rightAgentId === agentId
    )));
  }

  const firstLink = state.federationLinks[0];
  const firstRemote = firstLink.leftAgentId === "creator-edge" ? firstLink.rightAgentId : firstLink.leftAgentId;
  assert.ok(registry.federationLink(
    publisher.roomId, state.routeEpoch, firstLink.linkId, "creator-edge", firstRemote, 10_001,
  ));
  assert.equal(registry.federationLink(
    publisher.roomId, state.routeEpoch - 1, firstLink.linkId, "creator-edge", firstRemote, 10_001,
  ), null);
  assert.equal(registry.federationLink(
    publisher.roomId, state.routeEpoch, firstLink.linkId, "relay-a", "relay-b", 10_001,
  ), null);
  assert.equal(registry.setFederationState(
    sockets.get("creator-edge"), publisher.roomId, state.routeEpoch,
    firstLink.linkId, firstRemote, true, 10_001,
  ), false);
  assert.equal(registry.setFederationState(
    sockets.get(firstRemote), publisher.roomId, state.routeEpoch,
    firstLink.linkId, "creator-edge", true, 10_001,
  ), true);
  assert.deepEqual(
    registry.snapshot(publisher.roomId, members).federationLinks
      .find(({ linkId }) => linkId === firstLink.linkId).readyAgentIds,
    ["creator-edge", firstRemote].sort(),
  );
});

test("twenty peers retain four bounded publication plans beyond the former control-frame limit", () => {
  const registry = new MediaAgentRegistry({ definitions: [{
    id: "creator-edge", ownerPrincipal: `${issuer}|owner`, sharedSecret: secret,
  }] });
  const socket = {};
  authenticate(registry, socket);
  const members = Array.from({ length: 20 }, (_, index) => peer(
    index.toString(16).padStart(16, "0"),
    index === 0 ? `${issuer}|owner` : `${issuer}|member-${index}`,
    index === 0,
  ));
  registry.setConsent(members[0], {
    enabled: true, agentId: "creator-edge", automaticTakeover: false,
  }, members[0].principal, 10_000);
  const state = registry.reconcile(members[0].roomId, members, 1, 10_000);
  const publications = [
    { prefix: "mic", source: "microphone", layer: "audio" },
    { prefix: "cam", source: "camera", layer: "medium" },
    { prefix: "screen", source: "screen", layer: "single" },
    { prefix: "screen-audio", source: "screen-audio", layer: "audio" },
  ];
  for (const subscriber of members) {
    for (const publisher of members) {
      if (publisher.id === subscriber.id) continue;
      for (const publication of publications) {
        const publicationId = `${publication.prefix}-${publisher.id}`;
        registry.setSubscriptionIntent(subscriber, {
          type: "media-agent-subscription-intent",
          agentId: "creator-edge",
          roomId: subscriber.roomId,
          routeEpoch: state.routeEpoch,
          publisherPeerId: publisher.id,
          publicationId,
          enabled: true,
          preferredLayer: publication.layer,
          maximumLayer: publication.layer === "medium" ? "high" : publication.layer,
        }, { publicationId, source: publication.source }, 10_001);
      }
    }
  }
  const lease = registry.roomLeases("creator-edge", () => members, () => [])[0];
  assert.equal(lease.subscriptions.length, 1_520);
  const bytes = Buffer.byteLength(JSON.stringify({ version: 1, type: "agent-sync", leases: [lease] }));
  assert.ok(bytes > 96 * 1024);
  assert.ok(bytes < 32 * 1024 * 1024);
});

test("empty-room cleanup revokes every route and lease", () => {
  const registry = new MediaAgentRegistry({ definitions: [{
    id: "creator-edge", ownerPrincipal: `${issuer}|owner`, sharedSecret: secret,
  }] });
  const socket = {};
  authenticate(registry, socket);
  const owner = peer("0123456789abcdef", `${issuer}|owner`, true);
  const guestA = peer("1111111111111111", `${issuer}|guest-a`);
  const guestB = peer("2222222222222222", `${issuer}|guest-b`);
  registry.setConsent(owner, {
    enabled: true, agentId: "creator-edge", automaticTakeover: false,
  }, owner.principal, 10_000);
  const route = registry.reconcile(owner.roomId, [owner, guestA, guestB], 1, 10_000);
  assert.equal(registry.authorize(owner.roomId, "creator-edge", route.routeEpoch, owner.id, 10_001), true);
  assert.equal(registry.removeRoom(owner.roomId), true);
  assert.equal(registry.snapshot(owner.roomId), null);
  assert.deepEqual(registry.roomLeases("creator-edge", () => [], () => []), []);
  assert.equal(registry.authorize(owner.roomId, "creator-edge", route.routeEpoch, owner.id, 10_001), false);
});
