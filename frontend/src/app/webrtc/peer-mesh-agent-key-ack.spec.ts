import { signal } from "@angular/core";
import { describe, expect, it, vi } from "vitest";
import { createMediaAgentKeyAck, createMediaAgentKeyMessage } from "./media-agent-e2ee-protocol";
import { PeerMeshService } from "./peer-mesh.service";

function fixture() {
  const ownId = "1111111111111111", allowed = "2222222222222222", denied = "3333333333333333";
  const baseKey = new Uint8Array(16).fill(9);
  const message = createMediaAgentKeyMessage({
    publicationId: "screen", senderPeerId: ownId, agentId: "agent-a",
    membershipEpoch: 3, routeEpoch: 2, keyId: "0000000000000001", baseKey,
  });
  const state = {
    contextId: "agent-out:screen:agent-a:2", agentId: "agent-a", routeEpoch: 2, message,
    baseKey, acknowledgedPeerIds: new Set<string>(), retries: 0, timer: null as ReturnType<typeof setTimeout> | null, active: false,
  };
  const mesh = Object.assign(Object.create(PeerMeshService.prototype), {
    ownId, membershipEpoch: signal(3), membershipStable: true,
    connections: { peers: new Map([[allowed, { id: allowed }], [denied, { id: denied }]]) },
    publications: new Map([["screen", { id: "screen", local: true, source: "screen" }]]),
    agentMediaKeys: new Map([["screen", state]]),
    mediaAgents: { routeEpoch: () => 2, deactivatePublication: vi.fn(), assignedAgentId: () => "agent-a" },
    mediaE2eeController: { clearContext: vi.fn() },
    activeSenderMediaContexts: new Set<string>(),
    agentSubscriptionReady: new Set<string>(),
    machineReceive: { mediaAllowed: vi.fn((peerId: string) => peerId !== denied) },
    sendOverlayData: vi.fn(async () => true),
  });
  return { mesh, state, allowed, denied, ack: createMediaAgentKeyAck(message), baseKey };
}

describe("agent media key receive scope", () => {
  it("does not overlay an agent key to a machine peer without receive scope", async () => {
    const f = fixture();
    await f.mesh.sendAgentMediaKey(f.state);
    expect(f.mesh.machineReceive.mediaAllowed).toHaveBeenCalledWith(f.denied, f.mesh.ownId, "screen", "screen");
    const overlayPeers = f.mesh.sendOverlayData.mock.calls.map((call: unknown[]) => call[0]);
    expect(overlayPeers).toEqual([f.allowed]);
    expect(overlayPeers).not.toContain(f.denied);
    expect(f.mesh.sendOverlayData.mock.calls[0][2]).toBe("rekey");
  });

  it("wipes the agent key on revoke and ignores a late ACK", async () => {
    const f = fixture();
    f.mesh.clearAgentPublicationKey("screen");
    expect(f.mesh.agentMediaKeys.size).toBe(0);
    expect([...f.baseKey]).toEqual(Array(16).fill(0));
    await f.mesh.sendAgentMediaKey(f.state);
    expect(f.mesh.sendOverlayData).not.toHaveBeenCalled();
    f.mesh.membershipEpoch.set(4);
    const incoming = { ...f.ack, membershipEpoch: 3 };
    await f.mesh.acceptMediaE2eeEnvelope?.(f.allowed, new TextEncoder().encode(JSON.stringify(incoming)));
    expect(f.mesh.sendOverlayData).not.toHaveBeenCalled();
    expect(f.mesh.agentMediaKeys.size).toBe(0);
  });
});
