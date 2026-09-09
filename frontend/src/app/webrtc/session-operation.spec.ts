import { afterEach, expect, it, vi } from "vitest";
import { SessionOperation } from "./session-operation";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("removes abort listeners on success and synchronous failure", async () => {
  vi.useFakeTimers();
  const operation = new SessionOperation(10_000, "timeout");
  const add = vi.spyOn(operation.signal, "addEventListener"), remove = vi.spyOn(operation.signal, "removeEventListener");
  expect(await operation.wait(async () => 42)).toBe(42);
  await expect(operation.wait(() => { throw new Error("fixture"); })).rejects.toThrow("fixture");
  expect(add).toHaveBeenCalledTimes(2); expect(remove).toHaveBeenCalledTimes(2);
  for (const [index, call] of add.mock.calls.entries()) expect(remove.mock.calls[index]?.[1]).toBe(call[1]);
  operation.dispose(); expect(vi.getTimerCount()).toBe(0);
});

it("denies a stage before calling it after cancellation", async () => {
  const operation = new SessionOperation(10_000, "timeout"), start = vi.fn();
  operation.abort();
  await expect(operation.wait(start)).rejects.toThrow("session_operation_cancelled");
  expect(start).not.toHaveBeenCalled();
});

it("checks the monotonic deadline even before a delayed timer fires", async () => {
  vi.useFakeTimers(); let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const operation = new SessionOperation(10_000, "timeout"), start = vi.fn();
  now += 10_000;
  await expect(operation.wait(start)).rejects.toThrow("timeout");
  expect(start).not.toHaveBeenCalled(); operation.dispose();
});

it("does not accept a result at the deadline ahead of its timer callback", async () => {
  vi.useFakeTimers(); let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const operation = new SessionOperation(10_000, "timeout");
  await expect(operation.wait(async () => { now = 10_000; return "late"; })).rejects.toThrow("timeout");
  operation.dispose();
});

it.each(["resolve", "reject"] as const)("observes late %s without reviving a timed-out wait", async outcome => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const operation = new SessionOperation(10_000, "timeout");
  let resolve!: () => void, reject!: (error: Error) => void;
  const held = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const rejected = expect(operation.wait(() => held)).rejects.toThrow("timeout");
  await vi.advanceTimersByTimeAsync(10_000); await rejected;
  if (outcome === "resolve") resolve(); else reject(new Error("late private error"));
  await Promise.resolve(); operation.dispose(); expect(vi.getTimerCount()).toBe(0);
});

it("clears both polling and deadline timers on abort", async () => {
  vi.useFakeTimers();
  const operation = new SessionOperation(10_000, "timeout");
  const rejected = expect(operation.pause(50)).rejects.toThrow("session_operation_cancelled");
  operation.abort(); await rejected; expect(vi.getTimerCount()).toBe(0);
});

it("handles synchronous abort from a started dependency", async () => {
  const operation = new SessionOperation(10_000, "timeout");
  await expect(operation.wait(async () => { operation.abort(); return 42; }))
    .rejects.toThrow("session_operation_cancelled");
});
