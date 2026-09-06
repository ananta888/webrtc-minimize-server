import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMachineSessionContext, parseMachineSessionLease } from "./machine-session-contract";
import { RoomSessionService } from "./room-session.service";
import { deviceProofMessage } from "../identity/device-identity.service";

const roomId = "room-111111111111111111", sessionId = `ms_${"a".repeat(32)}`;
const lease = () => ({ schema: "ananta.meet-session-lease.v1" as const, sessionId,
  generation: 1, expiresAt: Date.now() + 60_000, absoluteExpiresAt: Date.now() + 7_000_000 });
function setup() {
  const device = { createProof: vi.fn(async () => ({})) };
  const signaling = { leave: vi.fn(), connect: vi.fn() }, mesh = { close: vi.fn() };
  const service = new RoomSessionService({ value: () => ({ mediaE2ee: { mode: "required" } }) } as never,
    { authorizationHeader: () => ({}) } as never, device as never, signaling as never, mesh as never);
  service.roomId.set(roomId); service.joined.set(true); service.machineLease.set(lease());
  return { service, device, signaling };
}
afterEach(() => vi.unstubAllGlobals());
describe("machine session lease client", () => {
  it("accepts only the server's closed v2 scope projection, never capabilities or caller authority", () => {
    const context = { schema: "ananta.meet-machine-context.v1", tenantId: "tenant", projectId: "project",
      taskId: "task", runtimeId: "runtime", hubSessionId: "session" };
    expect(parseMachineSessionContext(context)).toEqual(context);
    for (const patch of [{ capabilities: ["record"] }, { runtimeId: null }, { projectId: "../other" }, { schema: "v2" }]) {
      expect(() => parseMachineSessionContext({ ...context, ...patch })).toThrow();
    }
  });
  it("rejects malformed, oversized-duration and extended contracts", () => {
    const value = lease(); expect(parseMachineSessionLease(value)).toEqual(value);
    for (const patch of [{ generation: true }, { generation: 513 }, { sessionId: "other" }, { schema: "v99" },
      { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 700_000 }, { tools: true }]) {
      expect(() => parseMachineSessionLease({ ...value, ...patch })).toThrow();
    }
  });
  it("uses a separate device-proof domain for session and generation", () => {
    const context = { roomId, mode: "room" as const, displayName: "Ananta (KI)", machineSessionId: sessionId, expectedGeneration: 3 };
    expect(deviceProofMessage(context, 1234, "nonce")).toBe(`webrtc-machine-renew-v1\n${roomId}\n${sessionId}\n3\n1234\nnonce`);
    expect(() => deviceProofMessage({ ...context, expectedGeneration: 0 }, 1234, "nonce")).toThrow();
    expect(() => deviceProofMessage({ ...context, mode: "pair" }, 1234, "nonce")).toThrow();
  });
  it("renews without reconnect or capture and sends the grant only in the header", async () => {
    const f = setup(), previous = f.service.machineLease()!;
    const next = { ...previous, generation: 2, expiresAt: previous.expiresAt + 60_000 };
    const request = vi.fn(async () => ({ ok: true, json: async () => next })); vi.stubGlobal("fetch", request);
    expect(await f.service.renewMachine("fresh-grant")).toEqual(next);
    const [path, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/machine/sessions/renew");
    expect(init.headers).toEqual({ "content-type": "application/json", Authorization: "Bearer fresh-grant" });
    expect(init.body).not.toContain("fresh-grant");
    expect(f.signaling.connect).not.toHaveBeenCalled(); expect(f.signaling.leave).not.toHaveBeenCalled();
    expect(f.device.createProof).toHaveBeenCalledWith({ roomId, mode: "room", displayName: "Ananta (KI)",
      machineSessionId: sessionId, expectedGeneration: 1 });
  });
  it("late renewal cannot resurrect a left session", async () => {
    const f = setup(), previous = f.service.machineLease()!;
    let resolve!: (value: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: () => new Promise(r => { resolve = r; }) })));
    const work = f.service.renewMachine("grant");
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    f.service.leave(); resolve({ ...previous, generation: 2, expiresAt: previous.expiresAt + 60_000 });
    await expect(work).rejects.toThrow(); expect(f.service.machineLease()).toBeNull(); expect(f.service.joined()).toBe(false);
  });
  it("denial and changed scope stop locally, concurrent renewals are refused", async () => {
    for (const reply of [{ ok: false }, { ok: true, json: async () => ({ ...lease(), sessionId: `ms_${"b".repeat(32)}`, generation: 2 }) }]) {
      const f = setup(); vi.stubGlobal("fetch", vi.fn(async () => reply));
      const pending = f.service.renewMachine("grant");
      await expect(f.service.renewMachine("another")).rejects.toThrow("machine_renewal_unavailable");
      await expect(pending).rejects.toThrow(); expect(f.service.joined()).toBe(false);
    }
  });
  it("leave during device proof prevents a late join HTTP request", async () => {
    const f = setup(); let resolve!: (value: object) => void;
    f.device.createProof.mockImplementation(() => new Promise(r => { resolve = r; }));
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const pending = f.service.join(roomId, "Ananta (KI)", "room", "grant");
    f.service.leave(); resolve({}); await expect(pending).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled(); expect(f.signaling.connect).not.toHaveBeenCalled();
  });
});
