import { signal } from "@angular/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MachineChatSessionService } from "./machine-chat-session.service";

const now = 1_788_000_000_000, own = "2222222222222222", human = "1111111111111111";
function fixture() {
  const capabilities = new Set(["chat.read"]);
  const session = { joined: signal(true), roomId: () => "room-aaaaaaaaaaaaaaaaaa",
    machineContext: signal({ tenantId: "tenant", projectId: "project", taskId: "task",
      runtimeId: "runtime", hubSessionId: "hub-session" }),
    machineLease: signal({ sessionId: "ms_" + "a".repeat(32), generation: 1, expiresAt: now + 60_000 }) };
  const grants = signal([{ machinePeerId: own, chatRead: true, expiresAt: now + 30_000 }]);
  const mesh = { ownPeerId: () => own, membershipEpoch: () => 3,
    peerChoices: () => [{ id: human }],
    machineReceive: { grants, isMachine: (id: string) => id === own, revision: () => 1,
      supports: (id: string, cap: string) => id === own && capabilities.has(cap), chatAllowed: () => true },
    subscribeMachineChat: vi.fn(() => vi.fn()), sendMachineChatReply: vi.fn() };
  const service = new MachineChatSessionService(session as never, mesh as never);
  return { service, session, mesh, grants, capabilities };
}
describe("machine chat session authority projection", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubGlobal("location", { origin: "https://meet.example" }); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  it("opens with only read authority and publisher consent without any send effect", () => {
    const f = fixture();
    expect(f.service.endpoint.open()).toMatchObject({ generation: 1, deadline_ms: now + 30_000 });
    expect(f.service.endpoint.poll().events).toEqual([]);
    expect(() => f.service.endpoint.reply("a".repeat(32), "Antwort")).toThrow("meet_chat_reply_denied");
    expect(f.service.endpoint.status().open).toBe(true);
    expect(f.mesh.sendMachineChatReply).not.toHaveBeenCalled(); f.service.ngOnDestroy();
  });
  it.each(["send-only", "no-consent", "expired-consent", "not-joined"])("rejects %s without subscribing", mode => {
    const f = fixture();
    if (mode === "send-only") { f.capabilities.delete("chat.read"); f.capabilities.add("chat.send"); }
    if (mode === "no-consent") f.grants.set([]);
    if (mode === "expired-consent") f.grants.set([{ machinePeerId: own, chatRead: true, expiresAt: now }]);
    if (mode === "not-joined") f.session.joined.set(false);
    expect(() => f.service.endpoint.open()).toThrow("meet_chat_authority_unavailable");
    expect(f.mesh.subscribeMachineChat).not.toHaveBeenCalled(); f.service.ngOnDestroy();
  });
  it("fences a read-only subscription on renewal and requires explicit reopening", () => {
    const f = fixture(); f.service.endpoint.open();
    f.session.machineLease.update(value => ({ ...value, generation: 2 }));
    vi.advanceTimersByTime(250);
    expect(f.service.endpoint.status()).toEqual({ open: false, error: "meet_chat_authority_changed" });
    expect(f.service.endpoint.open().generation).toBe(2);
    f.capabilities.delete("chat.read"); vi.advanceTimersByTime(250);
    expect(f.service.endpoint.status().open).toBe(false); f.service.ngOnDestroy();
  });
});
