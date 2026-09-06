import { signal } from "@angular/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineReceiveControlsService } from "./machine-receive-controls.service";

function setup() {
  let listener: (message: object) => void = () => {};
  const grant = signal<object | null>(null), revision = signal(0);
  const command = { type: "machine-receive-consent", trigger: "user-action", machinePeerId: "b".repeat(16),
    expectedRevision: 0, publicationIds: ["mic"], chatRead: false, expiresAt: 1_900_000_000_000 };
  const signaling = { subscribe: (value: typeof listener) => { listener = value; return vi.fn(); }, send: vi.fn() };
  const mesh = { peerChoices: signal([]), machineReceive: { revision, isMachine: () => true },
    machineReceiveConsent: vi.fn(() => command), ownMachineReceiveGrant: () => grant() };
  const session = { joined: signal(true), machineExpiresAt: signal(0), roomId: () => "room-aaaaaaaaaaaaaaaaaa" };
  const service = new MachineReceiveControlsService(mesh as never, session as never, signaling as never);
  return { service, mesh, signaling, session, grant, revision, command,
    emit: (message: object) => listener(message), request: (trigger = "user-action") => service.request(command.machinePeerId, true, false, false, 1, trigger) };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe("machine receive controls", () => {
  it("requires a local user action and never confirms an unrelated receipt", () => {
    const f = setup(); f.request("remote"); expect(f.signaling.send).not.toHaveBeenCalled();
    f.request(); expect(f.service.state()).toBe("pending");
    f.revision.set(1); f.grant.set({ ...f.command, expiresAt: 1 });
    f.emit({ type: "machine-receive-state", roomId: f.session.roomId() }); expect(f.service.state()).toBe("pending");
    f.grant.set(f.command); f.emit({ type: "machine-receive-state", roomId: "other" }); expect(f.service.state()).toBe("pending");
    f.emit({ type: "machine-receive-state", roomId: f.session.roomId() }); expect(f.service.state()).toBe("confirmed");
    f.service.ngOnDestroy();
  });
  it("bounds pending requests and does not mint machine or disconnected consent", () => {
    vi.useFakeTimers(); const f = setup();
    f.session.machineExpiresAt.set(100); f.request(); expect(f.signaling.send).not.toHaveBeenCalled();
    f.session.machineExpiresAt.set(0); f.session.joined.set(false); f.request(); expect(f.signaling.send).not.toHaveBeenCalled();
    f.session.joined.set(true); f.request(); f.request(); expect(f.signaling.send).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(5000); expect(f.service.error()).toBe("machine_receive_ack_timeout"); f.service.ngOnDestroy();
  });
});
