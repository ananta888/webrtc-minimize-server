import { describe, expect, it } from "vitest";

import {
  MESH_TELEMETRY_TTL_MS,
  MeshAnalysisContext,
  MeshAnalysisService,
  MeshTrafficCounters,
  MeshTrafficRateTracker,
} from "./mesh-analysis.service";

const ownId = "0123456789abcdef";
const peerA = "1111111111111111";
const peerB = "2222222222222222";

function counters(sampledAt: number, multiplier: number): MeshTrafficCounters {
  return {
    sampledAt,
    outgoingBytes: 250_000 * multiplier,
    incomingBytes: 125_000 * multiplier,
    audioOutgoingBytes: 10_000 * multiplier,
    audioIncomingBytes: 8_000 * multiplier,
    videoOutgoingBytes: 100_000 * multiplier,
    videoIncomingBytes: 40_000 * multiplier,
    screenOutgoingBytes: 120_000 * multiplier,
    screenIncomingBytes: 60_000 * multiplier,
    dataOutgoingBytes: 5_000 * multiplier,
    dataIncomingBytes: 3_000 * multiplier,
  };
}

function context(overrides: Partial<MeshAnalysisContext> = {}): MeshAnalysisContext {
  return {
    roomId: "room-123456",
    topologyMode: "adaptive_mesh",
    membershipEpoch: 3,
    routeEpoch: 4,
    mediaAgentRouteEpoch: 6,
    topologyEpoch: 5,
    participants: [
      { id: ownId, name: "Ada", own: true, connectionState: "local", icePath: "direct", linkClass: "good", publications: ["camera", "screen", "microphone"] },
      { id: peerA, name: "Grace", own: false, connectionState: "connected", icePath: "direct", linkClass: "good", publications: ["camera"] },
      { id: peerB, name: "Linus", own: false, connectionState: "connected", icePath: "direct", linkClass: "constrained", publications: [] },
    ],
    trustedRelayEdges: [],
    agents: [],
    publisherAssignments: [],
    subscriberAssignments: [],
    federationLinks: [],
    ...overrides,
  };
}

describe("mesh traffic analysis", () => {
  it("derives bounded bit rates from monotone counters and drops reset or stale windows", () => {
    const tracker = new MeshTrafficRateTracker();
    expect(tracker.sample("peer:a", counters(1_000, 1))).toBeNull();
    const rate = tracker.sample("peer:a", counters(3_000, 2));
    expect(rate).toMatchObject({
      outgoingBps: 1_000_000,
      incomingBps: 500_000,
      audioOutgoingBps: 40_000,
      videoOutgoingBps: 400_000,
      screenOutgoingBps: 480_000,
      dataOutgoingBps: 20_000,
    });
    expect(tracker.sample("peer:a", counters(4_000, 1))).toBeNull();
    expect(tracker.sample("peer:a", counters(4_000 + MESH_TELEMETRY_TTL_MS + 1, 3))).toBeNull();
  });

  it("shows measured audio, video and screen traffic while membership remains context-owned", () => {
    const service = new MeshAnalysisService();
    service.initialize("room-123456", ownId);
    expect(service.updateContext(context(), 0)).toBe(true);
    expect(service.sampleLocal("peer", peerA, counters(1_000, 1))).toBeNull();
    expect(service.sampleLocal("peer", peerA, counters(3_000, 2))).not.toBeNull();

    const edge = service.graph().edges.find(({ id }) => id === `peer:${ownId}:${peerA}`)!;
    expect(edge.totalBps).toBe(1_500_000);
    const own = service.graph().nodes.find(({ targetId }) => targetId === ownId)!;
    expect(own).toMatchObject({
      outgoingBps: 1_000_000,
      incomingBps: 500_000,
      audioOutgoingBps: 40_000,
      videoOutgoingBps: 400_000,
      screenOutgoingBps: 480_000,
    });

    expect(service.acceptPeerTelemetry(peerA, {
      version: 1,
      type: "mesh-telemetry",
      sequence: 1,
      links: [{
        targetKind: "peer",
        targetId: "ffffffffffffffff",
        rates: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      }],
    }, 4_000)).toBe(false);
    expect(service.graph().nodes.some(({ targetId }) => targetId === "ffffffffffffffff")).toBe(false);
  });

  it("accepts fresh remote incident-link telemetry once per bound interval and expires it", () => {
    const service = new MeshAnalysisService();
    service.initialize("room-123456", ownId);
    service.updateContext(context(), 0);
    const message = {
      version: 1 as const,
      type: "mesh-telemetry" as const,
      sequence: 7,
      links: [{
        targetKind: "peer" as const,
        targetId: peerB,
        rates: [900_000, 300_000, 50_000, 40_000, 500_000, 200_000, 300_000, 50_000, 10_000, 10_000] as const,
      }],
    };
    expect(service.acceptPeerTelemetry(peerA, message, 10_000)).toBe(true);
    expect(service.acceptPeerTelemetry(peerA, { ...message, sequence: 8 }, 10_500)).toBe(false);
    const edge = service.graph().edges.find(({ id }) => id === `peer:${peerA}:${peerB}`)!;
    expect(edge.fromTo).toMatchObject({ totalBps: 900_000, audioBps: 50_000, videoBps: 500_000, screenBps: 300_000 });
    expect(edge.measurementSource).toBe("peer-reported");

    service.expire(10_000 + MESH_TELEMETRY_TTL_MS + 1);
    expect(service.graph().edges.find(({ id }) => id === `peer:${peerA}:${peerB}`)?.totalBps).toBeNull();
  });

  it("draws only validated agent assignments and marks unobservable federation rates unknown", () => {
    const service = new MeshAnalysisService();
    service.initialize("room-123456", ownId);
    expect(service.updateContext(context({
      agents: [
        { id: "edge-one", ownerPeerId: ownId, role: "primary", connected: true, readyPeerIds: [ownId, peerA, peerB] },
        { id: "edge-two", ownerPeerId: peerA, role: "standby", connected: false, readyPeerIds: [ownId, peerA] },
      ],
      publisherAssignments: [{ peerId: ownId, agentId: "edge-one" }],
      subscriberAssignments: [{ peerId: ownId, agentId: "edge-two" }],
      federationLinks: [{ leftAgentId: "edge-one", rightAgentId: "edge-two", ready: true }],
    }), 0)).toBe(true);
    service.sampleLocal("media-agent", "edge-one", counters(1_000, 1));
    service.sampleLocal("media-agent", "edge-one", counters(3_000, 2));

    expect(service.graph().nodes.filter(({ kind }) => kind === "media-agent")).toHaveLength(2);
    expect(service.graph().nodes.find(({ targetId }) => targetId === "edge-two")).toMatchObject({
      connectionState: "server-ready",
      readyPeerCount: 2,
    });
    expect(service.graph().edges.find(({ id }) => id === "agent-link:0123456789abcdef:edge-one")?.totalBps).toBe(1_500_000);
    expect(service.graph().edges.find(({ kind }) => kind === "agent-federation")).toMatchObject({
      ready: true,
      totalBps: null,
      measurementSource: "unavailable",
    });
    expect(service.sampleLocal("media-agent", "unassigned", counters(4_000, 3))).toBeNull();
    expect(service.updateContext(context({
      agents: [{
        id: "edge-one",
        ownerPeerId: ownId,
        role: "primary",
        connected: false,
        readyPeerIds: ["ffffffffffffffff"],
      }],
    }), 5_000)).toBe(false);
  });

  it("materializes server-authorized trusted relay edges without letting telemetry add routes", () => {
    const service = new MeshAnalysisService();
    service.initialize("room-123456", ownId);
    service.updateContext(context({
      topologyMode: "trusted_peer_relay",
      trustedRelayEdges: [
        { rootPeerId: ownId, parentPeerId: ownId, childPeerId: peerA },
        { rootPeerId: ownId, parentPeerId: peerA, childPeerId: peerB },
      ],
    }), 0);
    expect(service.graph().edges.find(({ id }) => id === `peer:${peerA}:${peerB}`)).toMatchObject({
      kind: "trusted-relay",
      routeRoots: [ownId],
    });
    expect(service.graph().edges).toHaveLength(3);
  });
});
