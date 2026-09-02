import crypto from "node:crypto";

import {
  mediaAgentAuthProof,
  mediaAgentEnrollmentProofMessage,
  mediaAgentSignatureMessage,
} from "./media-agent-protocol.js";
import { planMediaAgents } from "./media-agent-election.js";
import { ProtocolError } from "./protocol.js";

const AUTH_WINDOW_MS = 30_000;
const DEFAULT_CAPABILITY = Object.freeze({
  visible: true,
  battery: "unknown",
  network: "unknown",
  capacity: 50,
  load: 0,
  maxRooms: 8,
  maxPeers: 20,
  maxTracks: 80,
});

const MEDIA_LAYERS = new Set(["audio", "single", "low", "medium", "high"]);
const VIDEO_LAYER_RANK = Object.freeze({ low: 0, medium: 1, high: 2 });

function validSubscriptionLayers(source, enabled, preferredLayer, maximumLayer) {
  if (!MEDIA_LAYERS.has(preferredLayer) || !MEDIA_LAYERS.has(maximumLayer)) return false;
  if (source === "microphone" || source === "screen-audio") {
    return preferredLayer === "audio" && maximumLayer === "audio";
  }
  if (source === "screen") return preferredLayer === "single" && maximumLayer === "single";
  if (source !== "camera") return false;
  if (preferredLayer === "single" || maximumLayer === "single") {
    return preferredLayer === "single" && maximumLayer === "single";
  }
  if (!Object.hasOwn(VIDEO_LAYER_RANK, preferredLayer)
    || !Object.hasOwn(VIDEO_LAYER_RANK, maximumLayer)) return false;
  return !enabled || VIDEO_LAYER_RANK[preferredLayer] <= VIDEO_LAYER_RANK[maximumLayer];
}

function validSelectedLayer(plan, selectedLayer) {
  if (plan.source === "microphone" || plan.source === "screen-audio") return selectedLayer === "audio";
  if (plan.source === "screen") return selectedLayer === "single";
  if (plan.source !== "camera") return false;
  if (selectedLayer === "single") return true;
  return Object.hasOwn(VIDEO_LAYER_RANK, selectedLayer)
    && Object.hasOwn(VIDEO_LAYER_RANK, plan.preferredLayer)
    && Object.hasOwn(VIDEO_LAYER_RANK, plan.maximumLayer)
    && VIDEO_LAYER_RANK[selectedLayer] <= VIDEO_LAYER_RANK[plan.preferredLayer]
    && VIDEO_LAYER_RANK[selectedLayer] <= VIDEO_LAYER_RANK[plan.maximumLayer];
}

function proofMatches(expected, actual) {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function signatureMatches(publicKey, message, proof) {
  try {
    return crypto.verify(
      "sha256",
      Buffer.from(message),
      { key: crypto.createPublicKey({ key: publicKey, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      Buffer.from(proof, "base64url"),
    );
  } catch {
    return false;
  }
}

function normalizeDefinition(definition) {
  return Object.freeze({
    ...definition,
    authType: definition.authType || "shared-secret",
  });
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function federationLinkId(roomId, routeEpoch, leftAgentId, rightAgentId) {
  return crypto.createHash("sha256")
    .update(`v1\n${roomId}\n${routeEpoch}\n${leftAgentId}\n${rightAgentId}`)
    .digest("base64url")
    .slice(0, 22);
}

function buildFederationPlan(roomId, routeEpoch, forwarderIds, publisherAssignments, subscriberAssignments, members) {
  const primaryId = forwarderIds[0] || "";
  if (!primaryId || forwarderIds.length < 2) return { links: [], routes: [] };
  const links = forwarderIds.slice(1).map((standbyId) => {
    const [leftAgentId, rightAgentId] = [primaryId, standbyId].sort();
    return Object.freeze({
      linkId: federationLinkId(roomId, routeEpoch, leftAgentId, rightAgentId),
      leftAgentId,
      rightAgentId,
      initiatorAgentId: leftAgentId,
    });
  });
  const linkFor = (left, right) => links.find((link) => (
    new Set([link.leftAgentId, link.rightAgentId]).has(left)
      && new Set([link.leftAgentId, link.rightAgentId]).has(right)
  ));
  const routes = [];
  for (const member of [...members].sort((left, right) => left.id.localeCompare(right.id))) {
    const sourceAgentId = publisherAssignments.get(member.id);
    if (!sourceAgentId) continue;
    const targets = sorted(new Set(members
      .filter((subscriber) => subscriber.id !== member.id)
      .map((subscriber) => subscriberAssignments.get(subscriber.id))
      .filter((agentId) => agentId && agentId !== sourceAgentId)));
    const edges = [];
    if (sourceAgentId === primaryId) {
      for (const target of targets) {
        const link = linkFor(primaryId, target);
        if (link) edges.push(Object.freeze({ linkId: link.linkId, fromAgentId: primaryId, toAgentId: target }));
      }
    } else if (targets.length > 0) {
      const ingress = linkFor(sourceAgentId, primaryId);
      if (ingress) edges.push(Object.freeze({
        linkId: ingress.linkId,
        fromAgentId: sourceAgentId,
        toAgentId: primaryId,
      }));
      for (const target of targets.filter((agentId) => agentId !== primaryId)) {
        const downstream = linkFor(primaryId, target);
        if (downstream) edges.push(Object.freeze({
          linkId: downstream.linkId,
          fromAgentId: primaryId,
          toAgentId: target,
        }));
      }
    }
    if (edges.length > 0) routes.push(Object.freeze({
      publisherPeerId: member.id,
      sourceAgentId,
      maximumHops: 2,
      edges: Object.freeze(edges),
    }));
  }
  return { links: Object.freeze(links), routes: Object.freeze(routes) };
}

function federationPath(route, targetAgentId) {
  const bySource = new Map();
  for (const edge of route.edges) {
    const edges = bySource.get(edge.fromAgentId) || [];
    edges.push(edge);
    bySource.set(edge.fromAgentId, edges);
  }
  const visit = (agentId, path, seen) => {
    if (agentId === targetAgentId) return path;
    for (const edge of bySource.get(agentId) || []) {
      if (seen.has(edge.toAgentId)) continue;
      const result = visit(edge.toAgentId, [...path, edge], new Set([...seen, edge.toAgentId]));
      if (result) return result;
    }
    return null;
  };
  return visit(route.sourceAgentId, [], new Set([route.sourceAgentId]));
}

function selectedFederationLayer(state, subscription) {
  const publication = state.publicationLayers.get(
    `${subscription.publisherPeerId}\0${subscription.publicationId}`,
  );
  const available = publication?.source === subscription.source ? publication.layers : null;
  // Before the ingress has reported its first RTP layer, retain the requested
  // layer as an optimistic demand. Once reports exist, the control plane sends
  // only the exact available fallback selected by the same bounded policy as
  // the native egress.
  if (!available || available.size === 0) return subscription.preferredLayer;
  if (subscription.preferredLayer === "audio" || subscription.preferredLayer === "single") {
    return available.has(subscription.preferredLayer) ? subscription.preferredLayer : "";
  }
  if (available.has("single")) return "single";
  if (available.has(subscription.preferredLayer)) return subscription.preferredLayer;
  const preferred = VIDEO_LAYER_RANK[subscription.preferredLayer];
  const maximum = VIDEO_LAYER_RANK[subscription.maximumLayer];
  return ["high", "medium", "low"].find((layer) => (
    VIDEO_LAYER_RANK[layer] <= preferred && VIDEO_LAYER_RANK[layer] <= maximum && available.has(layer)
  )) || "";
}

function federationDemands(state) {
  const demands = new Map();
  for (const subscription of state.subscriptions.values()) {
    if (!subscription.enabled) continue;
    const sourceAgentId = state.publisherAssignments.get(subscription.publisherPeerId);
    if (!sourceAgentId || sourceAgentId === subscription.agentId) continue;
    const route = state.federationRoutes.find((candidate) => (
      candidate.publisherPeerId === subscription.publisherPeerId
    ));
    const path = route && federationPath(route, subscription.agentId);
    if (!path) continue;
    const selectedLayer = selectedFederationLayer(state, subscription);
    if (!selectedLayer) continue;
    for (const edge of path) {
      const demand = Object.freeze({
        linkId: edge.linkId,
        fromAgentId: edge.fromAgentId,
        toAgentId: edge.toAgentId,
        publisherPeerId: subscription.publisherPeerId,
        publicationId: subscription.publicationId,
        layer: selectedLayer,
      });
      const key = [
        demand.linkId, demand.fromAgentId, demand.toAgentId,
        demand.publisherPeerId, demand.publicationId, demand.layer,
      ].join("\0");
      demands.set(key, demand);
    }
  }
  return [...demands.values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export class MediaAgentRegistry {
  #agents = new Map();
  #bySocket = new WeakMap();
  #challenges = new WeakMap();
  #consents = new Map();
  #rooms = new Map();
  #leaseMs;
  #maxStandbys;
  #minimumParticipants;
  #shardMinParticipants;
  #takeoverTtlMs;
  #enrollmentStore;

  constructor({
    definitions = [],
    leaseMs = 30_000,
    maxStandbys = 2,
    minimumParticipants = 3,
    shardMinParticipants = 6,
    takeoverTtlMs = 20_000,
    enrollmentStore = null,
  } = {}) {
    this.#leaseMs = leaseMs;
    this.#maxStandbys = maxStandbys;
    this.#minimumParticipants = minimumParticipants;
    this.#shardMinParticipants = shardMinParticipants;
    this.#takeoverTtlMs = takeoverTtlMs;
    this.#enrollmentStore = enrollmentStore;
    for (const definition of definitions) {
      this.registerDefinition(definition);
    }
  }

  issueChallenge(socket, now = Date.now()) {
    const nonce = crypto.randomBytes(24).toString("base64url");
    const challenge = Object.freeze({ nonce, expiresAt: now + AUTH_WINDOW_MS });
    this.#challenges.set(socket, challenge);
    return Object.freeze({ version: 1, type: "agent-challenge", ...challenge });
  }

  authenticate(socket, message, now = Date.now()) {
    const challenge = this.#challenges.get(socket);
    this.#challenges.delete(socket);
    const agent = this.#agents.get(message.agentId);
    if (!challenge || challenge.expiresAt < now || Math.abs(now - message.timestamp) > AUTH_WINDOW_MS || !agent) {
      throw new ProtocolError("agent_authentication_failed");
    }
    const validProof = agent.definition.authType === "public-key"
      ? message.version === 2 && signatureMatches(
        agent.definition.publicKey,
        mediaAgentSignatureMessage(message.agentId, challenge.nonce, message.timestamp),
        message.proof,
      )
      : message.version === undefined && proofMatches(mediaAgentAuthProof(
        agent.definition.sharedSecret,
        message.agentId,
        challenge.nonce,
        message.timestamp,
      ), message.proof);
    if (!validProof) throw new ProtocolError("agent_authentication_failed");
    const replacedSocket = agent.socket && agent.socket !== socket ? agent.socket : null;
    if (replacedSocket) this.#bySocket.delete(replacedSocket);
    agent.socket = socket;
    agent.authenticatedAt = now;
    agent.lastSeen = now;
    agent.messages = [];
    agent.draining = false;
    this.#bySocket.set(socket, agent);
    if (agent.definition.authType === "public-key") {
      this.#enrollmentStore?.markAuthenticated(agent.definition.id, now);
    }
    return Object.freeze({ id: agent.definition.id, replacedSocket });
  }

  enroll(socket, message, now = Date.now()) {
    const challenge = this.#challenges.get(socket);
    this.#challenges.delete(socket);
    if (!this.#enrollmentStore || !challenge || challenge.expiresAt < now
      || Math.abs(now - message.timestamp) > AUTH_WINDOW_MS || this.#agents.has(message.agentId)) {
      throw new ProtocolError("agent_enrollment_failed");
    }
    try {
      this.#enrollmentStore.pendingEnrollment(message.enrollmentToken, message.agentId, now);
    } catch {
      throw new ProtocolError("agent_enrollment_failed");
    }
    const validProof = signatureMatches(
      message.publicKey,
      mediaAgentEnrollmentProofMessage(
        message.agentId,
        challenge.nonce,
        message.timestamp,
        message.enrollmentToken,
        message.publicKey,
      ),
      message.proof,
    );
    if (!validProof) throw new ProtocolError("agent_enrollment_failed");
    let definition;
    try {
      definition = this.#enrollmentStore.completeEnrollment({
        token: message.enrollmentToken,
        agentId: message.agentId,
        publicKey: message.publicKey,
        now,
      });
    } catch {
      throw new ProtocolError("agent_enrollment_failed");
    }
    this.registerDefinition(definition);
    return Object.freeze({
      id: definition.id,
      ownerPrincipal: definition.ownerPrincipal,
      keyFingerprint: definition.keyFingerprint,
    });
  }

  registerDefinition(input) {
    const definition = normalizeDefinition(input);
    if (this.#agents.has(definition.id)) throw new ProtocolError("media_agent_id_conflict");
    this.#agents.set(definition.id, {
      definition,
      socket: null,
      authenticatedAt: 0,
      lastSeen: 0,
      messages: [],
      capability: { ...DEFAULT_CAPABILITY },
      draining: false,
    });
    return definition;
  }

  revoke(agentId) {
    const agent = this.#agents.get(agentId);
    if (!agent || agent.definition.authType !== "public-key") {
      throw new ProtocolError("media_agent_not_found");
    }
    const affectedRoomIds = this.roomsAffectedByAgent(agentId);
    for (const [roomId, consents] of this.#consents) {
      for (const [peerId, consent] of consents) {
        if (consent.agentId === agentId) consents.delete(peerId);
      }
      if (consents.size === 0) this.#consents.delete(roomId);
    }
    if (agent.socket) this.#bySocket.delete(agent.socket);
    this.#agents.delete(agentId);
    return Object.freeze({
      affectedRoomIds: Object.freeze(affectedRoomIds),
      ownerPrincipal: agent.definition.ownerPrincipal,
      socket: agent.socket,
    });
  }

  connection(socket) {
    const agent = this.#bySocket.get(socket);
    return agent ? Object.freeze({
      id: agent.definition.id,
      ownerPrincipal: agent.definition.ownerPrincipal,
      socket: agent.socket,
    }) : null;
  }

  disconnect(socket) {
    const agent = this.#bySocket.get(socket);
    this.#bySocket.delete(socket);
    this.#challenges.delete(socket);
    if (!agent || agent.socket !== socket) return [];
    agent.socket = null;
    agent.lastSeen = 0;
    agent.draining = false;
    return this.roomsAffectedByAgent(agent.definition.id);
  }

  allowMessage(socket, now = Date.now(), { limit = 240, windowMs = 10_000 } = {}) {
    const agent = this.#bySocket.get(socket);
    if (!agent) return false;
    agent.messages = agent.messages.filter((timestamp) => now - timestamp < windowMs);
    if (agent.messages.length >= limit) return false;
    agent.messages.push(now);
    return true;
  }

  setCapability(socket, capability) {
    const agent = this.#bySocket.get(socket);
    if (!agent) throw new ProtocolError("agent_not_authenticated");
    agent.capability = { ...capability };
    return this.roomsAffectedByAgent(agent.definition.id);
  }

  heartbeat(socket, rooms, now = Date.now()) {
    const agent = this.#bySocket.get(socket);
    if (!agent) throw new ProtocolError("agent_not_authenticated");
    const expectedRoomIds = this.roomsForAgent(agent.definition.id);
    if (rooms.length !== expectedRoomIds.length
      || new Set(rooms.map(({ roomId }) => roomId)).size !== rooms.length) {
      throw new ProtocolError("stale_agent_lease");
    }
    const heartbeatByRoom = new Map(rooms.map((room) => [room.roomId, room]));
    for (const roomId of expectedRoomIds) {
      const state = this.#rooms.get(roomId);
      const heartbeat = heartbeatByRoom.get(roomId);
      if (!heartbeat || !state || state.routeEpoch !== heartbeat.routeEpoch
        || !new Set([state.primaryId, ...state.standbyIds]).has(agent.definition.id)) {
        throw new ProtocolError("stale_agent_lease");
      }
    }
    agent.lastSeen = now;
  }

  setDraining(socket, enabled, now = Date.now()) {
    const agent = this.#bySocket.get(socket);
    if (!agent) throw new ProtocolError("agent_not_authenticated");
    agent.draining = enabled;
    agent.lastSeen = now;
    return this.roomsAffectedByAgent(agent.definition.id);
  }

  setConsent(peer, input, creatorPrincipal = "", now = Date.now()) {
    const definition = this.#agents.get(input.agentId)?.definition;
    if (!definition || definition.ownerPrincipal !== peer.principal) {
      throw new ProtocolError("media_agent_not_owned");
    }
    let room = this.#consents.get(peer.roomId);
    if (!room) {
      room = new Map();
      this.#consents.set(peer.roomId, room);
    }
    if (!input.enabled) {
      room.delete(peer.id);
      if (room.size === 0) this.#consents.delete(peer.roomId);
      return null;
    }
    const consent = Object.freeze({
      peerId: peer.id,
      principal: peer.principal,
      agentId: input.agentId,
      automaticTakeover: input.automaticTakeover,
      creatorOwned: Boolean(creatorPrincipal) ? peer.principal === creatorPrincipal : peer.creator === true,
      updatedAt: now,
    });
    room.set(peer.id, consent);
    return consent;
  }

  leavePeer(peer) {
    const room = this.#consents.get(peer.roomId);
    room?.delete(peer.id);
    if (room?.size === 0) this.#consents.delete(peer.roomId);
    const state = this.#rooms.get(peer.roomId);
    if (state) {
      for (const peers of state.browserReady.values()) peers.delete(peer.id);
      for (const peers of state.agentReady.values()) peers.delete(peer.id);
      for (const [key, subscription] of state.subscriptions) {
        if (subscription.subscriberPeerId === peer.id || subscription.publisherPeerId === peer.id) {
          state.subscriptions.delete(key);
          state.agentSubscriptions.delete(key);
        }
      }
      for (const key of state.publicationLayers.keys()) {
        if (key.startsWith(`${peer.id}\0`)) state.publicationLayers.delete(key);
      }
      if (state.pending?.peerId === peer.id) state.pending = null;
    }
  }

  removePublisherSource(roomId, publisherPeerId, source) {
    const state = this.#rooms.get(roomId);
    if (!state) return false;
    let changed = false;
    for (const [key, subscription] of state.subscriptions) {
      if (subscription.publisherPeerId === publisherPeerId && subscription.source === source) {
        state.subscriptions.delete(key);
        state.agentSubscriptions.delete(key);
        changed = true;
      }
    }
    for (const [key, publication] of state.publicationLayers) {
      if (key.startsWith(`${publisherPeerId}\0`) && publication.source === source) {
        state.publicationLayers.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  removeRoom(roomId) {
    this.#consents.delete(roomId);
    return this.#rooms.delete(roomId);
  }

  respondToTakeover(peer, response, now = Date.now()) {
    const state = this.#rooms.get(peer.roomId);
    if (!state?.pending || state.pending.requestId !== response.requestId
      || state.pending.peerId !== peer.id || state.pending.expiresAt < now) {
      throw new ProtocolError("agent_takeover_request_expired");
    }
    const agentId = state.pending.agentId;
    state.pending = null;
    if (response.accepted) state.approved.set(agentId, now + this.#leaseMs);
    else state.declined.set(agentId, now + this.#takeoverTtlMs);
    return response.accepted;
  }

  reconcile(roomId, members, membershipEpoch, now = Date.now()) {
    let state = this.#rooms.get(roomId);
    if (!state) {
      state = {
        membershipEpoch,
        routeEpoch: 0,
        primaryId: "",
        standbyIds: [],
        forwarderIds: [],
        publisherAssignments: new Map(),
        subscriberAssignments: new Map(),
        federationLinks: [],
        federationRoutes: [],
        federationReady: new Map(),
        leaseExpiresAt: 0,
        hadPrimary: false,
        pending: null,
        approved: new Map(),
        declined: new Map(),
        browserReady: new Map(),
        agentReady: new Map(),
        subscriptions: new Map(),
        agentSubscriptions: new Map(),
        publicationLayers: new Map(),
        subscriptionRevision: 0,
      };
      this.#rooms.set(roomId, state);
    }
    const memberIds = new Set(members.map((member) => member.id));
    const consents = this.#consents.get(roomId) || new Map();
    for (const peerId of [...consents.keys()]) if (!memberIds.has(peerId)) consents.delete(peerId);
    for (const [id, expiresAt] of state.approved) if (expiresAt < now) state.approved.delete(id);
    for (const [id, expiresAt] of state.declined) if (expiresAt < now) state.declined.delete(id);
    if (state.pending?.expiresAt < now) state.pending = null;

    const candidates = [];
    const byAgent = new Map();
    const roomHasFanoutBenefit = members.length >= this.#minimumParticipants;
    if (!roomHasFanoutBenefit) {
      state.hadPrimary = false;
      state.pending = null;
    }
    for (const consent of roomHasFanoutBenefit ? consents.values() : []) {
      const agent = this.#agents.get(consent.agentId);
      if (!agent || !agent.socket || now - agent.lastSeen > this.#leaseMs
        || agent.definition.ownerPrincipal !== consent.principal
        || members.length > agent.capability.maxPeers) continue;
      const assignedRooms = this.roomsForAgent(consent.agentId);
      if (!assignedRooms.includes(roomId) && assignedRooms.length >= agent.capability.maxRooms) continue;
      const candidate = {
        id: consent.agentId,
        ownerPeerId: consent.peerId,
        creatorOwned: consent.creatorOwned,
        automaticTakeover: consent.automaticTakeover,
        healthy: true,
        draining: agent.draining,
        ...agent.capability,
      };
      const existing = byAgent.get(candidate.id);
      if (!existing || candidate.creatorOwned) byAgent.set(candidate.id, candidate);
    }
    candidates.push(...byAgent.values());
    const currentHealthy = candidates.some((candidate) => candidate.id === state.primaryId);
    const failover = state.hadPrimary && !currentHealthy;
    if (!currentHealthy) state.primaryId = "";
    const approved = new Set([...state.approved.keys()]);
    const plan = planMediaAgents({
      candidates: candidates.filter((candidate) => !state.declined.has(candidate.id)),
      currentPrimaryId: state.primaryId,
      maxStandbys: this.#maxStandbys,
      failover,
      approvedAgentIds: approved,
    });
    let primaryId = plan.primary?.id || "";
    if (plan.takeover) {
      if (!state.pending || state.pending.agentId !== plan.takeover.id) {
        state.pending = {
          requestId: crypto.randomBytes(16).toString("hex"),
          agentId: plan.takeover.id,
          peerId: plan.takeover.ownerPeerId,
          expiresAt: now + this.#takeoverTtlMs,
          creatorPreferred: plan.takeover.creatorOwned,
        };
      }
      if (state.primaryId && currentHealthy) primaryId = state.primaryId;
    } else if (state.pending && state.pending.agentId === primaryId) {
      state.pending = null;
    }
    const standbyIds = plan.standbys.map((candidate) => candidate.id).filter((id) => id !== primaryId);
    const forwarderIds = primaryId
      ? [primaryId, ...(members.length >= this.#shardMinParticipants ? standbyIds : [])]
      : [];
    const publisherAssignments = new Map();
    if (forwarderIds.length > 0) {
      const orderedMembers = [...members].sort((left, right) => left.id.localeCompare(right.id));
      const primaryOwnerPeerId = plan.ranked.find((candidate) => candidate.id === primaryId)?.ownerPeerId || "";
      const primaryOwner = orderedMembers.find((member) => member.id === primaryOwnerPeerId);
      if (primaryOwner) publisherAssignments.set(primaryOwner.id, primaryId);
      let cursor = forwarderIds.length > 1 ? 1 : 0;
      for (const member of orderedMembers) {
        if (publisherAssignments.has(member.id)) continue;
        publisherAssignments.set(member.id, forwarderIds[cursor % forwarderIds.length]);
        cursor += 1;
      }
    }
    const subscriberAssignments = new Map(publisherAssignments);
    const assignmentSignature = [...publisherAssignments].map(([peerId, agentId]) => `${peerId}:${agentId}`).join("\0");
    const previousAssignmentSignature = [...state.publisherAssignments]
      .map(([peerId, agentId]) => `${peerId}:${agentId}`).join("\0");
    const changed = state.membershipEpoch !== membershipEpoch || state.primaryId !== primaryId
      || state.standbyIds.join("\0") !== standbyIds.join("\0")
      || state.forwarderIds.join("\0") !== forwarderIds.join("\0")
      || previousAssignmentSignature !== assignmentSignature;
    state.membershipEpoch = membershipEpoch;
    state.primaryId = primaryId;
    state.standbyIds = standbyIds;
    state.forwarderIds = forwarderIds;
    state.publisherAssignments = publisherAssignments;
    state.subscriberAssignments = subscriberAssignments;
    if (changed || state.routeEpoch === 0) {
      state.routeEpoch += 1;
      state.browserReady.clear();
      state.agentReady.clear();
      state.subscriptions.clear();
      state.agentSubscriptions.clear();
      state.publicationLayers.clear();
      state.federationReady.clear();
    }
    const federation = buildFederationPlan(
      roomId,
      state.routeEpoch,
      forwarderIds,
      publisherAssignments,
      subscriberAssignments,
      members,
    );
    state.federationLinks = federation.links;
    state.federationRoutes = federation.routes;
    state.leaseExpiresAt = now + this.#leaseMs;
    if (primaryId) state.hadPrimary = true;
    return this.snapshot(roomId, members);
  }

  snapshot(roomId, members = []) {
    const state = this.#rooms.get(roomId);
    if (!state) return null;
    const consents = this.#consents.get(roomId) || new Map();
    const candidate = (agentId) => {
      const consent = [...consents.values()].find((value) => value.agentId === agentId);
      return consent ? Object.freeze({
        id: agentId,
        ownerPeerId: consent.peerId,
        creatorPreferred: consent.creatorOwned,
      }) : null;
    };
    const readiness = state.forwarderIds.map((agentId) => {
      const browserReady = state.browserReady.get(agentId) || new Set();
      const agentReady = state.agentReady.get(agentId) || new Set();
      return Object.freeze({
        agentId,
        readyPeerIds: Object.freeze(sorted([...browserReady].filter((peerId) => agentReady.has(peerId)
          && (members.length === 0 || members.some((member) => member.id === peerId))))),
      });
    });
    return Object.freeze({
      version: 3,
      type: "media-agent-state",
      enabled: this.#agents.size > 0,
      membershipEpoch: state.membershipEpoch,
      routeEpoch: state.routeEpoch,
      leaseExpiresAt: state.leaseExpiresAt,
      primary: state.primaryId ? candidate(state.primaryId) : null,
      standbys: Object.freeze(state.standbyIds.map(candidate).filter(Boolean)),
      forwarderIds: Object.freeze([...state.forwarderIds]),
      publisherAssignments: Object.freeze([...state.publisherAssignments]
        .map(([peerId, agentId]) => Object.freeze({ peerId, agentId }))),
      subscriberAssignments: Object.freeze([...state.subscriberAssignments]
        .map(([peerId, agentId]) => Object.freeze({ peerId, agentId }))),
      federationLinks: Object.freeze(state.federationLinks.map((link) => Object.freeze({
        ...link,
        readyAgentIds: Object.freeze(sorted(state.federationReady.get(link.linkId) || [])),
      }))),
      federationRoutes: Object.freeze(state.federationRoutes),
      readiness: Object.freeze(readiness),
    });
  }

  takeoverRequest(roomId) {
    const pending = this.#rooms.get(roomId)?.pending;
    return pending ? Object.freeze({
      version: 1,
      type: "media-agent-takeover-request",
      requestId: pending.requestId,
      agentId: pending.agentId,
      peerId: pending.peerId,
      expiresAt: pending.expiresAt,
      creatorPreferred: pending.creatorPreferred,
    }) : null;
  }

  authorize(roomId, agentId, routeEpoch, peerId = "", now = Date.now()) {
    const state = this.#rooms.get(roomId);
    if (!state || state.routeEpoch !== routeEpoch || state.leaseExpiresAt < now
      || !new Set([state.primaryId, ...state.standbyIds]).has(agentId)) return false;
    return true;
  }

  authorizePrimary(roomId, agentId, routeEpoch, now = Date.now()) {
    const state = this.#rooms.get(roomId);
    return Boolean(state && state.primaryId === agentId && state.routeEpoch === routeEpoch
      && state.leaseExpiresAt >= now);
  }

  authorizePublisher(roomId, agentId, routeEpoch, publisherPeerId, now = Date.now()) {
    const state = this.#rooms.get(roomId);
    return Boolean(state && state.routeEpoch === routeEpoch && state.leaseExpiresAt >= now
      && state.publisherAssignments.get(publisherPeerId) === agentId);
  }

  setPublicationLayerState(
    roomId,
    agentId,
    routeEpoch,
    publisherPeerId,
    publicationId,
    source,
    layer,
    active,
    now = Date.now(),
  ) {
    if (!this.authorizePublisher(roomId, agentId, routeEpoch, publisherPeerId, now)
      || !MEDIA_LAYERS.has(layer)) throw new ProtocolError("stale_agent_publication_layer");
    const state = this.#rooms.get(roomId);
    const key = `${publisherPeerId}\0${publicationId}`;
    let publication = state.publicationLayers.get(key);
    if (publication && publication.source !== source) {
      throw new ProtocolError("stale_agent_publication_layer");
    }
    if (!publication) {
      if (!active) return false;
      publication = { source, layers: new Set() };
      state.publicationLayers.set(key, publication);
    }
    const hadLayer = publication.layers.has(layer);
    if (active) publication.layers.add(layer); else publication.layers.delete(layer);
    if (publication.layers.size === 0) state.publicationLayers.delete(key);
    return hadLayer !== active;
  }

  setSubscriptionIntent(peer, input, publication, now = Date.now()) {
    const state = this.#rooms.get(peer.roomId);
    if (!state || input.roomId !== peer.roomId || input.publisherPeerId === peer.id
      || !publication || state.routeEpoch !== input.routeEpoch || state.leaseExpiresAt < now
      || state.subscriberAssignments.get(peer.id) !== input.agentId || !validSubscriptionLayers(
        publication.source, input.enabled, input.preferredLayer, input.maximumLayer,
      )) {
      throw new ProtocolError("invalid_agent_subscription_intent");
    }
    const key = `${peer.id}\0${input.publisherPeerId}\0${input.publicationId}`;
    state.subscriptionRevision += 1;
    const plan = Object.freeze({
      subscriberPeerId: peer.id,
      publisherPeerId: input.publisherPeerId,
      publicationId: input.publicationId,
      source: publication.source,
      enabled: input.enabled,
      preferredLayer: input.preferredLayer,
      maximumLayer: input.maximumLayer,
      revision: state.subscriptionRevision,
      agentId: input.agentId,
    });
    state.subscriptions.set(key, plan);
    // A new intent supersedes the previously applied forwarding state. The
    // publisher must keep its direct fallback until the agent applies this
    // exact plan and the subscriber acknowledges the replacement track.
    state.agentSubscriptions.delete(key);
    return plan;
  }

  subscriptionPlan(roomId, agentId, routeEpoch, subscriberPeerId, publisherPeerId, publicationId, now = Date.now()) {
    const state = this.#rooms.get(roomId);
    if (!state || state.routeEpoch !== routeEpoch || state.leaseExpiresAt < now) return null;
    const plan = state.subscriptions.get(`${subscriberPeerId}\0${publisherPeerId}\0${publicationId}`);
    return plan?.agentId === agentId ? plan : null;
  }

  setAgentSubscriptionState(
    roomId,
    agentId,
    routeEpoch,
    subscriberPeerId,
    publisherPeerId,
    publicationId,
    revision,
    selectedLayer,
    ready,
    now = Date.now(),
  ) {
    const plan = this.subscriptionPlan(
      roomId, agentId, routeEpoch, subscriberPeerId, publisherPeerId, publicationId, now,
    );
    if (!plan || plan.revision !== revision
      || (ready && (!plan.enabled || !validSelectedLayer(plan, selectedLayer)))) {
      throw new ProtocolError("stale_agent_subscription");
    }
    const state = this.#rooms.get(roomId);
    const key = `${subscriberPeerId}\0${publisherPeerId}\0${publicationId}`;
    const applied = Object.freeze({
      agentId,
      routeEpoch,
      subscriberPeerId,
      publisherPeerId,
      publicationId,
      selectedLayer,
      revision: plan.revision,
      ready,
    });
    if (ready) state.agentSubscriptions.set(key, applied);
    else state.agentSubscriptions.delete(key);
    return applied;
  }

  acknowledgeSubscription(peer, input, now = Date.now()) {
    const state = this.#rooms.get(peer.roomId);
    if (!state || input.roomId !== peer.roomId || input.routeEpoch !== state.routeEpoch) {
      throw new ProtocolError("stale_agent_subscription");
    }
    const key = `${peer.id}\0${input.publisherPeerId}\0${input.publicationId}`;
    const applied = state.agentSubscriptions.get(key);
    if (input.ready && (!applied || !applied.ready || applied.agentId !== input.agentId
      || applied.revision !== input.revision)) {
      throw new ProtocolError("stale_agent_subscription");
    }
    const plan = state.subscriptions.get(key);
    if (!plan || plan.agentId !== input.agentId || plan.publisherPeerId === peer.id
      || plan.revision !== input.revision || state.leaseExpiresAt < now) {
      throw new ProtocolError("stale_agent_subscription");
    }
    return applied || Object.freeze({
      agentId: input.agentId,
      routeEpoch: input.routeEpoch,
      subscriberPeerId: peer.id,
      publisherPeerId: input.publisherPeerId,
      publicationId: input.publicationId,
      selectedLayer: plan.preferredLayer,
      revision: plan.revision,
      ready: false,
    });
  }

  setBrowserPeerState(roomId, agentId, routeEpoch, peerId, connected, now = Date.now()) {
    if (!this.authorizePeerAgent(roomId, agentId, routeEpoch, peerId, now)) {
      throw new ProtocolError("stale_agent_route");
    }
    const state = this.#rooms.get(roomId);
    let peers = state.browserReady.get(agentId);
    if (!peers) {
      peers = new Set();
      state.browserReady.set(agentId, peers);
    }
    if (connected) peers.add(peerId); else peers.delete(peerId);
  }

  setAgentPeerState(socket, roomId, peerId, routeEpoch, connected, now = Date.now()) {
    const agent = this.#bySocket.get(socket);
    if (!agent || !this.authorizePeerAgent(roomId, agent.definition.id, routeEpoch, peerId, now)) {
      throw new ProtocolError("stale_agent_route");
    }
    const state = this.#rooms.get(roomId);
    let peers = state.agentReady.get(agent.definition.id);
    if (!peers) {
      peers = new Set();
      state.agentReady.set(agent.definition.id, peers);
    }
    if (connected) peers.add(peerId); else peers.delete(peerId);
  }

  authorizePeerAgent(roomId, agentId, routeEpoch, peerId, now = Date.now()) {
    const state = this.#rooms.get(roomId);
    return Boolean(state && state.routeEpoch === routeEpoch && state.leaseExpiresAt >= now
      && (state.publisherAssignments.get(peerId) === agentId
        || state.subscriberAssignments.get(peerId) === agentId));
  }

  assignedSubscriberAgent(roomId, peerId) {
    return this.#rooms.get(roomId)?.subscriberAssignments.get(peerId) || "";
  }

  federationLink(roomId, routeEpoch, linkId, firstAgentId, secondAgentId, now = Date.now()) {
    const state = this.#rooms.get(roomId);
    if (!state || state.routeEpoch !== routeEpoch || state.leaseExpiresAt < now) return null;
    const link = state.federationLinks.find((candidate) => candidate.linkId === linkId);
    if (!link || !new Set([link.leftAgentId, link.rightAgentId]).has(firstAgentId)
      || !new Set([link.leftAgentId, link.rightAgentId]).has(secondAgentId)
      || firstAgentId === secondAgentId) return null;
    return link;
  }

  setFederationState(socket, roomId, routeEpoch, linkId, remoteAgentId, connected, now = Date.now()) {
    const agent = this.#bySocket.get(socket);
    const link = agent && this.federationLink(
      roomId, routeEpoch, linkId, agent.definition.id, remoteAgentId, now,
    );
    if (!agent || !link) throw new ProtocolError("stale_federation_link");
    const state = this.#rooms.get(roomId);
    let ready = state.federationReady.get(linkId);
    if (!ready) {
      ready = new Set();
      state.federationReady.set(linkId, ready);
    }
    if (connected) ready.add(agent.definition.id); else ready.delete(agent.definition.id);
    return ready.size === 2;
  }

  roomsForAgent(agentId) {
    const result = [];
    for (const [roomId, state] of this.#rooms) {
      if (state.primaryId === agentId || state.standbyIds.includes(agentId)) result.push(roomId);
    }
    return result.sort();
  }

  roomsAffectedByAgent(agentId) {
    const result = new Set(this.roomsForAgent(agentId));
    for (const [roomId, consents] of this.#consents) {
      if ([...consents.values()].some((consent) => consent.agentId === agentId)) result.add(roomId);
    }
    return [...result].sort();
  }

  roomLeases(agentId, roomMembers, iceServersForAgent) {
    const result = [];
    for (const roomId of this.roomsForAgent(agentId)) {
      const state = this.#rooms.get(roomId);
      const demands = federationDemands(state);
      result.push(Object.freeze({
        version: 3,
        type: "agent-lease",
        roomId,
        role: state.primaryId === agentId ? "primary" : "standby",
        membershipEpoch: state.membershipEpoch,
        routeEpoch: state.routeEpoch,
        leaseExpiresAt: state.leaseExpiresAt,
        peers: Object.freeze(roomMembers(roomId).map((peer) => Object.freeze({
          id: peer.id,
          connect: state.publisherAssignments.get(peer.id) === agentId
            || state.subscriberAssignments.get(peer.id) === agentId,
          publish: state.publisherAssignments.get(peer.id) === agentId,
          subscribe: state.subscriberAssignments.get(peer.id) === agentId,
        }))),
        subscriptions: Object.freeze([...state.subscriptions.values()]
          .filter((subscription) => subscription.agentId === agentId)
          .map(({ agentId: _agentId, ...subscription }) => Object.freeze(subscription))),
        federationLinks: Object.freeze(state.federationLinks.filter((link) => (
          link.leftAgentId === agentId || link.rightAgentId === agentId
        ))),
        federationRoutes: Object.freeze(state.federationRoutes.filter((route) => (
          route.sourceAgentId === agentId || route.edges.some((edge) => (
            edge.fromAgentId === agentId || edge.toAgentId === agentId
          ))
        ))),
        federationDemands: Object.freeze(demands.filter((demand) => (
          demand.fromAgentId === agentId || demand.toAgentId === agentId
        ))),
        iceServers: Object.freeze(iceServersForAgent(agentId)),
      }));
    }
    return result;
  }

  configuredForPrincipal(principal) {
    return [...this.#agents.values()]
      .filter((agent) => agent.definition.ownerPrincipal === principal)
      .map((agent) => Object.freeze({ id: agent.definition.id, online: Boolean(agent.socket) }));
  }

  socketForAgent(agentId) {
    return this.#agents.get(agentId)?.socket || null;
  }

  connectedAgentIds() {
    return [...this.#agents.values()]
      .filter((agent) => agent.socket)
      .map((agent) => agent.definition.id)
      .sort();
  }

  get configured() {
    return this.#agents.size > 0;
  }

  get enrollmentEnabled() {
    return Boolean(this.#enrollmentStore);
  }
}
