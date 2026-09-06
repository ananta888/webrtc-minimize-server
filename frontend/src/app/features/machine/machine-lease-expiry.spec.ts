import { afterEach, expect, it, vi } from "vitest";
import { MachineLeaseExpiry } from "./machine-lease-expiry";

afterEach(() => { vi.useRealTimers(); });
it("has only one expiry owner and fences a renewal before Angular flushes its effect", () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  let deadline = 2000;
  const expired = vi.fn(), timer = new MachineLeaseExpiry(() => deadline, expired);
  timer.arm(deadline); timer.arm(deadline);
  expect(vi.getTimerCount()).toBe(1);
  deadline = 3000; vi.advanceTimersByTime(1000);
  expect(expired).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(1000);
  expect(expired).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it("leave and absent leases cancel pending expiry callbacks", () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const expired = vi.fn(), timer = new MachineLeaseExpiry(() => 2000, expired);
  timer.arm(2000); timer.close(); vi.advanceTimersByTime(2000);
  timer.arm(0); expect(vi.getTimerCount()).toBe(0); expect(expired).not.toHaveBeenCalled();
});
