import { afterEach, describe, expect, it, vi } from "vitest";
import { OpaqueDataOverlay } from "./opaque-data-overlay";

const alice = "aaaaaaaaaaaaaaaa", bob = "bbbbbbbbbbbbbbbb", relay = "cccccccccccccccc";
const send = { membershipEpoch: 1, routeEpoch: 1, trafficClass: "rekey" as const, path: [alice, bob] };
const receive = { membershipEpoch: 1, routeEpoch: 1, memberPeerIds: new Set([alice, bob, relay]) };
const data = new Uint8Array([1, 2, 3, 4]);

// Hold one *real* WebCrypto completion, not its cryptographic result.
function hold(method: "generateKey" | "exportKey" | "importKey" | "deriveKey" | "encrypt" | "decrypt" | "digest") {
  let release!: () => void, entered!: (value: any) => void;
  const ready = new Promise<any>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = crypto.subtle[method] as (...args: any[]) => Promise<any>;
  vi.spyOn(crypto.subtle, method).mockImplementationOnce(async (...args: any[]) => {
    const value = await original.apply(crypto.subtle, args);
    entered(value); await gate; return value;
  });
  return { ready, release };
}

async function pair() {
  const a = new OpaqueDataOverlay(), b = new OpaqueDataOverlay();
  const ak = await a.initialize(alice), bk = await b.initialize(bob);
  await a.setPeerKey(bob, bk); await b.setPeerKey(alice, ak);
  return { a, b, ak, bk };
}

afterEach(() => vi.restoreAllMocks());

describe("opaque overlay asynchronous ownership", () => {
  it.each(["generateKey", "exportKey"] as const)("destroy rejects late initialization at %s", async method => {
    const overlay = new OpaqueDataOverlay(), barrier = hold(method);
    const pending = overlay.initialize(alice);
    await barrier.ready; overlay.destroy(); barrier.release();
    await expect(pending).rejects.toThrow("overlay_lifecycle_changed");
    expect(overlay.hasPeerKey(bob)).toBe(false);
  });

  it("an older initialization cannot overwrite the new identity", async () => {
    const overlay = new OpaqueDataOverlay(), barrier = hold("generateKey");
    const old = overlay.initialize(alice); await barrier.ready;
    const current = await overlay.initialize(bob);
    barrier.release(); await expect(old).rejects.toThrow("overlay_lifecycle_changed");
    const other = new OpaqueDataOverlay(), key = await other.initialize(alice);
    await overlay.setPeerKey(alice, key); await other.setPeerKey(bob, current);
    const [packet] = await overlay.encrypt(alice, data, { ...send, path: [bob, alice] });
    expect((await other.receive(packet, bob, receive)).action).toBe("delivered");
  });

  it.each(["remove", "destroy"])("late import cannot undo %s", async action => {
    const { a, bk } = await pair(), barrier = hold("importKey");
    const pending = a.setPeerKey(bob, bk); await barrier.ready;
    if (action === "remove") a.removePeer(bob); else a.destroy();
    barrier.release(); await expect(pending).rejects.toThrow("overlay_lifecycle_changed");
    expect(a.hasPeerKey(bob)).toBe(false);
  });

  it("the newest peer-key import wins even when an older import finishes last", async () => {
    const { a, b, ak, bk } = await pair(), barrier = hold("importKey");
    const old = a.setPeerKey(bob, bk); await barrier.ready;
    const newer = await b.initialize(bob); await b.setPeerKey(alice, ak);
    await a.setPeerKey(bob, newer);
    barrier.release(); await expect(old).rejects.toThrow("overlay_lifecycle_changed");
    const [packet] = await a.encrypt(bob, data, send);
    expect((await b.receive(packet, alice, receive)).action).toBe("delivered");
  });

  it.each(["deriveKey", "encrypt", "digest"] as const)("a removed peer fences outbound %s completion", async method => {
    const { a } = await pair(), barrier = hold(method);
    const pending = a.encrypt(bob, data, send); await barrier.ready;
    a.removePeer(bob); barrier.release();
    await expect(pending).rejects.toThrow("overlay_lifecycle_changed");
  });

  it("an old derivation cannot poison the replacement-key cache", async () => {
    const { a, b, ak } = await pair(), barrier = hold("deriveKey");
    const old = a.encrypt(bob, data, send); await barrier.ready;
    const next = await b.initialize(bob); await b.setPeerKey(alice, ak); await a.setPeerKey(bob, next);
    barrier.release(); await expect(old).rejects.toThrow("overlay_lifecycle_changed");
    const [packet] = await a.encrypt(bob, data, send);
    expect((await b.receive(packet, alice, receive)).action).toBe("delivered");
  });

  it.each(["destroy", "remove", "replace"])("late plaintext is wiped and not delivered after %s", async action => {
    const { a, b, ak } = await pair(), [packet] = await a.encrypt(bob, data, send);
    const barrier = hold("decrypt"), pending = b.receive(packet, alice, receive);
    const plaintext = new Uint8Array(await barrier.ready);
    if (action === "destroy") b.destroy();
    else if (action === "remove") b.removePeer(alice);
    else await b.setPeerKey(alice, ak);
    barrier.release(); expect((await pending).action).toBe("drop");
    expect([...plaintext]).toEqual([0, 0, 0, 0]);
  });

  it("destroy during digest verification cannot forward a stale relay packet", async () => {
    const { a } = await pair(), r = new OpaqueDataOverlay(); await r.initialize(relay);
    const [packet] = await a.encrypt(bob, data, { ...send, path: [alice, relay, bob] });
    const barrier = hold("digest"), pending = r.receive(packet, alice, receive);
    await barrier.ready; r.destroy(); barrier.release();
    expect((await pending).action).toBe("drop");
  });

  it("concurrent copies of one packet deliver only once", async () => {
    const { a, b } = await pair(), [packet] = await a.encrypt(bob, data, send);
    const barrier = hold("digest"), slow = b.receive(packet, alice, receive);
    await barrier.ready;
    expect((await b.receive(packet, alice, receive)).action).toBe("delivered");
    barrier.release(); expect(await slow).toEqual({ action: "drop", reason: "replay" });
  });
});
