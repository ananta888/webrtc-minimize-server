import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IceTierPolicy } from "./ice-policy";
import { classifySelectedIcePath, PeerConnectionManager } from "./peer-connection-manager";

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  readonly initialConfiguration: RTCConfiguration;
  configuration: RTCConfiguration;
  restarts = 0;
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  readonly createdChannels: string[] = [];
  onicecandidate: RTCPeerConnection["onicecandidate"] = null;
  ontrack: RTCPeerConnection["ontrack"] = null;
  ondatachannel: RTCPeerConnection["ondatachannel"] = null;
  oniceconnectionstatechange: RTCPeerConnection["oniceconnectionstatechange"] = null;
  onconnectionstatechange: RTCPeerConnection["onconnectionstatechange"] = null;
  onnegotiationneeded: RTCPeerConnection["onnegotiationneeded"] = null;

  constructor(configuration: RTCConfiguration) {
    this.initialConfiguration = configuration;
    this.configuration = configuration;
    FakePeerConnection.instances.push(this);
  }

  setConfiguration(configuration: RTCConfiguration): void { this.configuration = configuration; }
  createDataChannel(label: string): RTCDataChannel {
    this.createdChannels.push(label);
    return { label, close: vi.fn() } as unknown as RTCDataChannel;
  }
  restartIce(): void { this.restarts += 1; }
  async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    const resolved = description || { type: "offer", sdp: "v=0\r\n" };
    this.localDescription = resolved as RTCSessionDescription;
    this.signalingState = resolved.type === "offer" ? "have-local-offer" : "stable";
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
    this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
  }
  close(): void { this.connectionState = "closed"; this.iceConnectionState = "closed"; }
}

const policy: IceTierPolicy = {
  version: 1,
  directIceServers: [{ urls: "stun:direct.test" }],
  peerRelayIceServers: [{ urls: "turn:edge.test", username: "u", credential: "p" }],
  infrastructureRelayIceServers: [{ urls: "turn:infra.test", username: "u", credential: "p" }],
  peerRelayAfterMs: 4_000,
  infrastructureRelayAfterMs: 9_000,
};

function manager(icePolicy = policy): PeerConnectionManager {
  return new PeerConnectionManager("ffffffffffffffff", icePolicy, false, {
    signal: () => undefined,
    track: () => undefined,
    channel: () => undefined,
    state: () => undefined,
    negotiationError: () => undefined,
  });
}

describe("staged ICE connection manager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakePeerConnection.instances = [];
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts direct, activates Edge second and never escalates a connected path", () => {
    const connections = manager();
    const peer = connections.add("0000000000000001", "Ada")!;
    const pc = peer.pc as unknown as FakePeerConnection;
    expect(pc.initialConfiguration.iceServers).toHaveLength(1);
    vi.advanceTimersByTime(4_000);
    expect(peer.iceTier).toBe(1);
    expect(pc.configuration.iceServers).toHaveLength(2);
    expect(pc.restarts).toBe(1);
    pc.connectionState = "connected";
    pc.iceConnectionState = "connected";
    pc.onconnectionstatechange?.(new Event("connectionstatechange"));
    vi.advanceTimersByTime(10_000);
    expect(peer.iceTier).toBe(1);
    expect(pc.restarts).toBe(1);
    connections.close();
  });

  it("skips a missing Edge tier and activates infrastructure TURN last", () => {
    const connections = manager({ ...policy, peerRelayIceServers: [] });
    const peer = connections.add("0000000000000001", "Ada")!;
    const pc = peer.pc as unknown as FakePeerConnection;
    vi.advanceTimersByTime(8_999);
    expect(peer.iceTier).toBe(0);
    vi.advanceTimersByTime(1);
    expect(peer.iceTier).toBe(2);
    expect(pc.configuration.iceServers).toHaveLength(2);
    connections.close();
  });

  it("does not skip Edge when both failed-state callbacks describe one transition", () => {
    const connections = manager();
    const peer = connections.add("0000000000000001", "Ada")!;
    const pc = peer.pc as unknown as FakePeerConnection;
    pc.connectionState = "failed";
    pc.iceConnectionState = "failed";
    pc.oniceconnectionstatechange?.(new Event("iceconnectionstatechange"));
    pc.onconnectionstatechange?.(new Event("connectionstatechange"));
    expect(peer.iceTier).toBe(1);
    expect(pc.restarts).toBe(1);
    vi.advanceTimersByTime(9_000);
    expect(peer.iceTier).toBe(2);
    expect(pc.restarts).toBe(2);
    connections.close();
  });

  it("classifies selected paths without exposing candidate addresses", () => {
    const report = new Map<string, unknown>([
      ["transport", { id: "transport", type: "transport", selectedCandidatePairId: "pair" }],
      ["pair", { id: "pair", type: "candidate-pair", localCandidateId: "local", state: "succeeded" }],
      ["local", { id: "local", type: "local-candidate", candidateType: "relay", url: "turn:edge.test" }],
    ]) as unknown as RTCStatsReport;
    expect(classifySelectedIcePath(report, 2, new Set(["turn:edge.test"]))).toBe("peer-edge");
    const direct = new Map<string, unknown>([
      ["pair", { id: "pair", type: "candidate-pair", selected: true, localCandidateId: "local" }],
      ["local", { id: "local", type: "local-candidate", candidateType: "host", address: "192.0.2.1" }],
    ]) as unknown as RTCStatsReport;
    expect(classifySelectedIcePath(direct, 0, new Set())).toBe("direct");
  });

  it("negotiates a dedicated reliable captions channel without waiting for model activation", () => {
    const channels: string[] = [];
    const connections = new PeerConnectionManager("0000000000000001", policy, true, {
      signal: () => undefined,
      track: () => undefined,
      channel: (_peer, channel) => channels.push(channel.label),
      state: () => undefined,
      negotiationError: () => undefined,
    });
    connections.add("ffffffffffffffff", "Grace");
    expect(channels).toEqual(["control", "chat", "captions", "overlay"]);
    connections.close();
  });

  it("replays a direct-mesh negotiation requested while an offer is outstanding", async () => {
    const descriptions: RTCSessionDescriptionInit[] = [];
    const connections = new PeerConnectionManager("0000000000000001", policy, true, {
      signal: (_peerId, payload) => {
        const description = (payload as { description?: RTCSessionDescriptionInit }).description;
        if (description) descriptions.push(description);
      },
      track: () => undefined,
      channel: () => undefined,
      state: () => undefined,
      negotiationError: () => undefined,
    });
    const peer = connections.add("ffffffffffffffff", "Grace")!;
    const pc = peer.pc as unknown as FakePeerConnection;

    pc.onnegotiationneeded?.(new Event("negotiationneeded"));
    await vi.waitFor(() => expect(descriptions).toHaveLength(1));
    pc.onnegotiationneeded?.(new Event("negotiationneeded"));
    expect(descriptions).toHaveLength(1);

    await connections.acceptSignal({
      type: "signal",
      from: peer.id,
      fromName: peer.name,
      description: { type: "answer", sdp: "v=0\r\n" },
    });
    await vi.waitFor(() => expect(descriptions).toHaveLength(2));
    connections.close();
  });
});
