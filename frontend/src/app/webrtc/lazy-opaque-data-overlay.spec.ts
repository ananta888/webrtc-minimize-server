import { afterEach, describe, expect, it, vi } from "vitest";
import { OpaqueDataOverlay } from "./opaque-data-overlay";
import { LazyOpaqueDataOverlay } from "./lazy-opaque-data-overlay";

const a = "aaaaaaaaaaaaaaaa", b = "bbbbbbbbbbbbbbbb";
const send = { membershipEpoch: 1, routeEpoch: 1, trafficClass: "rekey" as const, path: [a, b] };
const receive = { membershipEpoch: 1, routeEpoch: 1, memberPeerIds: new Set([a, b]) };
const module = { OpaqueDataOverlay };
afterEach(() => vi.restoreAllMocks());

describe("lazy overlay lifecycle", () => {
  it("closed probes, cleanup, invalid initialization and traffic never load crypto", async () => {
    const load = vi.fn(async () => module), overlay = new LazyOpaqueDataOverlay(load);
    expect(overlay.hasPeerKey(b)).toBe(false); expect(overlay.resume("missing", [])).toEqual([]);
    overlay.removePeer(b); overlay.destroy();
    await expect(overlay.initialize("invalid")).rejects.toThrow("invalid_own_peer");
    await expect(overlay.setPeerKey(b, {})).rejects.toThrow("overlay_key_unavailable");
    await expect(overlay.encrypt(b, new Uint8Array(), send)).rejects.toThrow("overlay_key_unavailable");
    expect((await overlay.receive({}, a, receive)).action).toBe("drop");
    expect(load).not.toHaveBeenCalled();
  });

  it("a delayed module cannot allocate an overlay after destroy", async () => {
    let release!: (value: typeof module) => void;
    const construct = vi.fn(() => new OpaqueDataOverlay());
    const overlay = new LazyOpaqueDataOverlay(() => new Promise(resolve => { release = resolve; }));
    const pending = overlay.initialize(a); overlay.destroy();
    release({ OpaqueDataOverlay: construct as unknown as typeof OpaqueDataOverlay });
    await expect(pending).rejects.toThrow("overlay_lifecycle_changed");
    expect(construct).not.toHaveBeenCalled();
  });

  it("a stale loader cannot replace the currently initialized implementation", async () => {
    let release!: (value: typeof module) => void;
    const load = vi.fn(async () => module).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const overlay = new LazyOpaqueDataOverlay(load), old = overlay.initialize(b);
    const currentKey = await overlay.initialize(a);
    release(module); await expect(old).rejects.toThrow("overlay_lifecycle_changed");
    const peer = new OpaqueDataOverlay(), peerKey = await peer.initialize(b);
    await overlay.setPeerKey(b, peerKey); await peer.setPeerKey(a, currentKey);
    const [packet] = await overlay.encrypt(b, new Uint8Array([7]), send);
    const result = await peer.receive(packet, a, receive);
    expect(result.action).toBe("delivered");
    if (result.action === "delivered") expect([...result.data]).toEqual([7]);
  });

  it("module load failure remains closed and permits a fresh explicit initialization", async () => {
    const load = vi.fn(async () => module).mockRejectedValueOnce(new Error("load_failed"));
    const overlay = new LazyOpaqueDataOverlay(load);
    await expect(overlay.initialize(a)).rejects.toThrow("load_failed");
    await expect(overlay.encrypt(b, new Uint8Array(), send)).rejects.toThrow("overlay_key_unavailable");
    expect((await overlay.initialize(a)).kty).toBe("EC");
    overlay.destroy(); expect(overlay.hasPeerKey(b)).toBe(false);
  });

  it("a late initialized key cannot return or destroy a replacement implementation", async () => {
    let ready!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { ready = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const original = OpaqueDataOverlay.prototype.initialize;
    vi.spyOn(OpaqueDataOverlay.prototype, "initialize").mockImplementationOnce(async function (this: OpaqueDataOverlay, id) {
      const key = await original.call(this, id); ready(); await wait; return key;
    });
    const overlay = new LazyOpaqueDataOverlay(async () => module), old = overlay.initialize(a);
    await entered;
    const current = await overlay.initialize(b); release();
    await expect(old).rejects.toThrow("overlay_lifecycle_changed");
    const other = new OpaqueDataOverlay(), key = await other.initialize(a);
    await overlay.setPeerKey(a, key); await other.setPeerKey(b, current);
    const [packet] = await overlay.encrypt(a, new Uint8Array([9]), { ...send, path: [b, a] });
    expect((await other.receive(packet, b, receive)).action).toBe("delivered");
  });
});
