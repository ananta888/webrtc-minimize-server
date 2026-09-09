import { signal } from "@angular/core";
import { describe, expect, it, vi } from "vitest";
import { PeerMeshService } from "./peer-mesh.service";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const peerId = "bbbbbbbbbbbbbbbb", peer = { id: peerId, channels: new Map() };
  const mesh = Object.assign(Object.create(PeerMeshService.prototype), {
    ownId: "aaaaaaaaaaaaaaaa", membershipEpoch: signal(1), routeEpoch: signal(1), overlayGeneration: 1,
    connections: { peers: new Map([[peerId, peer]]) }, optimization: { dataOverlayEnabled: true },
    machineReceive: { isMachine: () => false }, topology: { path: () => null },
    overlayInitialization: Promise.resolve(), overlayMode: signal("unavailable"),
    overlay: { encrypt: vi.fn(), receive: vi.fn(), setPeerKey: vi.fn(async () => {}) },
    updateOverlayAvailability: vi.fn(), provisionMediaKeysForPeer: vi.fn(), addChat: vi.fn(),
    queueOverlayPacket: vi.fn(() => true), sendOverlayAck: vi.fn(), acceptMediaE2eeEnvelope: vi.fn(),
    overlayDeliveries: signal([]), overlaySerial: 0,
  });
  return { mesh, peerId, peer };
}

describe("mesh revalidates overlay authority after asynchronous work", () => {
  it.each(["epoch", "generation", "peer", "identity"])("does not import a queued key after %s changes", async change => {
    const { mesh, peerId } = fixture(), wait = deferred<void>(); mesh.overlayInitialization = wait.promise;
    const pending = mesh.acceptOverlayKey({ from: peerId, membershipEpoch: 1, key: {} });
    invalidate(mesh, peerId, change); wait.resolve(); await pending;
    expect(mesh.overlay.setPeerKey).not.toHaveBeenCalled();
    expect(mesh.provisionMediaKeysForPeer).not.toHaveBeenCalled();
  });

  it("does not provision keys after membership changes during import", async () => {
    const { mesh, peerId } = fixture(), wait = deferred<void>();
    mesh.overlay.setPeerKey.mockReturnValue(wait.promise);
    const pending = mesh.acceptOverlayKey({ from: peerId, membershipEpoch: 1, key: {} });
    await Promise.resolve(); expect(mesh.overlay.setPeerKey).toHaveBeenCalledOnce();
    mesh.membershipEpoch.set(2); wait.resolve(); await pending;
    expect(mesh.provisionMediaKeysForPeer).not.toHaveBeenCalled();
    expect(mesh.updateOverlayAvailability).not.toHaveBeenCalled();
  });

  it.each(["epoch", "route", "generation", "peer", "identity"])("does not queue ciphertext after %s changes", async change => {
    const { mesh, peerId } = fixture(), wait = deferred<unknown[]>();
    mesh.overlay.encrypt.mockReturnValue(wait.promise);
    const pending = mesh.sendOverlayData(peerId, new Uint8Array([1]), "rekey");
    invalidate(mesh, peerId, change); wait.resolve([{}]);
    expect(await pending).toBe(false); expect(mesh.queueOverlayPacket).not.toHaveBeenCalled();
  });

  it.each(["epoch", "route", "generation", "peer", "identity"])("wipes late plaintext instead of ACK/delivery after %s changes", async change => {
    const { mesh, peerId, peer } = fixture(), wait = deferred<object>(), bytes = new Uint8Array([1, 2]);
    mesh.overlay.receive.mockReturnValue(wait.promise);
    const pending = mesh.acceptOverlayPacket(peer, "{}");
    invalidate(mesh, peerId, change);
    wait.resolve({ action: "delivered", originPeerId: peerId, packetId: "test", trafficClass: "rekey", data: bytes });
    await pending;
    expect([...bytes]).toEqual([0, 0]);
    expect(mesh.sendOverlayAck).not.toHaveBeenCalled();
    expect(mesh.acceptMediaE2eeEnvelope).not.toHaveBeenCalled();
    expect(mesh.overlayDeliveries()).toEqual([]);
  });

  it.each(["forward", "pending"])("suppresses stale %s actions", async action => {
    const { mesh, peerId, peer } = fixture(), wait = deferred<object>();
    mesh.overlay.receive.mockReturnValue(wait.promise);
    const pending = mesh.acceptOverlayPacket(peer, "{}");
    mesh.routeEpoch.set(2); wait.resolve({ action, nextPeerId: peerId, packet: {}, missing: [] }); await pending;
    expect(mesh.queueOverlayPacket).not.toHaveBeenCalled(); expect(mesh.sendOverlayAck).not.toHaveBeenCalled();
  });

  it("retains current key provisioning and encrypted send/receive", async () => {
    const { mesh, peerId, peer } = fixture();
    await mesh.acceptOverlayKey({ from: peerId, membershipEpoch: 1, key: {} });
    expect(mesh.provisionMediaKeysForPeer).toHaveBeenCalledWith(peerId);
    mesh.overlay.encrypt.mockResolvedValue([{}]);
    expect(await mesh.sendOverlayData(peerId, new Uint8Array([1]), "rekey")).toBe(true);
    const bytes = new Uint8Array([2]);
    mesh.overlay.receive.mockResolvedValue({ action: "delivered", originPeerId: peerId,
      packetId: "test", trafficClass: "rekey", data: bytes });
    await mesh.acceptOverlayPacket(peer, "{}");
    expect(mesh.acceptMediaE2eeEnvelope).toHaveBeenCalledWith(peerId, bytes);
  });
});

function invalidate(mesh: any, peerId: string, change: string) {
  if (change === "epoch") mesh.membershipEpoch.set(2);
  if (change === "route") mesh.routeEpoch.set(2);
  if (change === "generation") mesh.overlayGeneration++;
  if (change === "peer") mesh.connections.peers.set(peerId, { id: peerId, channels: new Map() });
  if (change === "identity") mesh.ownId = "cccccccccccccccc";
}
