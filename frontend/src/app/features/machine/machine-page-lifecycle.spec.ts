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

it.each(["load", "join"] as const)("bounds a never-settled %s before Welcome", async stage => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const f = fixture(), held = deferred(); f.ports[stage].mockReturnValueOnce(held.promise);
  let failure = "";
  const pending = f.lifecycle.join(room, "grant").catch(error => { failure = error.message; });
  try {
    await vi.advanceTimersByTimeAsync(20_050);
    expect(failure).toBe("machine_operation_bounded_stop");
    expect(f.close).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally { f.lifecycle.leave(); held.resolve(); await pending; }
});

it("settles a superseded load even if its dependency never completes", async () => {
  const f = fixture(), held = deferred(); f.ports.load.mockReturnValueOnce(held.promise);
  let failure = "";
  const old = f.lifecycle.join(room, "old").catch(error => { failure = error.message; });
  try {
    await f.lifecycle.join(room, "fresh");
    expect(failure).toBe("machine_cancelled");
    expect(f.ports.join).toHaveBeenCalledExactlyOnceWith(room, "fresh");
    expect(f.ports.joined()).toBe(true);
  } finally { held.resolve(); await old; f.lifecycle.leave(); }
});

it("shares one twenty-second budget across load, admission and Welcome", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const f = fixture();
  f.ports.load.mockImplementationOnce(() => new Promise(resolve => setTimeout(resolve, 12_000)));
  f.ports.join.mockImplementationOnce(() => new Promise(resolve => setTimeout(resolve, 6000)));
  const rejected = expect(f.lifecycle.join(room, "grant")).rejects.toThrow("machine_operation_bounded_stop");
  await vi.advanceTimersByTimeAsync(19_999);
  expect(f.close).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); await rejected;
  expect(f.close).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
});

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
  const rejected = expect(first).rejects.toThrow("machine_cancelled");
  await vi.waitFor(() => expect(f.ports.join).toHaveBeenCalledOnce());
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

it("quarantines new joins after any cleanup failure, even when later cleanup is a no-op", async () => {
  const f = fixture(); f.close.mockImplementationOnce(() => { throw new Error("private cleanup detail"); });
  await expect(f.lifecycle.join(room, "grant")).rejects.toThrow("machine_cleanup_failed");
  f.lifecycle.leave(); // Detached handles can now return success without proving they stopped.
  await expect(f.lifecycle.join(room, "fresh")).rejects.toThrow("machine_cleanup_failed");
  expect(f.ports.load).not.toHaveBeenCalled(); expect(f.ports.join).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledTimes(2);
});

it("does not expose notifier errors or let them bypass quarantine and other stops", async () => {
  const f = fixture(), other = vi.fn();
  f.ports.cleanup = [() => { throw new Error("private source detail"); }, other];
  f.ports.cleanupFailed.mockImplementation(() => { throw new Error("private notifier detail"); });
  expect(() => f.lifecycle.leave()).not.toThrow();
  expect(other).toHaveBeenCalledOnce();
  await expect(f.lifecycle.join(room, "grant")).rejects.toThrow("machine_cleanup_failed");
  expect(f.ports.load).not.toHaveBeenCalled();
});

it("keeps an old admission failure when its cleanup fails, but denies any subsequent join", async () => {
  const f = fixture();
  f.ports.join.mockRejectedValueOnce(new Error("admission_denied"));
  f.close.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("cleanup detail"); });
  await expect(f.lifecycle.join(room, "grant")).rejects.toThrow("admission_denied");
  await expect(f.lifecycle.join(room, "fresh")).rejects.toThrow("machine_cleanup_failed");
  expect(f.ports.join).toHaveBeenCalledOnce();
});

it("honors the actual RoomSessionService negative cleanup result without another admission", async () => {
  const signaling = { leave: vi.fn(() => { throw new Error("private transport detail"); }) };
  const mesh = { close: vi.fn() };
  const session = new RoomSessionService({} as never, {} as never, {} as never, signaling as never, mesh as never);
  const load = vi.fn(async () => {}), join = vi.spyOn(session, "join"), other = vi.fn();
  const lifecycle = new MachinePageLifecycle({ load, join: (id, grant) => session.join(id, "Ananta (KI)", "room", grant),
    joined: () => session.joined(), cleanup: [() => session.leave(), other], cleanupFailed: vi.fn() });
  await expect(lifecycle.join(room, "grant")).rejects.toThrow("machine_cleanup_failed");
  expect(other).toHaveBeenCalledOnce(); expect(mesh.close).toHaveBeenCalledOnce();
  expect(load).not.toHaveBeenCalled(); expect(join).not.toHaveBeenCalled();
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

it("retains a transport-disconnect mesh failure even when its handles later disappear", async () => {
  let disconnected!: () => void;
  const signaling = { leave: vi.fn(), connect: vi.fn((_path, _message, onClose) => { disconnected = onClose; }) };
  const mesh = { close: vi.fn() };
  const session = new RoomSessionService({ value: () => ({ mediaE2ee: { mode: "required" } }) } as never,
    {} as never, { createProof: async () => ({}) } as never, signaling as never, mesh as never);
  const request = vi.fn(async () => ({ ok: true, json: async () => ({
    signalingPath: "/signal", iceServers: [], machineExpiresAt: Date.now() + 60_000,
    icePolicy: { version: 1, directIceServers: [], peerRelayIceServers: [], infrastructureRelayIceServers: [],
      peerRelayAfterMs: 1000, infrastructureRelayAfterMs: 2000 },
  }) }));
  vi.stubGlobal("fetch", request);
  await session.join(room, "Ananta (KI)", "room", "grant");
  mesh.close.mockImplementationOnce(() => { throw new Error("private mesh detail"); });
  expect(() => disconnected()).not.toThrow();
  expect(session.error()).toBe("session_cleanup_failed"); expect(session.machineExpiresAt()).toBe(0);
  await expect(session.join(room, "Ananta (KI)", "room", "fresh")).rejects.toThrow("session_cleanup_failed");
  expect(request).toHaveBeenCalledOnce(); expect(signaling.connect).toHaveBeenCalledOnce();
});
