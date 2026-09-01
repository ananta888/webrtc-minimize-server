import crypto from "node:crypto";

import { mediaAgentAuthProof } from "./media-agent-protocol.js";
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

function proofMatches(expected, actual) {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export class MediaAgentRegistry {
  #agents = new Map();
  #bySocket = new WeakMap();
  #challenges = new WeakMap();
  #consents = new Map();
  #rooms = new Map();
  #leaseMs;
  #maxStandbys;
  #shardMinParticipants;
  #takeoverTtlMs;

  constructor({
    definitions = [],
    leaseMs = 30_000,
    maxStandbys = 2,
    shardMinParticipants = 6,
    takeoverTtlMs = 20_000,
  } = {}) {
    this.#leaseMs = leaseMs;
    this.#maxStandbys = maxStandbys;
    this.#shardMinParticipants = shardMinParticipants;
    this.#takeoverTtlMs = takeoverTtlMs;
    for (const definition of definitions) {
      this.#agents.set(definition.id, {
        definition,
        socket: null,
        authenticatedAt: 0,
        lastSeen: 0,
        messages: [],
        capability: { ...DEFAULT_CAPABILITY },
        draining: false,
      });
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
    const expected = mediaAgentAuthProof(
      agent.definition.sharedSecret,
      message.agentId,
      challenge.nonce,
      message.timestamp,
    );
    if (!proofMatches(expected, message.proof)) throw new ProtocolError("agent_authentication_failed");
    const replacedSocket = agent.socket && agent.socket !== socket ? agent.socket : null;
    if (replacedSocket) this.#bySocket.delete(replacedSocket);
    agent.socket = socket;
    agent.authenticatedAt = now;
    agent.lastSeen = now;
    agent.messages = [];
    agent.draining = false;
    this.#bySocket.set(socket, agent);
    return Object.freeze({ id: agent.definition.id, replacedSocket });
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
      if (state.pending?.peerId === peer.id) state.pending = null;
    }
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
        leaseExpiresAt: 0,
        hadPrimary: false,
        pending: null,
        approved: new Map(),
        declined: new Map(),
        browserReady: new Map(),
        agentReady: new Map(),
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
    for (const consent of consents.values()) {
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
    if (changed || state.routeEpoch === 0) {
      state.routeEpoch += 1;
      state.browserReady.clear();
      state.agentReady.clear();
    }
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
      version: 2,
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

  setBrowserPeerState(roomId, agentId, routeEpoch, peerId, connected, now = Date.now()) {
    if (!this.authorize(roomId, agentId, routeEpoch, peerId, now)) throw new ProtocolError("stale_agent_route");
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
    if (!agent || !this.authorize(roomId, agent.definition.id, routeEpoch, peerId, now)) {
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
      result.push(Object.freeze({
        version: 2,
        type: "agent-lease",
        roomId,
        role: state.primaryId === agentId ? "primary" : "standby",
        membershipEpoch: state.membershipEpoch,
        routeEpoch: state.routeEpoch,
        leaseExpiresAt: state.leaseExpiresAt,
        peers: Object.freeze(roomMembers(roomId).map((peer) => Object.freeze({
          id: peer.id,
          publish: state.publisherAssignments.get(peer.id) === agentId,
        }))),
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
}
