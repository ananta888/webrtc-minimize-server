import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IceTierPolicy } from "./ice-policy";
import {
  classifySelectedIcePath,
  describeNegotiationError,
  establishedDtlsSetup,
  ICE_RECOVERY_BASE_MS,
  ICE_RESTART_GRACE_MS,
  isDtlsRoleConflict,
  OFFER_ANSWER_TIMEOUT_MS,
  PEER_RESET_ACK_TIMEOUT_MS,
  PEER_RESET_COOLDOWN_MS,
  PeerConnectionManager,
  pinDtlsSetup,
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

// The production error of the companion log, verbatim.
const SSL_ROLE_ERROR = "Failed to execute 'setLocalDescription' on 'RTCPeerConnection': Session error code: "
  + "ERROR_CONTENT. Session error description: Failed to apply the description for m= section with mid='0': "
  + "Failed to set SSL role for the transport..";

/**
 * Models libwebrtc's DTLS role bookkeeping: once an offer/answer exchange has
 * fixed this side as DTLS server (`passive`), an answer claiming `active` is
 * refused. createAnswer() returns the default `active`, which is what Chrome
 * generated after the explicit rollback in production.
 */
class DtlsFakePeerConnection extends FakePeerConnection {
  currentLocalDescription: RTCSessionDescriptionInit | null = null;
  currentRemoteDescription: RTCSessionDescriptionInit | null = null;
  dtlsSetup: "active" | "passive" | null = null;
  // A transport that already failed a role change refuses every answer.
  refuseEveryAnswer = false;

  establishAsOfferer(): void {
    this.currentLocalDescription = { type: "offer", sdp: "v=0\r\na=ice-ufrag:local0\r\na=setup:actpass\r\n" };
    this.currentRemoteDescription = { type: "answer", sdp: "v=0\r\na=ice-ufrag:remote1\r\na=setup:active\r\n" };
    this.dtlsSetup = "passive";
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0\r\na=ice-ufrag:answer\r\na=setup:active\r\n" };
  }

  override async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    const answering = description?.type === "answer" || (!description && this.signalingState === "have-remote-offer");
    if (!answering) return super.setLocalDescription(description);
    const sdp = description?.sdp ?? (await this.createAnswer()).sdp!;
    const setup = /^a=setup:(\w+)/m.exec(sdp)?.[1];
    if (this.refuseEveryAnswer || (this.dtlsSetup && setup !== this.dtlsSetup)) {
      throw new DOMException(SSL_ROLE_ERROR, "OperationError");
    }
    return super.setLocalDescription({ type: "answer", sdp });
  }
}

describe("DTLS role pinning", () => {
  it("derives the established role from the current descriptions and pins only resolved setup lines", () => {
    const offer = { type: "offer" as const, sdp: "v=0\r\na=setup:actpass\r\n" };
    expect(establishedDtlsSetup(offer, { type: "answer", sdp: "v=0\r\na=setup:active\r\n" })).toBe("passive");
    expect(establishedDtlsSetup(offer, { type: "answer", sdp: "v=0\r\na=setup:passive\r\n" })).toBe("active");
    expect(establishedDtlsSetup({ type: "answer", sdp: "a=setup:active\r\n" }, offer)).toBe("active");
    expect(establishedDtlsSetup(null, offer)).toBeNull();
    expect(establishedDtlsSetup(offer, null)).toBeNull();
    const answer = "v=0\r\nm=audio 9\r\na=setup:active\r\nm=video 9\r\na=setup:active\r\n";
    expect(pinDtlsSetup(answer, "passive")).toBe("v=0\r\nm=audio 9\r\na=setup:passive\r\nm=video 9\r\na=setup:passive\r\n");
    expect(pinDtlsSetup("a=setup:actpass\r\n", "passive")).toBe("a=setup:actpass\r\n");
    expect(isDtlsRoleConflict(new DOMException(SSL_ROLE_ERROR, "OperationError"))).toBe(true);
    expect(isDtlsRoleConflict(new DOMException("Failed to set remote offer sdp", "OperationError"))).toBe(false);
  });
});

describe("DTLS role conflict after a polite rollback", () => {
  const POLITE_SELF = "ffffffffffffffff";
  const IMPOLITE_REMOTE = "0000000000000001";

  function harness(options: { resetPeer?: boolean } = {}) {
    const sent: RTCSessionDescriptionInit[] = [];
    const errors: unknown[] = [];
    const resets: string[] = [];
    let connections: PeerConnectionManager;
    connections = new PeerConnectionManager(POLITE_SELF, { ...policy, peerRelayIceServers: [], infrastructureRelayIceServers: [] }, false, {
      signal: (_peerId, payload) => {
        const description = (payload as { description?: RTCSessionDescriptionInit }).description;
        if (description) sent.push({ type: description.type, sdp: description.sdp });
      },
      track: () => undefined,
      channel: () => undefined,
      state: () => undefined,
      negotiationError: (_peer, error) => errors.push(error),
      ...(options.resetPeer ? {
        resetPeer: (peerId: string) => {
          resets.push(peerId);
          connections.remove(peerId);
          connections.add(peerId, "Remote");
        },
      } : {}),
    });
    const first = connections.add(IMPOLITE_REMOTE, "Remote")!;
    const deliver = (payload: Record<string, unknown>) => connections.acceptSignal({
      type: "signal", from: IMPOLITE_REMOTE, fromName: "Remote", ...payload,
    });
    const current = () => connections.peers.get(IMPOLITE_REMOTE)!;
    const markers = () => sent.filter((d) => d.type === "rollback").length;
    return { connections, first, pc: first.pc as unknown as DtlsFakePeerConnection, sent, errors, resets, deliver, current, markers };
  }

  const remoteOffer = (ufrag: string): RTCSessionDescriptionInit => ({
    type: "offer", sdp: `v=0\r\na=ice-ufrag:${ufrag}\r\na=setup:actpass\r\n`,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    FakePeerConnection.instances = [];
    vi.stubGlobal("RTCPeerConnection", DtlsFakePeerConnection);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("answers a colliding remote offer with the established DTLS role instead of failing with 'Failed to set SSL role'", async () => {
    const { connections, pc, sent, errors, deliver, markers } = harness();
    pc.establishAsOfferer();
    pc.onnegotiationneeded?.(new Event("negotiationneeded"));
    await vi.waitFor(() => expect(sent.map((d) => d.type)).toEqual(["offer"]));

    await deliver({ description: remoteOffer("remote2") });

    expect(errors).toEqual([]);
    expect(pc.operations).toEqual(["local-offer", "rollback", "remote-offer", "local-answer", "local-offer"]);
    const answer = sent.find((d) => d.type === "answer")!;
    expect(answer.sdp).toContain("a=setup:passive");
    expect(answer.sdp).not.toContain("a=setup:active");
    expect(markers()).toBe(0);
    expect(FakePeerConnection.instances).toHaveLength(1);
    connections.close();
  });

  it("rebuilds the connection exactly once on a refused DTLS role, renegotiates on the new one and never loops", async () => {
    const { connections, first, pc, sent, errors, resets, deliver, current, markers } = harness({ resetPeer: true });
    pc.establishAsOfferer();
    pc.refuseEveryAnswer = true;
    pc.onnegotiationneeded?.(new Event("negotiationneeded"));
    await vi.waitFor(() => expect(sent.map((d) => d.type)).toEqual(["offer"]));

    await deliver({ description: remoteOffer("remote2") });

    expect(errors).toHaveLength(1);
    expect(isDtlsRoleConflict(errors[0])).toBe(true);
    expect(resets).toEqual([IMPOLITE_REMOTE]);
    expect(markers()).toBe(1);
    expect(sent.at(-1)?.type).toBe("rollback");
    expect(pc.connectionState).toBe("closed");
    // The broken transport is not renegotiated any more.
    expect(pc.operations).toEqual(["local-offer", "rollback", "remote-offer"]);
    const replacement = current();
    expect(replacement).not.toBe(first);

    // Signals the remote sent from its old connection before it saw our marker are dropped.
    await deliver({ description: remoteOffer("remote3") });
    await deliver({ candidate: { candidate: "candidate:1 1 udp 1 192.0.2.1 9 typ host", sdpMid: "0" } });
    const fresh = replacement.pc as unknown as DtlsFakePeerConnection;
    expect(fresh.operations).toEqual([]);

    // The acknowledgement ends the wait; the fresh connection negotiates exactly once.
    await deliver({ description: { type: "rollback" } });
    expect(markers()).toBe(1);
    await deliver({ description: remoteOffer("fresh1") });
    expect(fresh.operations).toEqual(["remote-offer", "local-answer"]);
    expect(sent.filter((d) => d.type === "answer")).toHaveLength(1);
    expect(errors).toHaveLength(1);

    // A second conflict inside the cooldown does not rebuild again and stops renegotiating.
    fresh.establishAsOfferer();
    fresh.refuseEveryAnswer = true;
    await deliver({ description: remoteOffer("fresh2") });
    expect(errors).toHaveLength(2);
    expect(resets).toHaveLength(1);
    expect(markers()).toBe(1);
    expect(fresh.signalingState).toBe("stable");
    const offersBefore = sent.filter((d) => d.type === "offer").length;
    fresh.onnegotiationneeded?.(new Event("negotiationneeded"));
    await vi.advanceTimersByTimeAsync(PEER_RESET_COOLDOWN_MS - 1_000);
    expect(resets).toHaveLength(1);
    expect(sent.filter((d) => d.type === "offer")).toHaveLength(offersBefore);
    expect(fresh.restarts).toBe(0);

    // After the cooldown the bounded recovery may rebuild once more, never in a tight loop.
    await vi.advanceTimersByTimeAsync(PEER_RESET_COOLDOWN_MS);
    expect(resets.length).toBeGreaterThanOrEqual(2);
    expect(resets.length).toBeLessThanOrEqual(3);
    connections.close();
  });

  it("follows a remote rebuild once, acknowledges it and ignores a late duplicate", async () => {
    const { connections, first, pc, sent, deliver, current, markers } = harness();
    pc.establishAsOfferer();
    await deliver({ description: { type: "rollback" } });
    expect(markers()).toBe(1);
    expect(pc.connectionState).toBe("closed");
    const replacement = current();
    expect(replacement).not.toBe(first);

    // The next remote signal already reaches the rebuilt connection.
    await deliver({ description: remoteOffer("fresh1") });
    expect((replacement.pc as unknown as DtlsFakePeerConnection).operations).toEqual(["remote-offer", "local-answer"]);

    // A duplicate marker within the cooldown neither rebuilds nor answers: no ping-pong.
    await deliver({ description: { type: "rollback" } });
    expect(markers()).toBe(1);
    expect(current()).toBe(replacement);
    expect(sent.filter((d) => d.type === "answer")).toHaveLength(1);
    connections.close();
  });

  it("treats a crossing rebuild request as the acknowledgement of its own", async () => {
    const { connections, pc, sent, deliver, current, markers } = harness();
    pc.establishAsOfferer();
    pc.refuseEveryAnswer = true;
    await deliver({ description: remoteOffer("remote2") });
    expect(markers()).toBe(1);
    const replacement = current();
    await deliver({ description: { type: "rollback" } });
    expect(markers()).toBe(1);
    expect(current()).toBe(replacement);
    expect(sent.filter((d) => d.type === "rollback")).toHaveLength(1);
    connections.close();
  });

  it("stops waiting for an acknowledgement a peer without rebuild support never sends", async () => {
    const { connections, pc, deliver, current } = harness();
    pc.establishAsOfferer();
    pc.refuseEveryAnswer = true;
    await deliver({ description: remoteOffer("remote2") });
    const fresh = current().pc as unknown as DtlsFakePeerConnection;
    await deliver({ description: remoteOffer("old") });
    expect(fresh.operations).toEqual([]);
    await vi.advanceTimersByTimeAsync(PEER_RESET_ACK_TIMEOUT_MS);
    await deliver({ description: remoteOffer("next") });
    expect(fresh.operations).toEqual(["remote-offer", "local-answer"]);
    connections.close();
  });
});

describe("glare discipline and signaling-coupled ICE recovery", () => {
  const POLITE_SELF = "ffffffffffffffff";
  const REMOTE = "0000000000000001";

  function harness(icePolicy: IceTierPolicy) {
    const sent: RTCSessionDescriptionInit[] = [];
    const errors: unknown[] = [];
    const connections = new PeerConnectionManager(POLITE_SELF, icePolicy, false, {
      signal: (_peerId, payload) => {
        const description = (payload as { description?: RTCSessionDescriptionInit }).description;
        if (description) sent.push({ type: description.type, sdp: description.sdp });
      },
      track: () => undefined,
      channel: () => undefined,
      state: () => undefined,
      negotiationError: (_peer, error) => errors.push(error),
    });
    const peer = connections.add(REMOTE, "Remote")!;
    const deliver = (payload: Record<string, unknown>) => connections.acceptSignal({
      type: "signal", from: REMOTE, fromName: "Remote", ...payload,
    });
    return { connections, peer, pc: peer.pc as unknown as DtlsFakePeerConnection, sent, errors, deliver };
  }

  const answerFor = (ufrag: string): RTCSessionDescriptionInit => ({ type: "answer", sdp: `v=0\r\na=ice-ufrag:${ufrag}\r\n` });

  beforeEach(() => {
    vi.useFakeTimers();
    FakePeerConnection.instances = [];
    vi.stubGlobal("RTCPeerConnection", DtlsFakePeerConnection);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves repeated collisions with one answer and one re-offer each and ends stable", async () => {
    const { connections, pc, sent, errors, deliver } = harness(policy);
    pc.establishAsOfferer();
    pc.onnegotiationneeded?.(new Event("negotiationneeded"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    for (let round = 1; round <= 3; round += 1) {
      await deliver({ description: { type: "offer", sdp: `v=0\r\na=ice-ufrag:remote1\r\na=setup:actpass\r\n` } });
      await vi.waitFor(() => expect(sent.filter((d) => d.type === "offer")).toHaveLength(round + 1));
      expect(sent.filter((d) => d.type === "answer")).toHaveLength(round);
    }
    expect(errors).toEqual([]);
    expect(sent.every((d) => d.type !== "answer" || d.sdp!.includes("a=setup:passive"))).toBe(true);
    await deliver({ description: answerFor("remote1") });
    expect(pc.signalingState).toBe("stable");
    await vi.advanceTimersByTimeAsync(OFFER_ANSWER_TIMEOUT_MS * 8);
    expect(sent.filter((d) => d.type === "offer")).toHaveLength(4);
    connections.close();
  });

  it("does not restart ICE for recovery while a local offer is open, and does once signaling is stable", async () => {
    const { connections, pc, sent, deliver } = harness({ ...policy, peerRelayIceServers: [], infrastructureRelayIceServers: [] });
    pc.onnegotiationneeded?.(new Event("negotiationneeded"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(pc.signalingState).toBe("have-local-offer");

    await vi.advanceTimersByTimeAsync(ICE_RECOVERY_BASE_MS);
    expect(pc.signalingState).toBe("have-local-offer");
    expect(pc.restarts).toBe(0);
    await vi.advanceTimersByTimeAsync(ICE_RECOVERY_BASE_MS);
    expect(pc.restarts).toBe(0);

    await deliver({ description: answerFor("remote1") });
    expect(pc.signalingState).toBe("stable");
    await vi.advanceTimersByTimeAsync(ICE_RECOVERY_BASE_MS);
    expect(pc.restarts).toBe(1);
    connections.close();
  });

  it("defers a tier-step ICE restart until the open offer is answered", async () => {
    const { connections, peer, pc, sent, deliver } = harness(policy);
    pc.onnegotiationneeded?.(new Event("negotiationneeded"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(peer.iceTier).toBe(1);
    expect(pc.restarts).toBe(0);
    await deliver({ description: answerFor("remote1") });
    expect(pc.restarts).toBe(1);
    connections.close();
  });
});
