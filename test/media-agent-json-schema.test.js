import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

const contract = async (name) => JSON.parse(await readFile(
  new URL(`../contracts/media-agent/${name}`, import.meta.url),
  "utf8",
));

test("canonical media-agent JSON Schemas are closed and validate cross-runtime examples", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const [
    intentSchema,
    ackSchema,
    leaseSchema,
    layerSchema,
    agentSubscriptionSchema,
    browserSubscriptionSchema,
    federationSchema,
    federationSignalSchema,
    federationStateSchema,
    routeStateSchema,
    enrollmentSchema,
    authenticationSchema,
    browserAgentNegotiationSchema,
  ] = await Promise.all([
    contract("subscription-intent.v1.schema.json"),
    contract("subscription-ack.v1.schema.json"),
    contract("agent-lease.v3.schema.json"),
    contract("publication-layer-state.v2.schema.json"),
    contract("agent-subscription-state.v2.schema.json"),
    contract("browser-subscription-state.v2.schema.json"),
    contract("federation-control.v1.schema.json"),
    contract("federation-signal.v1.schema.json"),
    contract("federation-state.v1.schema.json"),
    contract("media-agent-route-state.v3.schema.json"),
    contract("agent-enrollment.v1.schema.json"),
    contract("agent-authentication.v2.schema.json"),
    contract("browser-agent-negotiation-control.v1.schema.json"),
  ]);
  const validateIntent = ajv.compile(intentSchema);
  const validateAck = ajv.compile(ackSchema);
  const validateLease = ajv.compile(leaseSchema);
  const validateLayer = ajv.compile(layerSchema);
  const validateAgentSubscription = ajv.compile(agentSubscriptionSchema);
  const validateBrowserSubscription = ajv.compile(browserSubscriptionSchema);
  const validateFederation = ajv.compile(federationSchema);
  const validateFederationSignal = ajv.compile(federationSignalSchema);
  const validateFederationState = ajv.compile(federationStateSchema);
  const validateRouteState = ajv.compile(routeStateSchema);
  const validateEnrollment = ajv.compile(enrollmentSchema);
  const validateAuthentication = ajv.compile(authenticationSchema);
  const validateBrowserAgentNegotiation = ajv.compile(browserAgentNegotiationSchema);
  const enrollment = {
    version: 1,
    type: "enroll",
    agentId: "edge-0123456789abcdef",
    enrollmentToken: "A".repeat(43),
    timestamp: 1_800_000_000_000,
    publicKey: { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "B".repeat(43), ext: true },
    proof: "C".repeat(86),
  };
  assert.equal(validateEnrollment(enrollment), true, JSON.stringify(validateEnrollment.errors));
  assert.equal(validateEnrollment({ ...enrollment, ownerPrincipal: "forbidden" }), false);
  assert.equal(validateAuthentication({
    version: 2,
    type: "authenticate",
    agentId: enrollment.agentId,
    timestamp: enrollment.timestamp,
    proof: "D".repeat(86),
  }), true, JSON.stringify(validateAuthentication.errors));
  assert.equal(validateAuthentication({
    version: 2,
    type: "authenticate",
    agentId: enrollment.agentId,
    timestamp: enrollment.timestamp,
    proof: "short",
  }), false);
  const browserAgentRequest = {
    version: 1,
    type: "media-agent-negotiation-request",
    routeEpoch: 7,
    sequence: 1,
  };
  assert.equal(validateBrowserAgentNegotiation(browserAgentRequest), true,
    JSON.stringify(validateBrowserAgentNegotiation.errors));
  assert.equal(validateBrowserAgentNegotiation({
    ...browserAgentRequest,
    type: "media-agent-negotiation-grant",
  }), true, JSON.stringify(validateBrowserAgentNegotiation.errors));
  assert.equal(validateBrowserAgentNegotiation({ ...browserAgentRequest, authority: true }), false);
  assert.equal(validateBrowserAgentNegotiation({ ...browserAgentRequest, sequence: 0 }), false);
  const intent = {
    version: 1,
    type: "media-agent-subscription-intent",
    agentId: "owner-edge",
    roomId: "room-123456",
    routeEpoch: 7,
    publisherPeerId: "0123456789abcdef",
    publicationId: "camera-track",
    enabled: true,
    preferredLayer: "medium",
    maximumLayer: "high",
  };
  assert.equal(validateIntent(intent), true, JSON.stringify(validateIntent.errors));
  assert.equal(validateIntent({ ...intent, authority: "forbidden" }), false);
  assert.equal(validateAck({
    version: 1,
    type: "media-agent-subscription-ack",
    agentId: "owner-edge",
    roomId: "room-123456",
    routeEpoch: 7,
    publisherPeerId: "0123456789abcdef",
    publicationId: "camera-track",
    revision: 4,
    ready: true,
  }), true, JSON.stringify(validateAck.errors));
  const lease = {
    version: 3,
    type: "agent-lease",
    roomId: "room-123456",
    role: "primary",
    membershipEpoch: 4,
    routeEpoch: 7,
    leaseExpiresAt: 1_800_000_030_000,
    peers: [
      { id: "0123456789abcdef", connect: true, publish: true, subscribe: true },
      { id: "fedcba9876543210", connect: true, publish: false, subscribe: true },
    ],
    subscriptions: [{
      subscriberPeerId: "fedcba9876543210",
      publisherPeerId: "0123456789abcdef",
      publicationId: "camera-track",
      source: "camera",
      enabled: true,
      preferredLayer: "medium",
      maximumLayer: "high",
      revision: 1,
    }],
    federationLinks: [],
    federationRoutes: [],
    federationDemands: [],
    iceServers: [{ urls: ["stun:stun.test:3478"] }],
  };
  assert.equal(validateLease(lease), true, JSON.stringify(validateLease.errors));
  assert.equal(validateLease({ ...lease, roomAuthority: true }), false);
  assert.equal(validateLayer({
    version: 2,
    type: "track-state",
    roomId: "room-123456",
    peerId: "0123456789abcdef",
    routeEpoch: 7,
    publicationId: "camera-track",
    layer: "high",
    rid: "f",
    active: true,
  }), true, JSON.stringify(validateLayer.errors));
  assert.equal(validateAgentSubscription({
    version: 2,
    type: "subscription-state",
    roomId: "room-123456",
    routeEpoch: 7,
    publisherPeerId: "0123456789abcdef",
    publicationId: "camera-track",
    subscriberPeerId: "fedcba9876543210",
    selectedLayer: "high",
    revision: 1,
    ready: true,
  }), true, JSON.stringify(validateAgentSubscription.errors));
  assert.equal(validateBrowserSubscription({
    version: 2,
    type: "media-agent-subscription-state",
    agentId: "owner-edge",
    routeEpoch: 7,
    publicationId: "camera-track",
    subscriberPeerId: "fedcba9876543210",
    selectedLayer: "high",
    revision: 1,
    ready: true,
  }), true, JSON.stringify(validateBrowserSubscription.errors));
  assert.equal(validateFederation({
    version: 1,
    type: "federation-hello",
    roomId: "room-123456",
    routeEpoch: 7,
    linkId: "abcdefghijklmnopqrstuv",
    agentId: "owner-edge",
    leaseExpiresAt: 1_800_000_030_000,
  }), true, JSON.stringify(validateFederation.errors));
  for (const type of ["federation-negotiation-request", "federation-negotiation-grant"]) {
    assert.equal(validateFederation({
      version: 1,
      type,
      roomId: "room-123456",
      routeEpoch: 7,
      linkId: "abcdefghijklmnopqrstuv",
      agentId: "owner-edge",
      sequence: 1,
    }), true, JSON.stringify(validateFederation.errors));
  }
  assert.equal(validateFederation({
    version: 1,
    type: "federation-negotiation-request",
    roomId: "room-123456",
    routeEpoch: 7,
    linkId: "abcdefghijklmnopqrstuv",
    agentId: "owner-edge",
    sequence: 0,
  }), false);
  assert.equal(validateFederationSignal({
    version: 1,
    type: "federation-signal",
    recipientAgentId: "helper-edge",
    roomId: "room-123456",
    routeEpoch: 7,
    linkId: "abcdefghijklmnopqrstuv",
    candidate: null,
  }), true, JSON.stringify(validateFederationSignal.errors));
  assert.equal(validateFederationState({
    version: 1,
    type: "federation-state",
    roomId: "room-123456",
    routeEpoch: 7,
    linkId: "abcdefghijklmnopqrstuv",
    remoteAgentId: "helper-edge",
    connected: true,
  }), true, JSON.stringify(validateFederationState.errors));
  assert.equal(validateRouteState({
    version: 3,
    type: "media-agent-state",
    enabled: true,
    membershipEpoch: 4,
    routeEpoch: 7,
    leaseExpiresAt: 1_800_000_030_000,
    primary: { id: "owner-edge", ownerPeerId: "0123456789abcdef", creatorPreferred: true },
    standbys: [{ id: "helper-edge", ownerPeerId: "fedcba9876543210", creatorPreferred: false }],
    forwarderIds: ["owner-edge", "helper-edge"],
    publisherAssignments: [
      { peerId: "0123456789abcdef", agentId: "owner-edge" },
      { peerId: "fedcba9876543210", agentId: "helper-edge" },
    ],
    subscriberAssignments: [
      { peerId: "0123456789abcdef", agentId: "owner-edge" },
      { peerId: "fedcba9876543210", agentId: "helper-edge" },
    ],
    federationLinks: [{
      linkId: "abcdefghijklmnopqrstuv",
      leftAgentId: "helper-edge",
      rightAgentId: "owner-edge",
      initiatorAgentId: "helper-edge",
      readyAgentIds: [],
    }],
    federationRoutes: [{
      publisherPeerId: "0123456789abcdef",
      sourceAgentId: "owner-edge",
      maximumHops: 2,
      edges: [{
        linkId: "abcdefghijklmnopqrstuv",
        fromAgentId: "owner-edge",
        toAgentId: "helper-edge",
      }],
    }],
    readiness: [
      { agentId: "owner-edge", readyPeerIds: ["0123456789abcdef"] },
      { agentId: "helper-edge", readyPeerIds: [] },
    ],
  }), true, JSON.stringify(validateRouteState.errors));
  assert.equal(validateFederationState({
    version: 1,
    type: "federation-state",
    roomId: "room-123456",
    routeEpoch: 7,
    linkId: "abcdefghijklmnopqrstuv",
    remoteAgentId: "helper-edge",
    connected: true,
    membership: "forbidden",
  }), false);
});
