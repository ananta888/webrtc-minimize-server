import { describe, expect, it } from "vitest";

import { BoundedOverlayQueue, OpaqueDataOverlay, parseOverlayPacket } from "./opaque-data-overlay";

const alice = "aaaaaaaaaaaaaaaa";
const relay = "bbbbbbbbbbbbbbbb";
const bob = "cccccccccccccccc";

describe("opaque data overlay", () => {
  it("encrypts for the destination while an authorized relay only forwards ciphertext", async () => {
    const origin = new OpaqueDataOverlay();
    const destination = new OpaqueDataOverlay();
    const relayNode = new OpaqueDataOverlay();
    const originPublic = await origin.initialize(alice);
    const destinationPublic = await destination.initialize(bob);
    await relayNode.initialize(relay);
    await origin.setPeerKey(bob, destinationPublic);
    await destination.setPeerKey(alice, originPublic);
    const now = Date.now();
    const [packet] = await origin.encrypt(bob, new TextEncoder().encode("secret"), {
      membershipEpoch: 2,
      routeEpoch: 4,
      trafficClass: "event",
      path: [alice, relay, bob],
    }, now);
    expect(packet.ciphertext).not.toContain("secret");
    const context = { membershipEpoch: 2, routeEpoch: 4, memberPeerIds: new Set([alice, relay, bob]) };
    const forwarded = await relayNode.receive(packet, alice, context, now + 1);
    expect(forwarded.action).toBe("forward");
    if (forwarded.action !== "forward") throw new Error("expected forward");
    const delivered = await destination.receive(forwarded.packet, relay, context, now + 2);
    expect(delivered.action).toBe("delivered");
    if (delivered.action === "delivered") {
      expect(new TextDecoder().decode(delivered.data)).toBe("secret");
      expect(origin.resume(delivered.packetId, [])).toEqual([]);
    }
    expect((await relayNode.receive(packet, alice, context, now + 3))).toEqual({ action: "drop", reason: "replay" });
  });

  it("reports missing chunks and resumes only bounded requested indices", async () => {
    const origin = new OpaqueDataOverlay();
    const destination = new OpaqueDataOverlay();
    const originPublic = await origin.initialize(alice);
    const destinationPublic = await destination.initialize(bob);
    await origin.setPeerKey(bob, destinationPublic);
    await destination.setPeerKey(alice, originPublic);
    const now = Date.now();
    const packets = await origin.encrypt(bob, new Uint8Array(25 * 1024), {
      membershipEpoch: 1, routeEpoch: 1, trafficClass: "bulk", path: [alice, bob],
    }, now);
    expect(packets).toHaveLength(3);
    const context = { membershipEpoch: 1, routeEpoch: 1, memberPeerIds: new Set([alice, bob]) };
    const pending = await destination.receive(packets[2], alice, context, now + 1);
    expect(pending.action).toBe("pending");
    if (pending.action !== "pending") throw new Error("expected pending");
    expect(pending.missing).toEqual([0, 1]);
    expect(origin.resume(pending.packetId, pending.missing).map((packet) => packet.chunkIndex)).toEqual([0, 1]);
    expect(origin.resume(pending.packetId, [999])).toEqual([]);
  });

  it("rejects stale epochs, loops, unknown fields and digest changes", async () => {
    const origin = new OpaqueDataOverlay();
    const destination = new OpaqueDataOverlay();
    const originPublic = await origin.initialize(alice);
    const destinationPublic = await destination.initialize(bob);
    await origin.setPeerKey(bob, destinationPublic);
    await destination.setPeerKey(alice, originPublic);
    const now = Date.now();
    const [packet] = await origin.encrypt(bob, new Uint8Array([1, 2, 3]), {
      membershipEpoch: 1, routeEpoch: 1, trafficClass: "control", path: [alice, bob],
    }, now);
    expect(parseOverlayPacket({ ...packet, extra: true }, now + 1)).toBeNull();
    expect(parseOverlayPacket({ ...packet, path: [alice, alice, bob] }, now + 1)).toBeNull();
    expect((await destination.receive(packet, alice, {
      membershipEpoch: 2, routeEpoch: 1, memberPeerIds: new Set([alice, bob]),
    }, now + 1))).toEqual({ action: "drop", reason: "stale_epoch" });
    expect((await destination.receive({ ...packet, digest: "AAAAAAAAAAAAAAAAAAAAAA" }, alice, {
      membershipEpoch: 1, routeEpoch: 1, memberPeerIds: new Set([alice, bob]),
    }, now + 2))).toEqual({ action: "drop", reason: "digest_mismatch" });
  });

  it("prioritizes bounded queues and drops overflowing bulk traffic", () => {
    const queue = new BoundedOverlayQueue();
    for (let index = 0; index < 96; index += 1) expect(queue.enqueue("bulk", "x")).toBe(true);
    expect(queue.enqueue("bulk", "overflow")).toBe(false);
    expect(queue.enqueue("control", "important")).toBe(true);
    const sent: string[] = [];
    queue.flush((payload) => { sent.push(payload); return sent.length < 2; });
    expect(sent[0]).toBe("important");
  });
});
