import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IceTierPolicy } from "./ice-policy";
import {
  classifySelectedIcePath,
  describeNegotiationError,
  ICE_RESTART_GRACE_MS,
  OFFER_ANSWER_TIMEOUT_MS,
  PeerConnectionManager,
} from "./peer-connection-manager";

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
  // Mirrors the live failure: a remote offer on top of a pending local offer is
  // rejected instead of being implicitly rolled back.
  rejectOfferOverLocalOffer = false;
  offerSequence = 0;
  readonly operations: string[] = [];
  private stableLocalDescription: RTCSessionDescription | null = null;
  async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    if (description?.type === "rollback") {
      if (this.signalingState !== "have-local-offer" && this.signalingState !== "have-remote-offer") {
        throw new DOMException("rollback in " + this.signalingState, "InvalidStateError");
      }
      this.operations.push("rollback");
      this.localDescription = this.stableLocalDescription;
      this.signalingState = "stable";
      return;
    }
    const type = description?.type
      ?? (this.signalingState === "have-remote-offer" ? "answer" : "offer");
    const resolved = description?.sdp !== undefined
      ? description
      : { type, sdp: "v=0\r\na=ice-ufrag:local" + (type === "offer" ? ++this.offerSequence : "") + "\r\n" };
    this.operations.push("local-" + type);
    this.localDescription = resolved as RTCSessionDescription;
    this.signalingState = resolved.type === "offer" ? "have-local-offer" : "stable";
    if (this.signalingState === "stable") this.stableLocalDescription = this.localDescription;
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (description.type === "offer" && this.signalingState === "have-local-offer" && this.rejectOfferOverLocalOffer) {
      throw new DOMException("Failed to execute 'setRemoteDescription' on 'RTCPeerConnection': Failed to set remote "
        + "offer sdp: Session error code: ERROR_CONTENT. Session error description: glare fixture.", "OperationError");
    }
    if (description.type === "answer" && this.signalingState !== "have-local-offer") {
      throw new DOMException("answer in " + this.signalingState, "InvalidStateError");
    }
    this.operations.push("remote-" + description.type);
    this.remoteDescription = description as RTCSessionDescription;
    this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
  }
  async addIceCandidate(): Promise<void> {
    if (!this.remoteDescription) throw new DOMException("no remote description", "InvalidStateError");
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

  it("lets an explicitly selected owner create the overlay channel above its peer id", () => {
    const channels: string[] = [];
    const connections = new PeerConnectionManager("ffffffffffffffff", policy, true, {
      signal: () => undefined,
      track: () => undefined,
      channel: (_peer, channel) => channels.push(channel.label),
      state: () => undefined,
      negotiationError: () => undefined,
    }, () => true);
    connections.add("0000000000000001", "Human");
    expect(channels).toEqual(["overlay"]);
    connections.close();
  });

  it("creates no overlay channel when the owner declines it", () => {
    const channels: string[] = [];
    const connections = new PeerConnectionManager("0000000000000001", policy, true, {
      signal: () => undefined,
      track: () => undefined,
      channel: (_peer, channel) => channels.push(channel.label),
      state: () => undefined,
      negotiationError: () => undefined,
    }, () => false);
    connections.add("ffffffffffffffff", "Grace");
    expect(channels).toEqual(["control", "chat", "captions"]);
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

describe("perfect negotiation glare resolution", () => {
  const POLITE_SELF = "ffffffffffffffff";
  const IMPOLITE_SELF = "0000000000000001";

  function harness(ownId: string) {
    const sent: RTCSessionDescriptionInit[] = [];
    const errors: unknown[] = [];
    const connections = new PeerConnectionManager(ownId, policy, false, {
      signal: (_peerId, payload) => {
        const description = (payload as { description?: RTCSessionDescriptionInit }).description;
        if (description) sent.push({ type: description.type, sdp: description.sdp });
      },
      track: () => undefined,
      channel: () => undefined,
      state: () => undefined,
      negotiationError: (_peer, error) => errors.push(error),
    });
    const remoteId = ownId === POLITE_SELF ? IMPOLITE_SELF : POLITE_SELF;
    const peer = connections.add(remoteId, "Remote")!;
    const pc = peer.pc as unknown as FakePeerConnection;
    const deliver = (payload: Record<string, unknown>) => connections.acceptSignal({
      type: "signal", from: remoteId, fromName: "Remote", ...payload,
    });
    return { connections, peer, pc, sent, errors, deliver };
  }

  const remoteOffer = (ufrag = "remote1"): RTCSessionDescriptionInit => ({
    type: "offer", sdp: `v=0\r\na=ice-ufrag:${ufrag}\r\n`,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    FakePeerConnection.instances = [];
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("polite: rolls its pending offer back instead of failing setRemoteDescription, answers, then re-offers", async () => {
    const { connections, peer, pc, sent, errors, deliver } = harness(POLITE_SELF);
    pc.rejectOfferOverLocalOffer = true;
    expect(peer.polite).toBe(true);
    pc.onnegotiationneeded?.(new Event("negotiationneeded"));
    await vi.waitFor(() => expect(sent.map((d) => d.type)).toEqual(["offer"]));
    expect(pc.signalingState).toBe("have-local-offer");

    await deliver({ description: remoteOffer() });

    expect(errors).toEqual([]);
    expect(pc.operations).toEqual(["local-offer", "rollback", "remote-offer", "local-answer", "local-offer"]);
    await vi.waitFor(() => expect(sent.map((d) => d.type)).toEqual(["offer", "answer", "offer"]));
    expect(pc.signalingState).toBe("have-local-offer");
    expect(peer.ignoreOffer).toBe(false);
    connections.close();
  });

  it("polite: waits for an offer that is still being created before rolling it back", async () => {
    const { connections, pc, sent, errors, deliver } = harness(POLITE_SELF);
    pc.rejectOfferOverLocalOffer = true;
    pc.onnegotiationneeded?.(new Event("negotiationneeded"));
    // makingOffer is still true here: setLocalDescription has not settled yet.
    await deliver({ description: remoteOffer() });
    expect(errors).toEqual([]);
    expect(pc.operations.slice(0, 4)).toEqual(["local-offer", "rollback", "remote-offer", "local-answer"]);
    await vi.waitFor(() => expect(sent.at(-1)?.type).toBe("offer"));
    expect(sent.filter((d) => d.type === "answer")).toHaveLength(1);
    connections.close();
  });

  it("impolite: ignores a colliding offer without an error and keeps its own offer", async () => {
    const { connections, peer, pc, sent, errors, deliver } = harness(IMPOLITE_SELF);
    expect(peer.polite).toBe(false);
    pc.onnegotiationneeded?.(new Event("negotiationneeded"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await deliver({ description: remoteOffer() });
    // A candidate of the ignored offer is dropped quietly as well.
    await deliver({ candidate: { candidate: "candidate:1 1 udp 1 192.0.2.1 9 typ host", sdpMid: "0" } });
    expect(peer.ignoreOffer).toBe(true);
    expect(errors).toEqual([]);
    expect(pc.operations).toEqual(["local-offer"]);
    expect(pc.signalingState).toBe("have-local-offer");
    connections.close();
  });

  it("applies a candidate sent right behind its offer only after the offer", async () => {
    const { connections, pc, errors, deliver } = harness(POLITE_SELF);
    const offer = deliver({ description: remoteOffer() });
    const candidate = deliver({ candidate: { candidate: "candidate:1 1 udp 1 192.0.2.1 9 typ host", sdpMid: "0" } });
    await Promise.all([offer, candidate]);
    expect(errors).toEqual([]);
    expect(pc.operations).toEqual(["remote-offer", "local-answer"]);
    connections.close();
  });

  it("rolls back an unanswered offer with backoff and ignores its late answer", async () => {
    const { connections, pc, sent, errors, deliver } = harness(IMPOLITE_SELF);
    pc.onnegotiationneeded?.(new Event("negotiationneeded"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(OFFER_ANSWER_TIMEOUT_MS - 100);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(pc.operations).toEqual(["local-offer", "rollback", "local-offer"]);
    expect(sent).toHaveLength(2);

    // The second stall waits twice as long: no tight re-offer loop.
    await vi.advanceTimersByTimeAsync(OFFER_ANSWER_TIMEOUT_MS);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(OFFER_ANSWER_TIMEOUT_MS);
    expect(sent).toHaveLength(3);

    // An answer to the current offer settles negotiation; a stale one is ignored.
    await deliver({ description: { type: "answer", sdp: "v=0\r\na=ice-ufrag:remote1\r\n" } });
    expect(pc.signalingState).toBe("stable");
    await deliver({ description: { type: "answer", sdp: "v=0\r\na=ice-ufrag:remote1\r\n" } });
    expect(errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(OFFER_ANSWER_TIMEOUT_MS * 8);
    expect(sent).toHaveLength(3);
    connections.close();
  });

  it("polite: a rejected remote offer leaves no stale local offer and renegotiates", async () => {
    const { connections, pc, sent, errors, deliver } = harness(POLITE_SELF);
    pc.onnegotiationneeded?.(new Event("negotiationneeded"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const failing = vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(
      new DOMException("Failed to set remote offer sdp: Session error code: ERROR_CONTENT. "
        + "Session error description: " + "x".repeat(300) + " decisive-tail a=ice-pwd:secret", "OperationError"));
    await deliver({ description: remoteOffer() });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(pc.signalingState).toBe("have-local-offer");
    expect(pc.operations).toEqual(["local-offer", "rollback", "local-offer"]);
    const described = describeNegotiationError(errors[0]);
    expect(described.message).toContain("decisive-tail");
    expect(described.message).not.toContain("secret");
    connections.close();
  });

  it("coordinates tier restarts: polite restarts at once, impolite defers to a remote restart", async () => {
    const polite = harness(POLITE_SELF);
    const impolite = harness(IMPOLITE_SELF);
    // Establish a first remote ufrag so a later offer is recognised as a restart.
    await impolite.deliver({ description: remoteOffer("remote1") });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(polite.peer.iceTier).toBe(1);
    expect(polite.pc.restarts).toBe(1);
    expect(impolite.peer.iceTier).toBe(1);
    expect(impolite.pc.restarts).toBe(0);

    await impolite.deliver({ description: remoteOffer("remote2") });
    await vi.advanceTimersByTimeAsync(ICE_RESTART_GRACE_MS);
    expect(impolite.pc.restarts).toBe(0);

    // Without a remote restart the impolite side restarts after the grace period.
    await vi.advanceTimersByTimeAsync(5_000 - ICE_RESTART_GRACE_MS);
    expect(impolite.peer.iceTier).toBe(2);
    expect(impolite.pc.restarts).toBe(0);
    await vi.advanceTimersByTimeAsync(ICE_RESTART_GRACE_MS);
    expect(impolite.pc.restarts).toBe(1);
    expect(polite.errors).toEqual([]);
    expect(impolite.errors).toEqual([]);
    polite.connections.close();
    impolite.connections.close();
  });

  it("pulls an imminent tier forward when a remote ICE restart arrives", async () => {
    const { connections, peer, pc, deliver } = harness(IMPOLITE_SELF);
    await deliver({ description: remoteOffer("remote1") });
    await vi.advanceTimersByTimeAsync(4_000 - ICE_RESTART_GRACE_MS);
    expect(peer.iceTier).toBe(0);
    await deliver({ description: remoteOffer("remote2") });
    expect(peer.iceTier).toBe(1);
    expect(pc.configuration.iceServers).toHaveLength(2);
    expect(pc.restarts).toBe(0);
    connections.close();
  });
});
