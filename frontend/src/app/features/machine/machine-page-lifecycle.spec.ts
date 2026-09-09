import { afterEach, expect, it, vi } from "vitest";
import { MachinePageLifecycle } from "./machine-page-lifecycle";
import { RoomSessionService } from "../../webrtc/room-session.service";

const room = "room-" + "a".repeat(18);
function deferred() { let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject }; }
function fixture() {
  let joined = false;
  const close = vi.fn(() => { joined = false; });
  const ports = { load: vi.fn(async () => {}), join: vi.fn(async () => { joined = true; }),
    joined: () => joined, cleanup: [close], cleanupFailed: vi.fn() };
  return { ports, close, lifecycle: new MachinePageLifecycle(ports), setJoined: (value: boolean) => { joined = value; } };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("retires an admitted session when Welcome never arrives, without retrying", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const f = fixture(); f.ports.join.mockImplementation(async () => {});
  const result = f.lifecycle.join(room, "grant");
  const rejected = expect(result).rejects.toThrow("machine_operation_bounded_stop");
  await vi.advanceTimersByTimeAsync(20_050); await rejected;
  expect(f.close).toHaveBeenCalledTimes(2); // initial leave + failed admission
  expect(f.ports.join).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it.each(["resolve", "reject"] as const)("does not retire a replacement on an old admission %s", async outcome => {
  const f = fixture(), old = deferred();
  f.ports.join.mockImplementationOnce(() => old.promise);
  const first = f.lifecycle.join(room, "old");
  const rejected = expect(first).rejects.toThrow(outcome === "reject" ? "old failure" : "machine_cancelled");
  await Promise.resolve();
  await f.lifecycle.join(room, "fresh");
  const closes = f.close.mock.calls.length;
  if (outcome === "resolve") old.resolve(); else old.reject(new Error("old failure"));
  await rejected;
  expect(f.close).toHaveBeenCalledTimes(closes); expect(f.ports.joined()).toBe(true);
});

it("never admits after leave during configuration loading", async () => {
  const f = fixture(), loading = deferred(); f.ports.load.mockReturnValue(loading.promise);
  const result = f.lifecycle.join(room, "grant");
  const rejected = expect(result).rejects.toThrow("machine_cancelled");
  f.lifecycle.leave(); loading.resolve(); await rejected;
  expect(f.ports.join).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledTimes(2);
});

it("invalidates before cleanup and attempts every endpoint despite cleanup failures", () => {
  const f = fixture(), order: string[] = [];
  f.ports.cleanup = [() => { order.push("audio"); throw new Error("private detail"); },
    () => { order.push("screen"); }, () => { order.push("session"); }, () => { order.push("chat"); }];
  f.lifecycle.leave();
  expect(order).toEqual(["audio", "screen", "session", "chat"]);
  expect(f.ports.cleanupFailed).toHaveBeenCalledExactlyOnceWith();
});

it("retires its own failed admission and rejects calls retained after page destruction", async () => {
  const f = fixture(); f.ports.join.mockRejectedValueOnce(new Error("admission_denied"));
  await expect(f.lifecycle.join(room, "grant")).rejects.toThrow("admission_denied");
  expect(f.close).toHaveBeenCalledTimes(2);
  f.lifecycle.destroy();
  await expect(f.lifecycle.join(room, "grant")).rejects.toThrow("machine_cancelled");
  expect(f.ports.join).toHaveBeenCalledOnce();
});

it("rejects malformed join inputs before configuration or admission", async () => {
  const f = fixture();
  for (const [id, grant] of [[room, ""], [room, "x".repeat(4097)], ["other", "grant"], [undefined, "grant"]]) {
    await expect(f.lifecycle.join(id as string, grant!)).rejects.toThrow("machine_join_invalid");
  }
  expect(f.ports.load).not.toHaveBeenCalled(); expect(f.ports.join).not.toHaveBeenCalled();
});

it("fences a late Welcome through the actual RoomSessionService after the page deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  let message!: (value: { type: string }) => void;
  const signaling = { leave: vi.fn(), connect: vi.fn((_path, onMessage) => { message = onMessage; }) };
  const mesh = { close: vi.fn(), initialize: vi.fn() };
  const session = new RoomSessionService({ value: () => ({ mediaE2ee: { mode: "required" } }) } as never,
    {} as never, { createProof: async () => ({}) } as never, signaling as never, mesh as never);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({
    signalingPath: "/signal", iceServers: [], machineExpiresAt: Date.now() + 60_000,
    icePolicy: { version: 1, directIceServers: [], peerRelayIceServers: [], infrastructureRelayIceServers: [],
      peerRelayAfterMs: 1000, infrastructureRelayAfterMs: 2000 },
  }) })));
  const lifecycle = new MachinePageLifecycle({ load: async () => {},
    join: (id, grant) => session.join(id, "Ananta (KI)", "room", grant), joined: () => session.joined(),
    cleanup: [() => session.leave()], cleanupFailed: vi.fn() });
  const pending = lifecycle.join(room, "synthetic-grant");
  const rejected = expect(pending).rejects.toThrow("machine_operation_bounded_stop");
  await vi.advanceTimersByTimeAsync(20_050); await rejected;
  expect(signaling.connect).toHaveBeenCalledOnce();
  message({ type: "welcome" });
  expect(session.joined()).toBe(false); expect(session.machineExpiresAt()).toBe(0);
  expect(mesh.initialize).not.toHaveBeenCalled();
});
