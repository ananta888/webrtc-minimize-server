import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IceTierPolicy } from "./ice-policy";
import { BlindMediaAgentService } from "./blind-media-agent.service";
import { SignalingService } from "./signaling.service";

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  connectionState: RTCPeerConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  readonly candidates: Array<RTCIceCandidateInit | null> = [];
  onicecandidate: RTCPeerConnection["onicecandidate"] = null;
  ontrack: RTCPeerConnection["ontrack"] = null;
  onconnectionstatechange: RTCPeerConnection["onconnectionstatechange"] = null;
  onnegotiationneeded: RTCPeerConnection["onnegotiationneeded"] = null;
  readonly transceivers: RTCRtpTransceiverInit[] = [];

  constructor(readonly configuration: RTCConfiguration) {
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(): RTCDataChannel { return {} as RTCDataChannel; }
  addTransceiver(_track: MediaStreamTrack, init?: RTCRtpTransceiverInit): RTCRtpTransceiver {
    this.transceivers.push(init || {});
    return { sender: {} as RTCRtpSender } as RTCRtpTransceiver;
  }
  addTrack(): RTCRtpSender { return {} as RTCRtpSender; }
  removeTrack(): void {}
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
  }
  async addIceCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    this.candidates.push(candidate);
  }
  close(): void { this.connectionState = "closed"; }
}

const icePolicy: IceTierPolicy = {
  version: 1,
  directIceServers: [{ urls: "stun:direct.test" }],
  peerRelayIceServers: [],
  infrastructureRelayIceServers: [{ urls: "turn:relay.test", username: "u", credential: "p" }],
  peerRelayAfterMs: 3_000,
  infrastructureRelayAfterMs: 8_000,
};

const ownPeerId = "0123456789abcdef";
const now = 1_800_000_000_000;

describe("blind media-agent browser adapter", () => {
  const sent: Record<string, unknown>[] = [];
  const capture = vi.fn();
  let service: BlindMediaAgentService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    FakePeerConnection.instances = [];
    sent.length = 0;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: capture, getDisplayMedia: capture },
    });
    service = new BlindMediaAgentService({
      send: (message: Record<string, unknown>) => sent.push(message),
    } as unknown as SignalingService);
    service.initialize({
      ownPeerId,
      roomId: "room-123456",
      membershipEpoch: 0,
      icePolicy,
      availableAgents: [{ id: "owner-edge", online: true }],
      callbacks: {
        attachSender: () => false,
        acceptTrack: () => false,
        trackState: () => undefined,
        routeChanged: () => undefined,
        connectionChanged: () => undefined,
      },
    });
  });

  afterEach(() => {
    service.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    capture.mockReset();
  });

  it("keeps consent off and requests it only through an explicit local action", () => {
    expect(service.consentEnabled()).toBe(false);
    expect(sent).toEqual([]);
    service.setConsent(true);
    expect(sent).toEqual([{
      version: 1,
      type: "media-agent-consent-set",
      agentIds: ["owner-edge"],
      automaticTakeover: false,
    }]);
    expect(capture).not.toHaveBeenCalled();
  });

  it("atomically enables, updates and revokes multiple selected owned agents", () => {
    expect(service.applyAvailability({
      version: 1,
      type: "media-agent-availability",
      agents: [{ id: "owner-edge", online: true }, { id: "second-edge", online: true }],
    })).toBe(true);
    expect(service.selectedAgentIds()).toEqual(["owner-edge"]);
    service.setAgentSelected("second-edge", true);
    expect(service.selectedAgentIds()).toEqual(["owner-edge", "second-edge"]);

    service.setConsent(true);
    expect(service.consentedAgentIds()).toEqual(["owner-edge", "second-edge"]);
    expect(sent.at(-1)).toEqual({
      version: 1,
      type: "media-agent-consent-set",
      agentIds: ["owner-edge", "second-edge"],
      automaticTakeover: false,
    });
    service.setAgentSelected("owner-edge", false);
    expect(service.selectedAgentIds()).toEqual(["owner-edge", "second-edge"]);

    service.setAutomaticTakeover(true);
    expect(sent.at(-1)).toEqual({
      version: 1,
      type: "media-agent-consent-set",
      agentIds: ["owner-edge", "second-edge"],
      automaticTakeover: true,
    });
    service.applyAvailability({
      version: 1,
      type: "media-agent-availability",
      agents: [{ id: "owner-edge", online: false }, { id: "second-edge", online: true }],
    });
    expect(service.selectedAgentIds()).toEqual(["owner-edge", "second-edge"]);
    service.setConsent(false);
    expect(service.consentEnabled()).toBe(false);
    expect(service.selectedAgentIds()).toEqual(["second-edge"]);
    expect(sent.at(-1)).toEqual({
      version: 1,
      type: "media-agent-consent-set",
      agentIds: [],
      automaticTakeover: true,
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("bounds the local multi-selection to the contract maximum", () => {
    service.applyAvailability({
      version: 1,
      type: "media-agent-availability",
      agents: ["a", "b", "c", "d"].map((suffix) => ({ id: `edge-${suffix}`, online: true })),
    });
    service.setAgentSelected("edge-b", true);
    service.setAgentSelected("edge-c", true);
    expect(service.selectionLimitReached()).toBe(true);
    service.setAgentSelected("edge-d", true);
    expect(service.selectedAgentIds()).toEqual(["edge-a", "edge-b", "edge-c"]);
  });

  it("updates owned-agent availability through a closed server message", () => {
    expect(service.applyAvailability({
      version: 1,
      type: "media-agent-availability",
      agents: [{ id: "owner-edge", online: false }, { id: "second-edge", online: true }],
    })).toBe(true);
    expect(service.availableAgents().map(({ id, online }) => [id, online])).toEqual([
      ["owner-edge", false], ["second-edge", true],
    ]);
    expect(service.applyAvailability({
      version: 1,
      type: "media-agent-availability",
      agents: [{ id: "owner-edge", online: true, secret: "leak" }],
    })).toBe(false);
    expect(service.applyAvailability({
      version: 1,
      type: "media-agent-availability",
      agents: [{ id: "owner-edge", online: false }],
    })).toBe(true);
    service.setConsent(true);
    expect(sent).toEqual([]);
  });

  it("keeps takeover explicit and removes an unanswered request at its deadline", () => {
    service.applyTakeoverRequest({
      version: 1,
      type: "media-agent-takeover-request",
      requestId: "0123456789abcdef0123456789abcdef",
      agentId: "owner-edge",
      expiresAt: now + 20_000,
      creatorPreferred: true,
    });
    expect(service.takeoverRequest()?.agentId).toBe("owner-edge");
    vi.advanceTimersByTime(20_000);
    expect(service.takeoverRequest()).toBeNull();
    expect(sent).toEqual([]);
  });

  it("accepts only a fresh server route and closes it when its short lease expires", () => {
    service.updateMembershipEpoch(3);
    expect(service.applyRoute({
      version: 3,
      type: "media-agent-state",
      enabled: true,
      membershipEpoch: 3,
      routeEpoch: 5,
      leaseExpiresAt: now + 30_000,
      primary: { id: "owner-edge", ownerPeerId: ownPeerId, creatorPreferred: true },
      standbys: [],
      forwarderIds: ["owner-edge"],
      publisherAssignments: [{ peerId: ownPeerId, agentId: "owner-edge" }],
      subscriberAssignments: [{ peerId: ownPeerId, agentId: "owner-edge" }],
      federationLinks: [],
      federationRoutes: [],
      readiness: [{ agentId: "owner-edge", readyPeerIds: [ownPeerId] }],
    }, new Set([ownPeerId]))).toBe(true);
    expect(service.status()).toBe("connecting");
    expect(FakePeerConnection.instances).toHaveLength(1);
    const pc = FakePeerConnection.instances[0];
    pc.connectionState = "connected";
    pc.onconnectionstatechange?.(new Event("connectionstatechange"));
    expect(service.routeReady("owner-edge", new Set([ownPeerId]))).toBe(true);
    expect(sent.at(-1)).toMatchObject({ type: "media-agent-peer-state", connected: true, routeEpoch: 5 });
    expect(service.applyRoute({
      version: 3,
      type: "media-agent-state",
      enabled: true,
      membershipEpoch: 3,
      routeEpoch: 4,
      leaseExpiresAt: now + 30_000,
      primary: null,
      standbys: [],
      forwarderIds: [],
      publisherAssignments: [],
      subscriberAssignments: [],
      federationLinks: [],
      federationRoutes: [],
      readiness: [],
    }, new Set([ownPeerId]))).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(service.primaryAgentId()).toBe("");
    expect(pc.connectionState).toBe("closed");
  });

  it("reports the locally assigned shard as connected without requiring a primary connection", () => {
    const remotePeerId = "fedcba9876543210";
    service.updateMembershipEpoch(3);
    expect(service.applyRoute({
      version: 3,
      type: "media-agent-state",
      enabled: true,
      membershipEpoch: 3,
      routeEpoch: 5,
      leaseExpiresAt: now + 30_000,
      primary: { id: "owner-edge", ownerPeerId: remotePeerId, creatorPreferred: true },
      standbys: [{ id: "second-edge", ownerPeerId: ownPeerId, creatorPreferred: false }],
      forwarderIds: ["owner-edge", "second-edge"],
      publisherAssignments: [
        { peerId: ownPeerId, agentId: "second-edge" },
        { peerId: remotePeerId, agentId: "owner-edge" },
      ],
      subscriberAssignments: [
        { peerId: ownPeerId, agentId: "second-edge" },
        { peerId: remotePeerId, agentId: "owner-edge" },
      ],
      federationLinks: [{
        linkId: "abcdefghijklmnopqrstuv",
        leftAgentId: "owner-edge",
        rightAgentId: "second-edge",
        initiatorAgentId: "owner-edge",
        readyAgentIds: [],
      }],
      federationRoutes: [{
        publisherPeerId: remotePeerId,
        sourceAgentId: "owner-edge",
        maximumHops: 2,
        edges: [],
      }, {
        publisherPeerId: ownPeerId,
        sourceAgentId: "second-edge",
        maximumHops: 2,
        edges: [],
      }],
      readiness: [
        { agentId: "owner-edge", readyPeerIds: [remotePeerId] },
        { agentId: "second-edge", readyPeerIds: [ownPeerId] },
      ],
    }, new Set([ownPeerId, remotePeerId]))).toBe(true);
    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(service.primaryAgentId()).toBe("owner-edge");
    expect(service.analysisTargets()[0].agentId).toBe("second-edge");
    expect(service.status()).toBe("connecting");

    const assignedShard = FakePeerConnection.instances[0];
    assignedShard.connectionState = "connected";
    assignedShard.onconnectionstatechange?.(new Event("connectionstatechange"));

    expect(service.status()).toBe("connected");
    expect(sent.at(-1)).toMatchObject({
      type: "media-agent-peer-state",
      agentId: "second-edge",
      connected: true,
    });
  });

  it("queues an early ICE candidate until the agent description is installed", async () => {
    service.updateMembershipEpoch(3);
    expect(service.applyRoute({
      version: 3,
      type: "media-agent-state",
      enabled: true,
      membershipEpoch: 3,
      routeEpoch: 5,
      leaseExpiresAt: now + 30_000,
      primary: { id: "owner-edge", ownerPeerId: ownPeerId, creatorPreferred: true },
      standbys: [],
      forwarderIds: ["owner-edge"],
      publisherAssignments: [{ peerId: ownPeerId, agentId: "owner-edge" }],
      subscriberAssignments: [{ peerId: ownPeerId, agentId: "owner-edge" }],
      federationLinks: [],
      federationRoutes: [],
      readiness: [{ agentId: "owner-edge", readyPeerIds: [] }],
    }, new Set([ownPeerId]))).toBe(true);
    const pc = FakePeerConnection.instances[0];
    await service.acceptSignal({
      version: 1,
      type: "media-agent-signal",
      agentId: "owner-edge",
      roomId: "room-123456",
      routeEpoch: 5,
      candidate: { candidate: "candidate:1 1 UDP 1 192.0.2.1 45000 typ host" },
    });
    expect(pc.candidates).toEqual([]);
    await service.acceptSignal({
      version: 1,
      type: "media-agent-signal",
      agentId: "owner-edge",
      roomId: "room-123456",
      routeEpoch: 5,
      description: { type: "answer", sdp: "v=0\r\n" },
    });
    expect(pc.candidates).toEqual([{ candidate: "candidate:1 1 UDP 1 192.0.2.1 45000 typ host" }]);
  });

  it("creates bounded camera simulcast encodings without requesting capture", () => {
    service.updateMembershipEpoch(3);
    expect(service.applyRoute({
      version: 3,
      type: "media-agent-state",
      enabled: true,
      membershipEpoch: 3,
      routeEpoch: 5,
      leaseExpiresAt: now + 30_000,
      primary: { id: "owner-edge", ownerPeerId: ownPeerId, creatorPreferred: true },
      standbys: [],
      forwarderIds: ["owner-edge"],
      publisherAssignments: [{ peerId: ownPeerId, agentId: "owner-edge" }],
      subscriberAssignments: [{ peerId: ownPeerId, agentId: "owner-edge" }],
      federationLinks: [],
      federationRoutes: [],
      readiness: [{ agentId: "owner-edge", readyPeerIds: [] }],
    }, new Set([ownPeerId]))).toBe(true);
    expect(service.activatePublication({
      agentId: "owner-edge",
      publicationId: "camera-track",
      source: "camera",
      stream: {} as MediaStream,
      track: { kind: "video", readyState: "live" } as MediaStreamTrack,
      contextId: "agent-out:camera-track:owner-edge:5",
      keyId: "0123456789abcdef",
      baseKey: new Uint8Array(16),
    })).toBe(false);
    expect(FakePeerConnection.instances[0].transceivers[0].sendEncodings?.map(({ rid }) => rid)).toEqual([
      "q", "h", "f",
    ]);
    expect(service.simulcastCapability()).toBe("available");
    expect(capture).not.toHaveBeenCalled();
  });

  it("marks a single-layer screen sender with the reserved transport RID", () => {
    service.updateMembershipEpoch(3);
    expect(service.applyRoute({
      version: 3,
      type: "media-agent-state",
      enabled: true,
      membershipEpoch: 3,
      routeEpoch: 5,
      leaseExpiresAt: now + 30_000,
      primary: { id: "owner-edge", ownerPeerId: ownPeerId, creatorPreferred: true },
      standbys: [],
      forwarderIds: ["owner-edge"],
      publisherAssignments: [{ peerId: ownPeerId, agentId: "owner-edge" }],
      subscriberAssignments: [{ peerId: ownPeerId, agentId: "owner-edge" }],
      federationLinks: [],
      federationRoutes: [],
      readiness: [{ agentId: "owner-edge", readyPeerIds: [ownPeerId] }],
    }, new Set([ownPeerId]))).toBe(true);
    expect(service.activatePublication({
      agentId: "owner-edge",
      publicationId: "screen-track",
      source: "screen",
      stream: {} as MediaStream,
      track: { kind: "video", readyState: "live" } as MediaStreamTrack,
      contextId: "agent-out:screen-track:owner-edge:5",
      keyId: "0123456789abcdef",
      baseKey: new Uint8Array(16),
    })).toBe(false);
    expect(FakePeerConnection.instances[0].transceivers[0].sendEncodings?.map(({ rid }) => rid)).toEqual(["s"]);
    expect(capture).not.toHaveBeenCalled();
  });

  it("does not let an ended superseded layer revoke the current subscription", () => {
    const remotePeerId = "fedcba9876543210";
    service.initialize({
      ownPeerId,
      roomId: "room-123456",
      membershipEpoch: 3,
      icePolicy,
      availableAgents: [{ id: "owner-edge", online: true }],
      callbacks: {
        attachSender: () => true,
        acceptTrack: () => true,
        trackState: () => undefined,
        routeChanged: () => undefined,
        connectionChanged: () => undefined,
      },
    });
    expect(service.applyRoute({
      version: 3,
      type: "media-agent-state",
      enabled: true,
      membershipEpoch: 3,
      routeEpoch: 5,
      leaseExpiresAt: now + 30_000,
      primary: { id: "owner-edge", ownerPeerId: ownPeerId, creatorPreferred: true },
      standbys: [],
      forwarderIds: ["owner-edge"],
      publisherAssignments: [
        { peerId: ownPeerId, agentId: "owner-edge" },
        { peerId: remotePeerId, agentId: "owner-edge" },
      ],
      subscriberAssignments: [
        { peerId: ownPeerId, agentId: "owner-edge" },
        { peerId: remotePeerId, agentId: "owner-edge" },
      ],
      federationLinks: [],
      federationRoutes: [],
      readiness: [{ agentId: "owner-edge", readyPeerIds: [] }],
    }, new Set([ownPeerId, remotePeerId]))).toBe(true);
    service.applyTrackState({
      version: 2,
      type: "media-agent-track-state",
      agentId: "owner-edge",
      routeEpoch: 5,
      peerId: remotePeerId,
      publicationId: "camera-track",
      source: "camera",
      layer: "high",
      rid: "f",
      active: true,
    });
    expect(service.setSubscriptionIntent({
      publisherPeerId: remotePeerId,
      publicationId: "camera-track",
      source: "camera",
      enabled: true,
      preferredLayer: "high",
      maximumLayer: "high",
    })).toBe(true);
    expect(service.applySubscriptionState(remotePeerId, {
      version: 2,
      type: "media-agent-subscription-state",
      agentId: "owner-edge",
      routeEpoch: 5,
      publicationId: "camera-track",
      subscriberPeerId: ownPeerId,
      selectedLayer: "high",
      revision: 11,
      ready: true,
    })).toBe(true);
    const pc = FakePeerConnection.instances.at(-1)!;
    const makeTrack = () => Object.assign(new EventTarget(), {
      id: "camera-track",
      kind: "video",
      enabled: true,
    }) as unknown as MediaStreamTrack;
    const first = makeTrack();
    const second = makeTrack();
    const event = (track: MediaStreamTrack) => ({
      track,
      receiver: {} as RTCRtpReceiver,
      streams: [{ id: remotePeerId } as MediaStream],
    }) as RTCTrackEvent;
    pc.ontrack?.(event(first));
    pc.ontrack?.(event(second));
    const falseBefore = sent.filter((message) => (
      message["type"] === "media-agent-subscription-ack" && message["ready"] === false
    )).length;
    first.dispatchEvent(new Event("ended"));
    expect(sent.filter((message) => (
      message["type"] === "media-agent-subscription-ack" && message["ready"] === false
    ))).toHaveLength(falseBefore);
    second.dispatchEvent(new Event("ended"));
    expect(sent.at(-1)).toMatchObject({
      version: 1,
      type: "media-agent-subscription-ack",
      publisherPeerId: remotePeerId,
      publicationId: "camera-track",
      revision: 11,
      ready: false,
    });
  });
});
