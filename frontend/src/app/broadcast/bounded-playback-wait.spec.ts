import { afterEach, describe, expect, it, vi } from "vitest";

import { boundedPlaybackWait } from "./bounded-playback-wait";

describe("boundedPlaybackWait", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("cleans its timer and abort listener after success", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    expect(await boundedPlaybackWait(Promise.resolve(42), 100, controller.signal))
      .toEqual({ state: "fulfilled", value: 42 });
    expect(remove).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not expose rejection details, including after timeout or abort", async () => {
    vi.useFakeTimers();
    for (const mode of ["failure", "timeout", "abort"] as const) {
      const controller = new AbortController();
      let reject!: (reason: unknown) => void;
      const operation = new Promise((_, no) => { reject = no; });
      const waiting = boundedPlaybackWait(operation, 100, controller.signal);
      if (mode === "timeout") await vi.advanceTimersByTimeAsync(100);
      if (mode === "abort") controller.abort();
      reject(new Error("secret-canary"));
      const result = await waiting;
      expect(result).toEqual({ state: mode === "failure" ? "failed" : mode === "abort" ? "aborted" : "timeout" });
      expect(JSON.stringify(result)).not.toContain("secret-canary");
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("checks the monotonic deadline even before a delayed timer is delivered", async () => {
    let now = 10;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let resolve!: (value: number) => void;
    const operation = new Promise<number>((yes) => { resolve = yes; });
    const waiting = boundedPlaybackWait(operation, 100);
    now = 110;
    resolve(42);
    expect(await waiting).toEqual({ state: "timeout" });
  });

  it("observes an already-aborted operation without leaving timers", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    expect(await boundedPlaybackWait(Promise.reject(new Error("private")), 100, controller.signal))
      .toEqual({ state: "aborted" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
