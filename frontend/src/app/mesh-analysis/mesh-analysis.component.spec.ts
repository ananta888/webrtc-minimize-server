import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MeshAnalysisGraph, MeshAnalysisService } from "../webrtc/mesh-analysis.service";
import { MeshAnalysisComponent, formatBitrate, layoutMeshGraph } from "./mesh-analysis.component";

const emptyRates = {
  outgoingBps: null,
  incomingBps: null,
  audioOutgoingBps: null,
  audioIncomingBps: null,
  videoOutgoingBps: null,
  videoIncomingBps: null,
  screenOutgoingBps: null,
  screenIncomingBps: null,
  dataOutgoingBps: null,
  dataIncomingBps: null,
};

function graph(nodeCount = 3): MeshAnalysisGraph {
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    id: `peer:${index.toString(16).padStart(16, "0")}`,
    targetId: index.toString(16).padStart(16, "0"),
    kind: "participant" as const,
    label: index === 0 ? "Ada" : `Peer ${index}`,
    own: index === 0,
    role: "participant" as const,
    ownerPeerId: index.toString(16).padStart(16, "0"),
    connectionState: index === 0 ? "local" : "connected",
    icePath: "direct" as const,
    linkClass: "good" as const,
    publications: index === 0 ? ["camera" as const, "screen" as const] : [],
    readyPeerCount: 0,
    ...emptyRates,
  }));
  return {
    roomId: "room-123456",
    topologyMode: "adaptive_mesh",
    membershipEpoch: 1,
    routeEpoch: 1,
    mediaAgentRouteEpoch: 0,
    topologyEpoch: 1,
    nodes,
    edges: [],
    updatedAt: 1_000,
  };
}

describe("mesh analysis presentation", () => {
  it("formats decimal bit rates with an automatic kbit/s or Mbit/s unit", () => {
    expect(formatBitrate(null)).toBe("nicht messbar");
    expect(formatBitrate(0)).toBe("0 kbit/s");
    expect(formatBitrate(128_000)).toBe("128 kbit/s");
    expect(formatBitrate(1_250_000)).toBe("1,25 Mbit/s");
  });

  it("lays out the maximum browser membership deterministically inside the SVG", () => {
    const first = layoutMeshGraph(graph(20));
    const second = layoutMeshGraph(graph(20));
    expect(first).toEqual(second);
    expect(first.nodes).toHaveLength(20);
    expect(first.nodes.every(({ x, y }) => x >= 60 && x <= 940 && y >= 30 && y <= 590)).toBe(true);
    expect(new Set(first.nodes.map(({ x, y }) => `${x}:${y}`)).size).toBe(20);
  });

  it("selects a node by click-equivalent or keyboard activation", () => {
    const analysis = new MeshAnalysisService();
    analysis.graph.set(graph());
    const component = new MeshAnalysisComponent(analysis);
    component.ngOnInit();
    expect(analysis.viewing()).toBe(true);
    expect(component.selectedNode()?.label).toBe("Ada");
    component.selectNode("peer:0000000000000001");
    expect(component.selectedNode()?.label).toBe("Peer 1");
    const event = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    component.activateNode(event, "peer:0000000000000002");
    expect(event.defaultPrevented).toBe(true);
    expect(component.selectedNode()?.label).toBe("Peer 2");
    component.ngOnDestroy();
    expect(analysis.viewing()).toBe(false);
  });

  it("renders all requested media-rate rows and keeps capture APIs out of the analysis component", () => {
    const source = readFileSync("frontend/src/app/mesh-analysis/mesh-analysis.component.ts", "utf8");
    expect(source).toContain("Audio");
    expect(source).toContain("Kamera / Video");
    expect(source).toContain("Bildschirmteilen");
    expect(source).toContain('(click)="selectNode(node.id)"');
    expect(source).toContain("role=\"button\"");
    expect(source).not.toContain("getUserMedia");
    expect(source).not.toContain("getDisplayMedia");
  });
});
