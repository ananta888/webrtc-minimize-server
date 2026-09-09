import { signal } from "@angular/core";
import { describe, expect, it, vi } from "vitest";
import { createMediaKeyAck, createMediaKeyMessage } from "./media-e2ee-protocol";
import { PeerMeshService } from "./peer-mesh.service";

// Exercise the existing key-message boundary without creating sockets or
// substituting its parser, membership check, ACK matching or key cleanup.
function fixture() {
  const ownId = "1111111111111111", peerId = "2222222222222222";
  const baseKey = new Uint8Array(16).fill(7), contextId = `out:screen:${peerId}`;
  const message = createMediaKeyMessage({ publicationId: "screen", senderPeerId: ownId,
    membershipEpoch: 3, keyId: "0000000000000001", baseKey });
  const pending = { contextId, targetPeerId: peerId, baseKey, message, timer: null, retries: 0 };
  const controller = { supported: true, setSenderKey: vi.fn(() => true), setReceiverKey: vi.fn(() => true) };
  const mesh = Object.assign(Object.create(PeerMeshService.prototype), {
    ownId, membershipEpoch: signal(3), membershipStable: true,
    mediaE2ee: { mode: "required" }, optimization: { dataOverlayEnabled: true }, mediaTransformFailed: false,
    mediaE2eeController: controller, mediaE2eeState: signal("pending"),
    connections: { peers: new Map([[peerId, { id: peerId }]]) },
    pendingMediaKeys: new Map([[contextId, pending]]), agentMediaKeys: new Map(),
    activeSenderMediaContexts: new Set(), activeReceiverMediaContexts: new Set(),
    descriptors: new Map([["screen", { source: "screen" }]]),
    machineReceive: { mediaAllowed: vi.fn(() => true) }, sendOverlayData: vi.fn(async () => true),
  });
  const deliver = (value: object, origin = peerId) => mesh.acceptMediaE2eeEnvelope(
    origin, new TextEncoder().encode(JSON.stringify(value)),
  );
  return { mesh, controller, pending, message, ack: createMediaKeyAck(message), deliver, peerId, contextId };
}

describe("exact SFrame key acknowledgement", () => {
  it("installs no sender key before an exact ACK and consumes that ACK only once", async () => {
    const f = fixture();
    f.mesh.refreshMediaE2eeState();
    expect(f.mesh.mediaE2eeState()).toBe("pending");
    expect(f.controller.setSenderKey).not.toHaveBeenCalled();
    await f.deliver(f.ack);
    expect(f.controller.setSenderKey).toHaveBeenCalledOnce();
    expect(f.mesh.activeSenderMediaContexts).toEqual(new Set([f.contextId]));
    expect(f.mesh.mediaE2eeState()).toBe("active");
    expect([...f.pending.baseKey]).toEqual(Array(16).fill(0));
    expect(f.mesh.pendingMediaKeys.size).toBe(0);
    await f.deliver(f.ack); expect(f.controller.setSenderKey).toHaveBeenCalledOnce();
  });

  it.each([
    { version: 1 }, { membershipEpoch: 2 }, { senderPeerId: "3333333333333333" },
    { publicationId: "other" }, { keyId: "0000000000000002" },
    { frameEnvelope: "unknown" }, { extra: true },
  ])("does not activate or consume a mismatched ACK %j", async mutation => {
    const f = fixture(); await f.deliver({ ...f.ack, ...mutation });
    expect(f.controller.setSenderKey).not.toHaveBeenCalled();
    expect(f.mesh.pendingMediaKeys.size).toBe(1);
    expect(f.mesh.activeSenderMediaContexts.size).toBe(0);
  });

  it("rejects another origin and unstable or superseded membership", async () => {
    const f = fixture(); await f.deliver(f.ack, "3333333333333333");
    f.mesh.membershipStable = false; await f.deliver(f.ack);
    f.mesh.membershipStable = true; f.mesh.membershipEpoch.set(4); await f.deliver(f.ack);
    expect(f.controller.setSenderKey).not.toHaveBeenCalled();
  });

  it("never ACKs a receive key forbidden by the exact publisher/source policy", async () => {
    const f = fixture();
    const incoming = { ...f.message, senderPeerId: f.peerId };
    f.mesh.machineReceive.mediaAllowed.mockReturnValue(false);
    await f.deliver(incoming);
    expect(f.mesh.machineReceive.mediaAllowed).toHaveBeenCalledWith(f.mesh.ownId, f.peerId, "screen", "screen");
    expect(f.controller.setReceiverKey).not.toHaveBeenCalled();
    expect(f.mesh.sendOverlayData).not.toHaveBeenCalled();
    expect(f.mesh.activeReceiverMediaContexts.size).toBe(0);
  });

  it("does not ACK unsupported transforms or failed key installation", async () => {
    const f = fixture(), incoming = { ...f.message, senderPeerId: f.peerId };
    f.controller.supported = false; await f.deliver(incoming);
    expect(f.controller.setReceiverKey).not.toHaveBeenCalled();
    f.controller.supported = true; f.controller.setReceiverKey.mockReturnValue(false);
    await f.deliver(incoming);
    expect(f.mesh.sendOverlayData).not.toHaveBeenCalled();
    expect(f.mesh.mediaE2eeState()).toBe("unsupported");
    expect(f.mesh.activeReceiverMediaContexts.size).toBe(0);
  });
});
