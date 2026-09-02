import { Injectable, signal } from "@angular/core";

import { IcePathClass } from "./ice-policy";
import { LinkClass, MediaSource } from "./media-optimization-policy";
import { MeshTelemetryMessage } from "./peer-control-protocol";

export const MESH_TELEMETRY_INTERVAL_MS = 6_000;
export const MESH_TELEMETRY_TTL_MS = 15_000;
export const MESH_TELEMETRY_MIN_RECEIVE_INTERVAL_MS = 1_000;
export const MAX_MESH_BITRATE_BPS = 1_000_000_000;

export type MeshAnalysisTargetKind = "peer" | "media-agent";
export type MeshAnalysisNodeKind = "participant" | "media-agent";
export type MeshAnalysisEdgeKind = "direct" | "trusted-relay" | "media-agent" | "agent-federation";
export type MeshMeasurementSource = "local" | "peer-reported" | "unavailable";

export interface MeshTrafficCounters {
  readonly sampledAt: number;
  readonly outgoingBytes: number;
  readonly incomingBytes: number;
  readonly audioOutgoingBytes: number;
  readonly audioIncomingBytes: number;
  readonly videoOutgoingBytes: number;
  readonly videoIncomingBytes: number;
  readonly screenOutgoingBytes: number;
  readonly screenIncomingBytes: number;
  readonly dataOutgoingBytes: number;
  readonly dataIncomingBytes: number;
}

export interface MeshTrafficRate {
  readonly outgoingBps: number;
  readonly incomingBps: number;
  readonly audioOutgoingBps: number;
  readonly audioIncomingBps: number;
  readonly videoOutgoingBps: number;
  readonly videoIncomingBps: number;
  readonly screenOutgoingBps: number;
  readonly screenIncomingBps: number;
  readonly dataOutgoingBps: number;
  readonly dataIncomingBps: number;
  readonly sampledAt: number;
}

export interface MeshAnalysisParticipantInput {
  readonly id: string;
  readonly name: string;
  readonly own: boolean;
  readonly connectionState: RTCPeerConnectionState | "local";
  readonly icePath: IcePathClass;
  readonly linkClass: LinkClass;
  readonly publications: readonly MediaSource[];
}

export interface MeshAnalysisAgentInput {
  readonly id: string;
  readonly ownerPeerId: string;
  readonly role: "primary" | "standby";
  readonly connected: boolean;
  readonly readyPeerIds: readonly string[];
}

export interface MeshAnalysisContext {
  readonly roomId: string;
  readonly topologyMode: "adaptive_mesh" | "trusted_peer_relay";
  readonly membershipEpoch: number;
  readonly routeEpoch: number;
  readonly mediaAgentRouteEpoch: number;
  readonly topologyEpoch: number;
  readonly participants: readonly MeshAnalysisParticipantInput[];
  readonly trustedRelayEdges: readonly Readonly<{
    rootPeerId: string;
    parentPeerId: string;
    childPeerId: string;
  }>[];
  readonly agents: readonly MeshAnalysisAgentInput[];
  readonly publisherAssignments: readonly Readonly<{ peerId: string; agentId: string }>[];
  readonly subscriberAssignments: readonly Readonly<{ peerId: string; agentId: string }>[];
  readonly federationLinks: readonly Readonly<{
    leftAgentId: string;
    rightAgentId: string;
    ready: boolean;
  }>[];
}

export interface MeshAnalysisNode {
  readonly id: string;
  readonly targetId: string;
  readonly kind: MeshAnalysisNodeKind;
  readonly label: string;
  readonly own: boolean;
  readonly role: "participant" | "primary" | "standby";
  readonly ownerPeerId: string;
  readonly connectionState: string;
  readonly icePath: IcePathClass | "not-applicable";
  readonly linkClass: LinkClass | "not-applicable";
  readonly publications: readonly MediaSource[];
  readonly readyPeerCount: number;
  readonly outgoingBps: number | null;
  readonly incomingBps: number | null;
  readonly audioOutgoingBps: number | null;
  readonly audioIncomingBps: number | null;
  readonly videoOutgoingBps: number | null;
  readonly videoIncomingBps: number | null;
  readonly screenOutgoingBps: number | null;
  readonly screenIncomingBps: number | null;
  readonly dataOutgoingBps: number | null;
  readonly dataIncomingBps: number | null;
}

export interface MeshAnalysisEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: MeshAnalysisEdgeKind;
  readonly roles: readonly string[];
  readonly routeRoots: readonly string[];
  readonly ready: boolean;
  readonly fromTo: MeshAnalysisDirection | null;
  readonly toFrom: MeshAnalysisDirection | null;
  readonly totalBps: number | null;
  readonly measurementSource: MeshMeasurementSource;
  readonly measuredAt: number | null;
}

export interface MeshAnalysisDirection {
  readonly totalBps: number;
  readonly audioBps: number;
  readonly videoBps: number;
  readonly screenBps: number;
  readonly dataBps: number;
}

export interface MeshAnalysisGraph {
  readonly roomId: string;
  readonly topologyMode: "adaptive_mesh" | "trusted_peer_relay";
  readonly membershipEpoch: number;
  readonly routeEpoch: number;
  readonly mediaAgentRouteEpoch: number;
  readonly topologyEpoch: number;
  readonly nodes: readonly MeshAnalysisNode[];
  readonly edges: readonly MeshAnalysisEdge[];
  readonly updatedAt: number;
}

interface TrafficObservation extends MeshTrafficRate {
  readonly source: Exclude<MeshMeasurementSource, "unavailable">;
  readonly receivedAt: number;
}

interface DirectionObservation extends MeshAnalysisDirection {
  readonly sampledAt: number;
  readonly source: Exclude<MeshMeasurementSource, "unavailable">;
  readonly reporterId: string;
}

const EMPTY_GRAPH: MeshAnalysisGraph = Object.freeze({
  roomId: "",
  topologyMode: "adaptive_mesh",
  membershipEpoch: 0,
  routeEpoch: 0,
  mediaAgentRouteEpoch: 0,
  topologyEpoch: 0,
  nodes: Object.freeze([]),
  edges: Object.freeze([]),
  updatedAt: 0,
});

function boundedRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_MESH_BITRATE_BPS, Math.round(value)));
}

function boundedBreakdown(total: number, values: readonly number[]): readonly number[] {
  let remaining = boundedRate(total);
  return values.map((value) => {
    const next = Math.min(remaining, boundedRate(value));
    remaining -= next;
    return next;
  });
}

function deltaRate(current: number, previous: number, elapsedMs: number): number {
  if (current < previous || elapsedMs <= 0) return 0;
  return boundedRate(((current - previous) * 8_000) / elapsedMs);
}

function targetKey(kind: MeshAnalysisTargetKind, id: string): string {
  return `${kind}:${id}`;
}

function graphNodeId(kind: MeshAnalysisTargetKind, id: string): string {
  return kind === "peer" ? `peer:${id}` : `agent:${id}`;
}

function canonicalPair(left: string, right: string): readonly [string, string] {
  return left.localeCompare(right) <= 0 ? [left, right] : [right, left];
}

export class MeshTrafficRateTracker {
  private readonly counters = new Map<string, MeshTrafficCounters>();

  sample(key: string, counters: MeshTrafficCounters): MeshTrafficRate | null {
    const previous = this.counters.get(key);
    this.counters.set(key, counters);
    if (!previous) return null;
    const elapsedMs = counters.sampledAt - previous.sampledAt;
    if (elapsedMs < 250 || elapsedMs > MESH_TELEMETRY_TTL_MS
      || counters.outgoingBytes < previous.outgoingBytes
      || counters.incomingBytes < previous.incomingBytes) return null;
    return Object.freeze({
      outgoingBps: deltaRate(counters.outgoingBytes, previous.outgoingBytes, elapsedMs),
      incomingBps: deltaRate(counters.incomingBytes, previous.incomingBytes, elapsedMs),
      audioOutgoingBps: deltaRate(counters.audioOutgoingBytes, previous.audioOutgoingBytes, elapsedMs),
      audioIncomingBps: deltaRate(counters.audioIncomingBytes, previous.audioIncomingBytes, elapsedMs),
      videoOutgoingBps: deltaRate(counters.videoOutgoingBytes, previous.videoOutgoingBytes, elapsedMs),
      videoIncomingBps: deltaRate(counters.videoIncomingBytes, previous.videoIncomingBytes, elapsedMs),
      screenOutgoingBps: deltaRate(counters.screenOutgoingBytes, previous.screenOutgoingBytes, elapsedMs),
      screenIncomingBps: deltaRate(counters.screenIncomingBytes, previous.screenIncomingBytes, elapsedMs),
      dataOutgoingBps: deltaRate(counters.dataOutgoingBytes, previous.dataOutgoingBytes, elapsedMs),
      dataIncomingBps: deltaRate(counters.dataIncomingBytes, previous.dataIncomingBytes, elapsedMs),
      sampledAt: counters.sampledAt,
    });
  }

  delete(key: string): void {
    this.counters.delete(key);
  }

  clear(): void {
    this.counters.clear();
  }
}

@Injectable({ providedIn: "root" })
export class MeshAnalysisService {
  readonly graph = signal<MeshAnalysisGraph>(EMPTY_GRAPH);
  readonly viewing = signal(false);
  private readonly rateTracker = new MeshTrafficRateTracker();
  private readonly observations = new Map<string, Map<string, TrafficObservation>>();
  private readonly lastTelemetrySequence = new Map<string, number>();
  private readonly lastTelemetryReceivedAt = new Map<string, number>();
  private context: MeshAnalysisContext | null = null;
  private ownPeerId = "";

  initialize(roomId: string, ownPeerId: string): void {
    this.reset();
    this.ownPeerId = ownPeerId;
    this.context = {
      roomId,
      topologyMode: "adaptive_mesh",
      membershipEpoch: 0,
      routeEpoch: 0,
      mediaAgentRouteEpoch: 0,
      topologyEpoch: 0,
      participants: [],
      trustedRelayEdges: [],
      agents: [],
      publisherAssignments: [],
      subscriberAssignments: [],
      federationLinks: [],
    };
  }

  setViewing(active: boolean): void {
    this.viewing.set(active);
  }

  updateContext(context: MeshAnalysisContext, now = Date.now()): boolean {
    const participantIds = new Set(context.participants.map(({ id }) => id));
    const agentIds = new Set(context.agents.map(({ id }) => id));
    if (!context.roomId || context.roomId !== this.context?.roomId || context.participants.length > 20
      || participantIds.size !== context.participants.length || !participantIds.has(this.ownPeerId)
      || context.agents.length > 3 || agentIds.size !== context.agents.length
      || context.agents.some(({ ownerPeerId, readyPeerIds }) => (
        !participantIds.has(ownerPeerId) || readyPeerIds.length > 20
        || new Set(readyPeerIds).size !== readyPeerIds.length
        || readyPeerIds.some((peerId) => !participantIds.has(peerId))
      ))
      || context.trustedRelayEdges.some(({ rootPeerId, parentPeerId, childPeerId }) => (
        !participantIds.has(rootPeerId) || !participantIds.has(parentPeerId) || !participantIds.has(childPeerId)
      ))
      || [...context.publisherAssignments, ...context.subscriberAssignments].some(({ peerId, agentId }) => (
        !participantIds.has(peerId) || !agentIds.has(agentId)
      ))
      || context.federationLinks.some(({ leftAgentId, rightAgentId }) => (
        leftAgentId === rightAgentId || !agentIds.has(leftAgentId) || !agentIds.has(rightAgentId)
      ))) return false;
    this.context = Object.freeze({
      ...context,
      participants: Object.freeze([...context.participants]),
      trustedRelayEdges: Object.freeze([...context.trustedRelayEdges]),
      agents: Object.freeze(context.agents.map((agent) => Object.freeze({
        ...agent,
        readyPeerIds: Object.freeze([...agent.readyPeerIds]),
      }))),
      publisherAssignments: Object.freeze([...context.publisherAssignments]),
      subscriberAssignments: Object.freeze([...context.subscriberAssignments]),
      federationLinks: Object.freeze([...context.federationLinks]),
    });
    this.pruneUnauthorized(participantIds, agentIds);
    this.rebuild(now);
    return true;
  }

  sampleLocal(
    targetKind: MeshAnalysisTargetKind,
    targetId: string,
    counters: MeshTrafficCounters,
    now = counters.sampledAt,
  ): MeshTrafficRate | null {
    if (!this.authorizedTarget(this.ownPeerId, targetKind, targetId)) return null;
    const key = targetKey(targetKind, targetId);
    const rate = this.rateTracker.sample(key, counters);
    const own = this.observations.get(this.ownPeerId) || new Map<string, TrafficObservation>();
    if (rate) {
      own.set(key, Object.freeze({ ...rate, source: "local", receivedAt: now }));
    } else {
      own.delete(key);
    }
    this.observations.set(this.ownPeerId, own);
    this.rebuild(now);
    return rate;
  }

  localTelemetryLinks(now = Date.now()): MeshTelemetryMessage["links"] {
    const values = this.observations.get(this.ownPeerId);
    if (!values) return Object.freeze([]);
    const links: MeshTelemetryMessage["links"][number][] = [];
    for (const [key, observation] of values) {
      if (now - observation.receivedAt > MESH_TELEMETRY_TTL_MS) continue;
      const separator = key.indexOf(":");
      const kind = key.slice(0, separator) as MeshAnalysisTargetKind;
      const id = key.slice(separator + 1);
      if (!this.authorizedTarget(this.ownPeerId, kind, id)) continue;
      const outgoingBps = boundedRate(observation.outgoingBps);
      const incomingBps = boundedRate(observation.incomingBps);
      const [audioOutgoingBps, videoOutgoingBps, screenOutgoingBps, dataOutgoingBps] = boundedBreakdown(
        outgoingBps,
        [observation.audioOutgoingBps, observation.videoOutgoingBps, observation.screenOutgoingBps, observation.dataOutgoingBps],
      );
      const [audioIncomingBps, videoIncomingBps, screenIncomingBps, dataIncomingBps] = boundedBreakdown(
        incomingBps,
        [observation.audioIncomingBps, observation.videoIncomingBps, observation.screenIncomingBps, observation.dataIncomingBps],
      );
      links.push(Object.freeze({
        targetKind: kind,
        targetId: id,
        rates: Object.freeze([
          outgoingBps,
          incomingBps,
          audioOutgoingBps,
          audioIncomingBps,
          videoOutgoingBps,
          videoIncomingBps,
          screenOutgoingBps,
          screenIncomingBps,
          dataOutgoingBps,
          dataIncomingBps,
        ]) as MeshTelemetryMessage["links"][number]["rates"],
      }));
    }
    return Object.freeze(links.sort((left, right) => (
      `${left.targetKind}:${left.targetId}`.localeCompare(`${right.targetKind}:${right.targetId}`)
    )));
  }

  acceptPeerTelemetry(reporterPeerId: string, message: MeshTelemetryMessage, now = Date.now()): boolean {
    if (!this.context || reporterPeerId === this.ownPeerId
      || !this.context.participants.some(({ id }) => id === reporterPeerId)
      || message.sequence <= (this.lastTelemetrySequence.get(reporterPeerId) ?? -1)
      || now - (this.lastTelemetryReceivedAt.get(reporterPeerId) ?? -Infinity)
        < MESH_TELEMETRY_MIN_RECEIVE_INTERVAL_MS
      || message.links.some(({ targetKind, targetId }) => (
        !this.authorizedTarget(reporterPeerId, targetKind, targetId)
      ))) return false;
    const next = new Map<string, TrafficObservation>();
    for (const link of message.links) {
      const [
        outgoingBps, incomingBps,
        audioOutgoingBps, audioIncomingBps,
        videoOutgoingBps, videoIncomingBps,
        screenOutgoingBps, screenIncomingBps,
        dataOutgoingBps, dataIncomingBps,
      ] = link.rates;
      next.set(targetKey(link.targetKind, link.targetId), Object.freeze({
        outgoingBps,
        incomingBps,
        audioOutgoingBps,
        audioIncomingBps,
        videoOutgoingBps,
        videoIncomingBps,
        screenOutgoingBps,
        screenIncomingBps,
        dataOutgoingBps,
        dataIncomingBps,
        sampledAt: now,
        receivedAt: now,
        source: "peer-reported",
      }));
    }
    this.observations.set(reporterPeerId, next);
    this.lastTelemetrySequence.set(reporterPeerId, message.sequence);
    this.lastTelemetryReceivedAt.set(reporterPeerId, now);
    this.rebuild(now);
    return true;
  }

  expire(now = Date.now()): void {
    let changed = false;
    for (const [reporterId, values] of this.observations) {
      for (const [key, observation] of values) {
        if (now - observation.receivedAt <= MESH_TELEMETRY_TTL_MS) continue;
        values.delete(key);
        changed = true;
      }
      if (values.size === 0 && reporterId !== this.ownPeerId) this.observations.delete(reporterId);
    }
    if (changed || this.graph().updatedAt !== now) this.rebuild(now);
  }

  removeTarget(kind: MeshAnalysisTargetKind, id: string, now = Date.now()): void {
    const key = targetKey(kind, id);
    this.rateTracker.delete(key);
    this.observations.get(this.ownPeerId)?.delete(key);
    if (kind === "peer") {
      this.observations.delete(id);
      this.lastTelemetrySequence.delete(id);
      this.lastTelemetryReceivedAt.delete(id);
    }
    for (const values of this.observations.values()) values.delete(key);
    this.rebuild(now);
  }

  reset(): void {
    this.rateTracker.clear();
    this.observations.clear();
    this.lastTelemetrySequence.clear();
    this.lastTelemetryReceivedAt.clear();
    this.context = null;
    this.ownPeerId = "";
    this.graph.set(EMPTY_GRAPH);
  }

  private authorizedTarget(reporterPeerId: string, kind: MeshAnalysisTargetKind, id: string): boolean {
    if (!this.context) return false;
    if (kind === "peer") {
      return id !== reporterPeerId && this.context.participants.some((participant) => participant.id === id);
    }
    if (!this.context.agents.some((agent) => agent.id === id)) return false;
    return [...this.context.publisherAssignments, ...this.context.subscriberAssignments]
      .some((assignment) => assignment.peerId === reporterPeerId && assignment.agentId === id);
  }

  private pruneUnauthorized(participantIds: ReadonlySet<string>, agentIds: ReadonlySet<string>): void {
    for (const [reporterId, values] of this.observations) {
      if (!participantIds.has(reporterId)) {
        this.observations.delete(reporterId);
        this.lastTelemetrySequence.delete(reporterId);
        this.lastTelemetryReceivedAt.delete(reporterId);
        continue;
      }
      for (const key of values.keys()) {
        const separator = key.indexOf(":");
        const kind = key.slice(0, separator) as MeshAnalysisTargetKind;
        const id = key.slice(separator + 1);
        if ((kind === "peer" && !participantIds.has(id)) || (kind === "media-agent" && !agentIds.has(id))
          || !this.authorizedTarget(reporterId, kind, id)) values.delete(key);
      }
    }
  }

  private directionObservation(
    fromKind: MeshAnalysisTargetKind,
    fromId: string,
    toKind: MeshAnalysisTargetKind,
    toId: string,
    now: number,
  ): DirectionObservation | null {
    const candidates: DirectionObservation[] = [];
    if (fromKind === "peer") {
      const outgoing = this.observations.get(fromId)?.get(targetKey(toKind, toId));
      if (outgoing && now - outgoing.receivedAt <= MESH_TELEMETRY_TTL_MS) candidates.push({
        totalBps: outgoing.outgoingBps,
        audioBps: outgoing.audioOutgoingBps,
        videoBps: outgoing.videoOutgoingBps,
        screenBps: outgoing.screenOutgoingBps,
        dataBps: outgoing.dataOutgoingBps,
        sampledAt: outgoing.sampledAt,
        source: outgoing.source,
        reporterId: fromId,
      });
    }
    if (toKind === "peer") {
      const incoming = this.observations.get(toId)?.get(targetKey(fromKind, fromId));
      if (incoming && now - incoming.receivedAt <= MESH_TELEMETRY_TTL_MS) candidates.push({
        totalBps: incoming.incomingBps,
        audioBps: incoming.audioIncomingBps,
        videoBps: incoming.videoIncomingBps,
        screenBps: incoming.screenIncomingBps,
        dataBps: incoming.dataIncomingBps,
        sampledAt: incoming.sampledAt,
        source: incoming.source,
        reporterId: toId,
      });
    }
    return candidates.sort((left, right) => {
      const localDifference = Number(right.reporterId === this.ownPeerId) - Number(left.reporterId === this.ownPeerId);
      if (localDifference !== 0) return localDifference;
      const senderDifference = Number(right.reporterId === fromId) - Number(left.reporterId === fromId);
      return senderDifference || right.sampledAt - left.sampledAt;
    })[0] || null;
  }

  private rebuild(now: number): void {
    const context = this.context;
    if (!context) {
      this.graph.set(EMPTY_GRAPH);
      return;
    }
    const participants = [...context.participants].sort((left, right) => left.id.localeCompare(right.id));
    const agents = [...context.agents].sort((left, right) => left.id.localeCompare(right.id));
    const trustedPairs = new Map<string, Set<string>>();
    for (const edge of context.trustedRelayEdges) {
      const [left, right] = canonicalPair(edge.parentPeerId, edge.childPeerId);
      const key = `${left}\0${right}`;
      const roots = trustedPairs.get(key) || new Set<string>();
      roots.add(edge.rootPeerId);
      trustedPairs.set(key, roots);
    }
    const edges: MeshAnalysisEdge[] = [];
    for (let leftIndex = 0; leftIndex < participants.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < participants.length; rightIndex += 1) {
        const left = participants[leftIndex];
        const right = participants[rightIndex];
        const roots = [...(trustedPairs.get(`${left.id}\0${right.id}`) || [])].sort();
        edges.push(this.makeEdge({
          id: `peer:${left.id}:${right.id}`,
          fromKind: "peer",
          fromId: left.id,
          toKind: "peer",
          toId: right.id,
          kind: roots.length > 0 ? "trusted-relay" : "direct",
          roles: roots.length > 0 ? ["autorisierte Relay-Kante", "Audio/Control-PeerConnection"] : ["direkte PeerConnection"],
          routeRoots: roots,
          ready: left.own
            ? right.connectionState === "connected"
            : right.own ? left.connectionState === "connected" : false,
        }, now));
      }
    }
    const agentRoles = new Map<string, Set<string>>();
    for (const assignment of context.publisherAssignments) {
      const key = `${assignment.peerId}\0${assignment.agentId}`;
      const roles = agentRoles.get(key) || new Set<string>();
      roles.add("Publisher → Ingress");
      agentRoles.set(key, roles);
    }
    for (const assignment of context.subscriberAssignments) {
      const key = `${assignment.peerId}\0${assignment.agentId}`;
      const roles = agentRoles.get(key) || new Set<string>();
      roles.add("Egress → Empfänger");
      agentRoles.set(key, roles);
    }
    for (const [key, roles] of [...agentRoles].sort(([left], [right]) => left.localeCompare(right))) {
      const [peerId, agentId] = key.split("\0");
      const agent = agents.find(({ id }) => id === agentId);
      edges.push(this.makeEdge({
        id: `agent-link:${peerId}:${agentId}`,
        fromKind: "peer",
        fromId: peerId,
        toKind: "media-agent",
        toId: agentId,
        kind: "media-agent",
        roles: [...roles].sort(),
        routeRoots: [],
        ready: agent?.connected === true || agent?.readyPeerIds.includes(peerId) === true,
      }, now));
    }
    for (const link of [...context.federationLinks].sort((left, right) => (
      `${left.leftAgentId}:${left.rightAgentId}`.localeCompare(`${right.leftAgentId}:${right.rightAgentId}`)
    ))) {
      const [left, right] = canonicalPair(link.leftAgentId, link.rightAgentId);
      edges.push(this.makeEdge({
        id: `federation:${left}:${right}`,
        fromKind: "media-agent",
        fromId: left,
        toKind: "media-agent",
        toId: right,
        kind: "agent-federation",
        roles: ["autorisierte Agent-Föderation"],
        routeRoots: [],
        ready: link.ready,
      }, now));
    }
    interface NodeTraffic {
      outgoing: MeshAnalysisDirection;
      incoming: MeshAnalysisDirection;
      outgoingKnown: boolean;
      incomingKnown: boolean;
    }
    const emptyDirection = (): MeshAnalysisDirection => ({
      totalBps: 0,
      audioBps: 0,
      videoBps: 0,
      screenBps: 0,
      dataBps: 0,
    });
    const emptyTraffic = (): NodeTraffic => ({
      outgoing: emptyDirection(),
      incoming: emptyDirection(),
      outgoingKnown: false,
      incomingKnown: false,
    });
    const addDirection = (target: MeshAnalysisDirection, value: MeshAnalysisDirection): void => {
      (Object.keys(target) as Array<keyof MeshAnalysisDirection>).forEach((key) => {
        (target as Record<keyof MeshAnalysisDirection, number>)[key] += value[key];
      });
    };
    const nodeTraffic = new Map<string, NodeTraffic>();
    for (const edge of edges) {
      const from = nodeTraffic.get(edge.from) || emptyTraffic();
      const to = nodeTraffic.get(edge.to) || emptyTraffic();
      if (edge.fromTo) {
        addDirection(from.outgoing, edge.fromTo);
        from.outgoingKnown = true;
        addDirection(to.incoming, edge.fromTo);
        to.incomingKnown = true;
      }
      if (edge.toFrom) {
        addDirection(to.outgoing, edge.toFrom);
        to.outgoingKnown = true;
        addDirection(from.incoming, edge.toFrom);
        from.incomingKnown = true;
      }
      nodeTraffic.set(edge.from, from);
      nodeTraffic.set(edge.to, to);
    }
    const nodes: MeshAnalysisNode[] = participants.map((participant) => {
      const id = graphNodeId("peer", participant.id);
      const traffic = nodeTraffic.get(id);
      return Object.freeze({
        id,
        targetId: participant.id,
        kind: "participant" as const,
        label: participant.name,
        own: participant.own,
        role: "participant" as const,
        ownerPeerId: participant.id,
        connectionState: participant.connectionState,
        icePath: participant.icePath,
        linkClass: participant.linkClass,
        publications: Object.freeze([...participant.publications]),
        readyPeerCount: 0,
        outgoingBps: traffic?.outgoingKnown ? boundedRate(traffic.outgoing.totalBps) : null,
        incomingBps: traffic?.incomingKnown ? boundedRate(traffic.incoming.totalBps) : null,
        audioOutgoingBps: traffic?.outgoingKnown ? boundedRate(traffic.outgoing.audioBps) : null,
        audioIncomingBps: traffic?.incomingKnown ? boundedRate(traffic.incoming.audioBps) : null,
        videoOutgoingBps: traffic?.outgoingKnown ? boundedRate(traffic.outgoing.videoBps) : null,
        videoIncomingBps: traffic?.incomingKnown ? boundedRate(traffic.incoming.videoBps) : null,
        screenOutgoingBps: traffic?.outgoingKnown ? boundedRate(traffic.outgoing.screenBps) : null,
        screenIncomingBps: traffic?.incomingKnown ? boundedRate(traffic.incoming.screenBps) : null,
        dataOutgoingBps: traffic?.outgoingKnown ? boundedRate(traffic.outgoing.dataBps) : null,
        dataIncomingBps: traffic?.incomingKnown ? boundedRate(traffic.incoming.dataBps) : null,
      });
    });
    for (const agent of agents) {
      const id = graphNodeId("media-agent", agent.id);
      const traffic = nodeTraffic.get(id);
      nodes.push(Object.freeze({
        id,
        targetId: agent.id,
        kind: "media-agent",
        label: `Agent ${agent.id}`,
        own: agent.ownerPeerId === this.ownPeerId,
        role: agent.role,
        ownerPeerId: agent.ownerPeerId,
        connectionState: agent.connected ? "connected" : agent.readyPeerIds.length > 0 ? "server-ready" : "route-known",
        icePath: "not-applicable",
        linkClass: "not-applicable",
        publications: Object.freeze([]),
        readyPeerCount: agent.readyPeerIds.length,
        outgoingBps: traffic?.outgoingKnown ? boundedRate(traffic.outgoing.totalBps) : null,
        incomingBps: traffic?.incomingKnown ? boundedRate(traffic.incoming.totalBps) : null,
        audioOutgoingBps: traffic?.outgoingKnown ? boundedRate(traffic.outgoing.audioBps) : null,
        audioIncomingBps: traffic?.incomingKnown ? boundedRate(traffic.incoming.audioBps) : null,
        videoOutgoingBps: traffic?.outgoingKnown ? boundedRate(traffic.outgoing.videoBps) : null,
        videoIncomingBps: traffic?.incomingKnown ? boundedRate(traffic.incoming.videoBps) : null,
        screenOutgoingBps: traffic?.outgoingKnown ? boundedRate(traffic.outgoing.screenBps) : null,
        screenIncomingBps: traffic?.incomingKnown ? boundedRate(traffic.incoming.screenBps) : null,
        dataOutgoingBps: traffic?.outgoingKnown ? boundedRate(traffic.outgoing.dataBps) : null,
        dataIncomingBps: traffic?.incomingKnown ? boundedRate(traffic.incoming.dataBps) : null,
      }));
    }
    this.graph.set(Object.freeze({
      roomId: context.roomId,
      topologyMode: context.topologyMode,
      membershipEpoch: context.membershipEpoch,
      routeEpoch: context.routeEpoch,
      mediaAgentRouteEpoch: context.mediaAgentRouteEpoch,
      topologyEpoch: context.topologyEpoch,
      nodes: Object.freeze(nodes),
      edges: Object.freeze(edges),
      updatedAt: now,
    }));
  }

  private makeEdge(input: Readonly<{
    id: string;
    fromKind: MeshAnalysisTargetKind;
    fromId: string;
    toKind: MeshAnalysisTargetKind;
    toId: string;
    kind: MeshAnalysisEdgeKind;
    roles: readonly string[];
    routeRoots: readonly string[];
    ready: boolean;
  }>, now: number): MeshAnalysisEdge {
    const forward = this.directionObservation(input.fromKind, input.fromId, input.toKind, input.toId, now);
    const reverse = this.directionObservation(input.toKind, input.toId, input.fromKind, input.fromId, now);
    const observations = [forward, reverse].filter(Boolean) as DirectionObservation[];
    const source: MeshMeasurementSource = observations.some(({ source: value }) => value === "local")
      ? "local" : observations.length > 0 ? "peer-reported" : "unavailable";
    return Object.freeze({
      id: input.id,
      from: graphNodeId(input.fromKind, input.fromId),
      to: graphNodeId(input.toKind, input.toId),
      kind: input.kind,
      roles: Object.freeze([...input.roles]),
      routeRoots: Object.freeze([...input.routeRoots]),
      ready: input.ready || observations.length > 0,
      fromTo: forward ? Object.freeze({
        totalBps: forward.totalBps,
        audioBps: forward.audioBps,
        videoBps: forward.videoBps,
        screenBps: forward.screenBps,
        dataBps: forward.dataBps,
      }) : null,
      toFrom: reverse ? Object.freeze({
        totalBps: reverse.totalBps,
        audioBps: reverse.audioBps,
        videoBps: reverse.videoBps,
        screenBps: reverse.screenBps,
        dataBps: reverse.dataBps,
      }) : null,
      totalBps: observations.length > 0 ? boundedRate((forward?.totalBps || 0) + (reverse?.totalBps || 0)) : null,
      measurementSource: source,
      measuredAt: observations.length > 0 ? Math.max(...observations.map(({ sampledAt }) => sampledAt)) : null,
    });
  }
}
