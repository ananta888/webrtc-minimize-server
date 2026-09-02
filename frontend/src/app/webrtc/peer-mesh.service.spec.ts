import { signal } from "@angular/core";
import { describe, expect, it, vi } from "vitest";

import { QualitySettings } from "./media-optimization-policy";
import { PeerMeshService } from "./peer-mesh.service";
import { ReceiveQualityProfile, isReceiveQualityProfile } from "./receive-quality-policy";

function createService(initialProfile: ReceiveQualityProfile = "auto") {
  const profile = signal<ReceiveQualityProfile>(initialProfile);
  const subscriptionIntents = vi.fn(() => true);
  const mediaAgents = {
    status: signal("unavailable"),
    primaryAgentId: signal(""),
    routeEpoch: signal(0),
    assignedAgentId: () => "",
    qualityTarget: () => null,
    setSubscriptionIntent: subscriptionIntents,
  };
  const mediaStrategy = {
    optimizationMode: signal("auto"),
    prioritizeVideo: (_source: string, quality: QualitySettings) => quality,
    priority: () => "medium",
    senderPolicy: () => ({ priority: "medium", maxBitrate: 48_000 }),
  };
  const receiveQuality = {
    profile: profile.asReadonly(),
    setProfile: (value: unknown) => {
      if (!isReceiveQualityProfile(value)) return false;
      profile.set(value);
      return true;
    },
  };
  const service = new PeerMeshService(
    {} as never,
    { activePeerIds: signal<readonly string[]>([]) } as never,
    mediaStrategy as never,
    mediaAgents as never,
    receiveQuality as never,
  );
  return { service, profile, subscriptionIntents };
}

describe("PeerMeshService media-agent fallback", () => {
  it("retires direct SFrame per acknowledged subscriber instead of waiting for the whole room", () => {
    const mediaAgents = {
      assignedAgentId: () => "owner-edge",
      routeEpoch: () => 7,
      routeReady: () => true,
    };
    const service = new PeerMeshService(
      {} as never,
      {} as never,
      {} as never,
      mediaAgents as never,
      { profile: () => "auto" } as never,
    );
    const internals = service as unknown as {
      ownId: string;
      mediaE2ee: { mode: string };
      connections: { peers: Map<string, object> };
      agentMediaKeys: Map<string, object>;
      agentSubscriptionReady: Map<string, Set<string>>;
      shouldSend(publication: object, targetPeerId: string): boolean;
    };
    internals.ownId = "0123456789abcdef";
    internals.mediaE2ee = { mode: "required" };
    internals.connections = {
      peers: new Map([
        ["1111111111111111", {}],
        ["2222222222222222", {}],
      ]),
    };
    internals.agentMediaKeys.set("camera-track", {
      active: true,
      agentId: "owner-edge",
      routeEpoch: 7,
    });
    internals.agentSubscriptionReady.set("camera-track", new Set(["1111111111111111"]));
    const publication = { id: "camera-track", local: true };

    expect(internals.shouldSend(publication, "1111111111111111")).toBe(false);
    expect(internals.shouldSend(publication, "2222222222222222")).toBe(true);
  });

  it("applies each requested direct receive ceiling only to that peer sender", async () => {
    const { service } = createService();
    const applied: Array<{ peerId: string; quality: QualitySettings }> = [];
    const peer = (id: string) => ({
      id,
      linkClass: "good",
      reportedLinkClass: "good",
      senders: new Map([["camera-track", { track: { kind: "video" } }]]),
      appliedTiers: new Map(),
    });
    const lowPeer = peer("1111111111111111");
    const highPeer = peer("2222222222222222");
    const internals = service as unknown as {
      ownId: string;
      connections: { peers: Map<string, ReturnType<typeof peer>> };
      publications: Map<string, object>;
      requestedReceiveProfiles: Map<string, ReceiveQualityProfile>;
      quality: {
        applyVideo(peerState: ReturnType<typeof peer>, publicationId: string, sender: object, source: string, quality: QualitySettings): Promise<"available">;
      };
      applyQualityPolicies(force?: boolean): Promise<void>;
    };
    internals.ownId = "0123456789abcdef";
    internals.connections = { peers: new Map([[lowPeer.id, lowPeer], [highPeer.id, highPeer]]) };
    internals.publications.set("camera-track", {
      id: "camera-track",
      rootPeerId: internals.ownId,
      rootName: "Publisher",
      source: "camera",
      stream: {},
      track: { kind: "video" },
      local: true,
      inboundPeerId: "",
    });
    internals.requestedReceiveProfiles.set(lowPeer.id, "low");
    internals.requestedReceiveProfiles.set(highPeer.id, "high");
    internals.quality = {
      applyVideo: async (peerState, _publicationId, _sender, _source, quality) => {
        applied.push({ peerId: peerState.id, quality });
        return "available";
      },
    };
    service.participantCount.set(3);

    await internals.applyQualityPolicies(true);

    expect(applied.find(({ peerId }) => peerId === lowPeer.id)?.quality).toMatchObject({
      tier: "thumbnail",
      maxBitrate: 120_000,
      maxFramerate: 6,
      scaleResolutionDownBy: 4,
    });
    expect(applied.find(({ peerId }) => peerId === highPeer.id)?.quality).toMatchObject({
      tier: "focus",
      maxBitrate: 1_200_000,
      maxFramerate: 24,
      scaleResolutionDownBy: 1,
    });
  });

  it("uses the same local profile for camera agent layers and audio-only subscriptions", () => {
    const { service, profile, subscriptionIntents } = createService("low");
    const internals = service as unknown as {
      ownId: string;
      descriptors: Map<string, { rootPeerId: string; rootName: string; source: string }>;
    };
    internals.ownId = "0123456789abcdef";
    internals.descriptors.set("remote-camera", { rootPeerId: "1111111111111111", rootName: "Remote", source: "camera" });
    internals.descriptors.set("remote-screen", { rootPeerId: "1111111111111111", rootName: "Remote", source: "screen" });
    internals.descriptors.set("remote-audio", { rootPeerId: "1111111111111111", rootName: "Remote", source: "microphone" });
    service.remoteMedia.set([{
      key: "remote-camera",
      peerId: "1111111111111111",
      peerName: "Remote",
      transportPeerId: "1111111111111111",
      source: "camera",
      stream: {} as MediaStream,
      kind: "video",
    }]);
    service.participantCount.set(2);

    service.refreshAgentSubscriptionIntents();
    expect(subscriptionIntents).toHaveBeenCalledWith(expect.objectContaining({
      publicationId: "remote-camera",
      enabled: true,
      preferredLayer: "low",
      maximumLayer: "low",
    }));

    subscriptionIntents.mockClear();
    profile.set("audio-only");
    service.refreshAgentSubscriptionIntents();
    expect(subscriptionIntents).toHaveBeenCalledWith(expect.objectContaining({
      publicationId: "remote-camera",
      enabled: false,
    }));
    expect(subscriptionIntents).toHaveBeenCalledWith(expect.objectContaining({
      publicationId: "remote-screen",
      enabled: false,
      preferredLayer: "single",
    }));
    expect(subscriptionIntents).toHaveBeenCalledWith(expect.objectContaining({
      publicationId: "remote-audio",
      enabled: true,
      preferredLayer: "audio",
    }));
  });

  it("broadcasts a changed receive profile immediately without requesting capture", () => {
    const { service } = createService();
    const sends = [vi.fn(), vi.fn()];
    const peers = new Map(sends.map((send, index) => [`peer-${index}`, {
      id: `peer-${index}`,
      channels: new Map([["control", { readyState: "open", bufferedAmount: 0, send }]]),
    }]));
    const internals = service as unknown as {
      connections: { peers: typeof peers };
      applyQualityPolicies(force?: boolean): Promise<void>;
    };
    internals.connections = { peers };
    internals.applyQualityPolicies = vi.fn(async () => undefined);
    service.refreshAgentSubscriptionIntents = vi.fn();

    expect(service.setReceiveQualityProfile("medium")).toBe(true);
    expect(sends.every((send) => JSON.parse(String(send.mock.calls[0][0])).profile === "medium")).toBe(true);
    expect(service.setReceiveQualityProfile("unbounded")).toBe(false);
  });

  it("locally suppresses audio-only video but preserves a shared trusted-relay input", () => {
    const { service } = createService();
    const track = { kind: "video", enabled: true };
    const internals = service as unknown as {
      ownId: string;
      publications: Map<string, object>;
      routeChildren(rootPeerId: string, parentPeerId: string): ReadonlySet<string>;
    };
    internals.ownId = "0123456789abcdef";
    internals.publications.set("remote-camera", {
      id: "remote-camera",
      rootPeerId: "1111111111111111",
      rootName: "Remote",
      source: "camera",
      stream: {},
      track,
      local: false,
      inboundPeerId: "1111111111111111",
    });

    expect(service.setReceiveQualityProfile("audio-only")).toBe(true);
    expect(track.enabled).toBe(false);
    expect(service.setReceiveQualityProfile("high")).toBe(true);
    expect(track.enabled).toBe(true);

    internals.routeChildren = () => new Set(["2222222222222222"]);
    expect(service.setReceiveQualityProfile("audio-only")).toBe(true);
    expect(track.enabled).toBe(true);
  });
});
