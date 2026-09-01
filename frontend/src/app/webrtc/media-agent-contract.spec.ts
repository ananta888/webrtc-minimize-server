import { describe, expect, it } from "vitest";

import {
  validateMediaAgentRouteState,
  validateMediaAgentSignal,
  validateMediaAgentSubscriptionState,
  validateMediaAgentTakeoverRequest,
  validateMediaAgentTrackState,
} from "./media-agent-contract";

const ownerPeerId = "0123456789abcdef";
const guestPeerId = "fedcba9876543210";
const members = new Set([ownerPeerId, guestPeerId]);
const now = 1_800_000_000_000;

function route() {
  return {
    version: 3,
    type: "media-agent-state",
    enabled: true,
    membershipEpoch: 4,
    routeEpoch: 7,
    leaseExpiresAt: now + 30_000,
    primary: { id: "owner-edge", ownerPeerId, creatorPreferred: true },
    standbys: [{ id: "guest-edge", ownerPeerId: guestPeerId, creatorPreferred: false }],
    forwarderIds: ["owner-edge", "guest-edge"],
    publisherAssignments: [
      { peerId: ownerPeerId, agentId: "owner-edge" },
      { peerId: guestPeerId, agentId: "guest-edge" },
    ],
    subscriberAssignments: [
      { peerId: ownerPeerId, agentId: "owner-edge" },
      { peerId: guestPeerId, agentId: "guest-edge" },
    ],
    federationLinks: [{
      linkId: "abcdefghijklmnopqrstuv",
      leftAgentId: "guest-edge",
      rightAgentId: "owner-edge",
      initiatorAgentId: "guest-edge",
      readyAgentIds: [],
    }],
    federationRoutes: [{
      publisherPeerId: ownerPeerId,
      sourceAgentId: "owner-edge",
      maximumHops: 2,
      edges: [{
        linkId: "abcdefghijklmnopqrstuv",
        fromAgentId: "owner-edge",
        toAgentId: "guest-edge",
      }],
    }],
    readiness: [
      { agentId: "owner-edge", readyPeerIds: [ownerPeerId] },
      { agentId: "guest-edge", readyPeerIds: [] },
    ],
  };
}

describe("browser media-agent server contracts", () => {
  it("accepts only fresh, member-bound and monotone route leases", () => {
    expect(validateMediaAgentRouteState(route(), members, 4, 6, now)).toMatchObject({
      routeEpoch: 7,
      primary: { id: "owner-edge", creatorPreferred: true },
    });
    expect(validateMediaAgentRouteState({ ...route(), extra: true }, members, 4, 6, now)).toBeNull();
    expect(validateMediaAgentRouteState({ ...route(), membershipEpoch: 3 }, members, 4, 6, now)).toBeNull();
    expect(validateMediaAgentRouteState({ ...route(), routeEpoch: 5 }, members, 4, 6, now)).toBeNull();
    expect(validateMediaAgentRouteState({
      ...route(),
      primary: { id: "owner-edge", ownerPeerId: "aaaaaaaaaaaaaaaa", creatorPreferred: true },
    }, members, 4, 6, now)).toBeNull();
    expect(validateMediaAgentRouteState({
      ...route(),
      federationRoutes: [{
        ...route().federationRoutes[0],
        edges: [{
          linkId: "abcdefghijklmnopqrstuv",
          fromAgentId: "owner-edge",
          toAgentId: "unleased-edge",
        }],
      }],
    }, members, 4, 6, now)).toBeNull();
  });

  it("rejects unknown takeover, track and subscription fields", () => {
    const takeover = {
      version: 1,
      type: "media-agent-takeover-request",
      requestId: "a".repeat(32),
      agentId: "guest-edge",
      expiresAt: now + 20_000,
      creatorPreferred: false,
    };
    expect(validateMediaAgentTakeoverRequest(takeover, now)).toEqual(takeover);
    expect(validateMediaAgentTakeoverRequest({ ...takeover, roomAuthority: true }, now)).toBeNull();

    const track = {
      version: 2,
      type: "media-agent-track-state",
      agentId: "owner-edge",
      routeEpoch: 7,
      peerId: ownerPeerId,
      publicationId: "camera-track",
      source: "camera",
      layer: "high",
      rid: "f",
      active: true,
    };
    expect(validateMediaAgentTrackState(track)).toEqual(track);
    expect(validateMediaAgentTrackState({ ...track, baseKey: "forbidden" })).toBeNull();

    const subscription = {
      version: 2,
      type: "media-agent-subscription-state",
      agentId: "owner-edge",
      routeEpoch: 7,
      publicationId: "camera-track",
      subscriberPeerId: guestPeerId,
      selectedLayer: "medium",
      revision: 4,
      ready: true,
    };
    expect(validateMediaAgentSubscriptionState(subscription)).toEqual(subscription);
    expect(validateMediaAgentSubscriptionState({ ...subscription, membership: "invented" })).toBeNull();
  });

  it("accepts only exact, bounded and versioned agent signaling", () => {
    const description = {
      version: 1,
      type: "media-agent-signal",
      agentId: "owner-edge",
      roomId: "room-123456",
      routeEpoch: 7,
      description: { type: "answer", sdp: "v=0\r\n" },
    };
    expect(validateMediaAgentSignal(description)).toEqual(description);
    expect(validateMediaAgentSignal({ ...description, token: "forbidden" })).toBeNull();
    expect(validateMediaAgentSignal({ ...description, version: 2 })).toBeNull();
    expect(validateMediaAgentSignal({
      version: 1,
      type: "media-agent-signal",
      agentId: "owner-edge",
      roomId: "room-123456",
      routeEpoch: 7,
      candidate: { candidate: "candidate:1", address: "not-an-authorized-field" },
    })).toBeNull();
  });
});
