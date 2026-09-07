import { signal } from "@angular/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MachineSpeechSessionService } from "./machine-speech-session.service";

function setup() {
  const session = { joined: signal(true), machineContext: signal({ hubSessionId: "hub-session" }),
    machineLease: signal({ sessionId: "meet-session", generation: 1, expiresAt: Date.now() + 60000 }) };
  const mesh = { ownPeerId: () => "machine", membershipEpoch: signal(1), machineReceive: { supports: vi.fn(() => true) } };
  const close = vi.fn(), graph = { create: vi.fn(async () => ({ push: vi.fn(), close })) };
  const service = new MachineSpeechSessionService(session as never, mesh as never, graph as never);
  return { session, mesh, graph, service, close };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe("session-bound synthetic speech", () => {
  it("requires the verified current speech right, not merely a joined browser", async () => {
    const f = setup(); f.mesh.machineReceive.supports.mockReturnValue(false);
    await expect(f.service.source.open("speech:hub-session", 441)).rejects.toThrow("meet_speech_source_denied");
    expect(f.mesh.machineReceive.supports).toHaveBeenCalledWith("machine", "speech.publish");
    expect(f.graph.create).not.toHaveBeenCalled();
    f.mesh.machineReceive.supports.mockReturnValue(true);
    await expect(f.service.source.open("speech:another-session", 441)).rejects.toThrow();
    expect(f.graph.create).not.toHaveBeenCalled(); f.service.ngOnDestroy();
  });
  it.each(["leave", "renew", "epoch", "rights"])("closes on %s within the bounded watchdog", async change => {
    const f = setup(); await f.service.source.open("speech:hub-session", 441);
    if (change === "leave") f.session.joined.set(false);
    if (change === "renew") f.session.machineLease.update(v => ({ ...v, generation: 2 }));
    if (change === "epoch") f.mesh.membershipEpoch.set(2);
    if (change === "rights") f.mesh.machineReceive.supports.mockReturnValue(false);
    vi.advanceTimersByTime(100); expect(f.close).toHaveBeenCalledOnce();
    expect(f.service.source.status().state).toBe("failed"); f.service.ngOnDestroy();
  });
});
