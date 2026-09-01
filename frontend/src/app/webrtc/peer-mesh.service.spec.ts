import { describe, expect, it } from "vitest";

import { PeerMeshService } from "./peer-mesh.service";

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
});
