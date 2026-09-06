import { afterEach, describe, expect, it, vi } from "vitest";
import { BroadcastCompositionLifetime } from "./broadcast-composition-lifetime";

describe("BroadcastCompositionLifetime", () => {
  afterEach(() => vi.useRealTimers());
  it("shares reentrant close and attempts every acquired resource even after a cleanup failure", async () => {
    const external = new AbortController(), closed = vi.fn(), lifetime = new BroadcastCompositionLifetime(external.signal, closed);
    const first = { close: vi.fn(async () => { throw new Error("synthetic adapter failure"); }) }, second = { close: vi.fn(async () => {}) };
    await lifetime.acquire(async () => first); await lifetime.acquire(async () => second);
    let reentrant: Promise<void> | undefined;
    lifetime.signal.addEventListener("abort", () => { reentrant = lifetime.close(); });
    const closing = lifetime.close(); expect(reentrant).toBe(closing); expect(lifetime.close()).toBe(closing);
    await expect(closing).rejects.toThrow("broadcast_composition_cleanup_failed");
    expect(first.close).toHaveBeenCalledOnce(); expect(second.close).toHaveBeenCalledOnce(); expect(closed).toHaveBeenCalledOnce();
    first.close.mockResolvedValueOnce(undefined); await lifetime.close();
    expect(first.close).toHaveBeenCalledTimes(2); expect(second.close).toHaveBeenCalledOnce(); expect(closed).toHaveBeenCalledOnce();
  });
  it("closes a late result from an adapter that ignored cancellation without publishing it", async () => {
    vi.useFakeTimers();
    const lifetime = new BroadcastCompositionLifetime(new AbortController().signal, () => {});
    let resolve!: (resource: { close(): Promise<void> }) => void;
    const pending = lifetime.acquire(() => new Promise(done => { resolve = done; }));
    const rejected = expect(pending).rejects.toThrow("broadcast_composition_closed"); await Promise.resolve();
    await lifetime.close(); await rejected;
    const resource = { close: vi.fn(async () => {}) }; resolve(resource); await vi.advanceTimersByTimeAsync(0);
    expect(resource.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds a hanging adapter and releases an already acquired resource", async () => {
    vi.useFakeTimers(); const closed = vi.fn();
    const lifetime = new BroadcastCompositionLifetime(new AbortController().signal, closed);
    const resource = { close: vi.fn(async () => {}) }; await lifetime.acquire(async () => resource);
    const rejected = expect(lifetime.acquire(() => new Promise(() => {}))).rejects.toThrow("broadcast_composition_setup_timeout");
    await vi.advanceTimersByTimeAsync(10_001); await rejected;
    expect(resource.close).toHaveBeenCalledOnce(); expect(closed).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("detaches from the external signal and refuses setup after external cancellation", async () => {
    const external = new AbortController(), detach = vi.spyOn(external.signal, "removeEventListener");
    const lifetime = new BroadcastCompositionLifetime(external.signal, () => {}); external.abort();
    const create = vi.fn(); await expect(lifetime.acquire(create)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled(); expect(detach).toHaveBeenCalledOnce(); await lifetime.close();
  });
  it("rejects malformed adapter results instead of publishing an empty composition", async () => {
    const lifetime = new BroadcastCompositionLifetime(new AbortController().signal, () => {});
    await expect(lifetime.acquire(async () => undefined as never)).rejects.toThrow("invalid_broadcast_composition_resource");
    await lifetime.close();
  });
  it("bounds a hanging cleanup and permits retry without restoring authority", async () => {
    vi.useFakeTimers();
    const lifetime = new BroadcastCompositionLifetime(new AbortController().signal, () => {});
    const resource = { close: vi.fn(async () => {}) }; resource.close.mockImplementationOnce(() => new Promise(() => {}));
    await lifetime.acquire(async () => resource);
    const failed = expect(lifetime.close()).rejects.toThrow("broadcast_composition_cleanup_failed");
    await vi.advanceTimersByTimeAsync(5001); await failed;
    expect(lifetime.signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
    await lifetime.close(); expect(resource.close).toHaveBeenCalledTimes(2);
  });
});
