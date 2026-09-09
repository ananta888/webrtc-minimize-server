import { signal } from "@angular/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineReceiveControlsService } from "./machine-receive-controls.service";

function setup() {
  let listener: (message: object) => void = () => {};
  const grant = signal<object | null>(null), revision = signal(0);
  const command = { type: "machine-receive-consent", trigger: "user-action", machinePeerId: "b".repeat(16),
    expectedRevision: 0, publicationIds: ["mic"], chatRead: false, expiresAt: 1_900_000_000_000 };
  const signaling = { subscribe: (value: typeof listener) => { listener = value; return vi.fn(); }, send: vi.fn() };
  const sources = signal([{ publicationId: "mic", source: "microphone" }]);
  const mesh = { peerChoices: signal([{ id: command.machinePeerId, name: "Ananta (KI)" }]), remoteMedia: signal<any[]>([]),
    machineReceive: { revision, isMachine: () => true, supports: (_id: string, cap: string) => ["screen.publish", "chat.send"].includes(cap) },
    machineReceiveConsent: vi.fn(() => command), ownMachineReceiveGrant: () => grant(), ownMachineReceiveSources: sources };
  const session = { joined: signal(true), machineExpiresAt: signal(0), roomId: signal("room-aaaaaaaaaaaaaaaaaa"), peerId: signal("a".repeat(16)) };
  const service = new MachineReceiveControlsService(mesh as never, session as never, signaling as never);
  return { service, mesh, signaling, session, grant, revision, command, sources,
    emit: (message: object) => listener(message), request: (trigger = "user-action") => service.request(command.machinePeerId, true, false, false, 1, trigger,
      service.selectionScope(command.machinePeerId)) };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe("machine receive controls", () => {
  it("does not confirm an expired grant when its ACK arrives before queued timers", () => {
    vi.useFakeTimers(); const f = setup();
    f.command.expiresAt = Date.now() + 1000;
    f.request(); f.grant.set(f.command); f.revision.set(1);
    vi.setSystemTime(f.command.expiresAt);
    f.emit({ type: "machine-receive-state", roomId: f.session.roomId() });
    expect(f.service.state()).toBe("expired");
    expect(f.service.error()).toBe("");
    expect(f.signaling.send).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(5000);
    expect(f.service.state()).toBe("expired");
    f.service.ngOnDestroy(); expect(vi.getTimerCount()).toBe(0);
  });
  it("expires pending consent even without a matching receipt and never resubmits", () => {
    vi.useFakeTimers(); const f = setup();
    f.command.expiresAt = Date.now() + 1000; f.request();
    vi.advanceTimersByTime(1000);
    expect(f.service.state()).toBe("expired");
    vi.advanceTimersByTime(5000);
    expect(f.service.state()).toBe("expired");
    expect(f.signaling.send).toHaveBeenCalledOnce(); f.service.ngOnDestroy();
  });
  it("counts only unexpired audio and visual grants", () => {
    vi.useFakeTimers(); const f = setup();
    f.sources.set([{ publicationId: "mic", source: "microphone" }, { publicationId: "cam", source: "camera" }]);
    f.grant.set({ ...f.command, publicationIds: ["mic", "cam"], expiresAt: Date.now() + 1000 });
    expect(f.service.activities()[0]).toMatchObject({ audioGrantCount: 1, videoGrantCount: 1 });
    vi.advanceTimersByTime(1000);
    expect(f.service.activities()[0]).toMatchObject({ grant: null, grantState: "expired", audioGrantCount: 0, videoGrantCount: 0 });
    f.service.ngOnDestroy();
  });
  it("can confirm a pure revocation without a grant lifetime", () => {
    vi.useFakeTimers(); const f = setup();
    f.command.publicationIds = []; f.command.expiresAt = Date.now() - 1;
    f.service.request(f.command.machinePeerId, false, false, false, 1, "user-action");
    f.revision.set(1); f.emit({ type: "machine-receive-state", roomId: f.session.roomId() });
    expect(f.service.state()).toBe("confirmed");
    expect(f.signaling.send).toHaveBeenCalledOnce(); f.service.ngOnDestroy();
  });
  it.each(["camera", "screen"])("requires fresh selected IDs for visual %s grants, without capture or implicit consent", source => {
    vi.useFakeTimers(); const f = setup();
    f.mesh.machineReceive.supports = (_id, cap) => cap === "video.receive";
    f.sources.set([{ publicationId: "visual-old", source }]);
    const selected = f.service.selectionScope(f.command.machinePeerId);
    const visual = { camera: source === "camera", screen: source === "screen" };
    f.sources.set([{ publicationId: "visual-new", source }]); f.command.publicationIds = ["visual-new"];
    f.service.request(f.command.machinePeerId, false, false, false, 1, "user-action", selected, visual);
    expect(f.signaling.send).not.toHaveBeenCalled();
    f.service.request(f.command.machinePeerId, false, false, false, 1, "user-action", f.service.selectionScope(f.command.machinePeerId), visual);
    expect(f.signaling.send).toHaveBeenCalledExactlyOnceWith(f.command);
    f.grant.set({ ...f.command, expiresAt: Date.now() + 1000 });
    expect(f.service.selection(f.command.machinePeerId)).toMatchObject(visual);
    expect(f.service.activities()[0]).toMatchObject({ audioGrantCount: 0, videoGrantCount: 1, videoSupported: true });
    f.service.ngOnDestroy();
  });
  it("does not silently consent a replacement publication selected under the old source", () => {
    vi.useFakeTimers(); const f = setup();
    const selected = { roomId: f.session.roomId(), peerId: f.session.peerId(), machinePeerId: f.command.machinePeerId,
      sources: [{ publicationId: "mic", source: "microphone" }] };
    f.sources.set([{ publicationId: "replacement-mic", source: "microphone" }]);
    f.command.publicationIds = ["replacement-mic"];
    f.service.request(f.command.machinePeerId, true, false, false, 1, "user-action", selected);
    expect(f.signaling.send).not.toHaveBeenCalled();
    expect(f.service.error()).toBe("machine_receive_selection_changed");
    f.service.ngOnDestroy();
  });
  it.each(["room", "peer", "target", "missing"])("rejects a stale %s selection before creating or sending consent", change => {
    vi.useFakeTimers(); const f = setup();
    const selected = f.service.selectionScope(f.command.machinePeerId);
    if (change === "room") f.session.roomId.set("room-bbbbbbbbbbbbbbbbbb");
    if (change === "peer") f.session.peerId.set("c".repeat(16));
    const target = change === "target" ? "d".repeat(16) : f.command.machinePeerId;
    f.service.request(target, true, false, false, 1, "user-action", change === "missing" ? undefined : selected);
    expect(f.mesh.machineReceiveConsent).not.toHaveBeenCalled();
    expect(f.signaling.send).not.toHaveBeenCalled();
    expect(f.service.error()).toBe("machine_receive_selection_changed");
    f.service.ngOnDestroy();
  });
  it("binds chat-only selection to the session but permits a snapshot-free revocation", () => {
    vi.useFakeTimers(); const f = setup(); f.command.publicationIds = []; f.command.chatRead = true;
    const selected = f.service.selectionScope(f.command.machinePeerId);
    f.session.peerId.set("c".repeat(16));
    f.service.request(f.command.machinePeerId, false, false, true, 1, "user-action", selected);
    expect(f.signaling.send).not.toHaveBeenCalled();
    f.command.chatRead = false;
    f.service.request(f.command.machinePeerId, false, false, false, 1, "user-action");
    expect(f.signaling.send).toHaveBeenCalledExactlyOnceWith(f.command);
    f.service.ngOnDestroy();
  });
  it("freezes copied selection IDs and requires a fresh selection for replacement screen audio", () => {
    vi.useFakeTimers(); const f = setup();
    f.sources.set([{ publicationId: "screen-old", source: "screen-audio" }]);
    const selected = f.service.selectionScope(f.command.machinePeerId);
    expect(Object.isFrozen(selected)).toBe(true); expect(Object.isFrozen(selected.sources)).toBe(true);
    expect(Object.isFrozen(selected.sources[0])).toBe(true);
    f.sources()[0].publicationId = "screen-new";
    expect(selected.sources[0].publicationId).toBe("screen-old");
    f.command.publicationIds = ["screen-new"];
    f.service.request(f.command.machinePeerId, false, true, false, 1, "user-action", selected);
    expect(f.signaling.send).not.toHaveBeenCalled();
    f.service.request(f.command.machinePeerId, false, true, false, 1, "user-action", f.service.selectionScope(f.command.machinePeerId));
    expect(f.signaling.send).toHaveBeenCalledExactlyOnceWith(f.command);
    f.service.ngOnDestroy();
  });
  it("does not include an unselected source even if it changes", () => {
    vi.useFakeTimers(); const f = setup();
    f.sources.set([...f.sources(), { publicationId: "screen-old", source: "screen-audio" }]);
    const selected = f.service.selectionScope(f.command.machinePeerId);
    f.sources.set([{ publicationId: "mic", source: "microphone" }, { publicationId: "screen-new", source: "screen-audio" }]);
    f.service.request(f.command.machinePeerId, true, false, false, 1, "user-action", selected);
    expect(f.signaling.send).toHaveBeenCalledExactlyOnceWith(f.command);
    f.service.ngOnDestroy();
  });
  it("separates granted capabilities, current consent and observable tracks, without claiming processing", () => {
    vi.useFakeTimers(); const f = setup(); f.mesh.peerChoices.set([{ id: f.command.machinePeerId, name: "Ananta (KI)" }]);
    f.grant.set({ ...f.command, expiresAt: Date.now() + 2000 });
    expect(f.service.activities()[0]).toMatchObject({ grantState: "granted", audioSupported: false,
      chatReadSupported: false, chatSendSupported: true, screenSupported: true, screenAvailable: false });
    const track = { readyState: "live", muted: false };
    f.mesh.remoteMedia.set([{ peerId: f.command.machinePeerId, source: "screen", stream: { getTracks: () => [track] } }]);
    expect(f.service.activities()[0].screenAvailable).toBe(true);
    track.muted = true; vi.advanceTimersByTime(2000);
    expect(f.service.activities()[0]).toMatchObject({ grantState: "expired", grant: null, screenAvailable: false });
    f.mesh.peerChoices.set([]); expect(f.service.activities()).toEqual([]);
    f.service.ngOnDestroy(); expect(vi.getTimerCount()).toBe(0);
  });
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
  it("edits only current existing grants without starting capture or sending consent", () => {
    vi.useFakeTimers(); const f = setup();
    expect(f.service.selection(f.command.machinePeerId)).toEqual({ microphone: false, screenAudio: false, chat: false });
    f.grant.set({ ...f.command, chatRead: true, expiresAt: Date.now() + 1000 });
    expect(f.service.selection(f.command.machinePeerId)).toEqual({ microphone: true, screenAudio: false, chat: true });
    f.sources.set([{ publicationId: "replacement-mic", source: "microphone" }]);
    expect(f.service.selection(f.command.machinePeerId).microphone).toBe(false);
    expect(f.service.sourceAvailable("screen-audio")).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(f.service.selection(f.command.machinePeerId).chat).toBe(false);
    expect(f.signaling.send).not.toHaveBeenCalled(); f.service.ngOnDestroy();
  });
  it.each(["room", "peer", "leave", "target"])("invalidates a pending receipt after %s changes", change => {
    vi.useFakeTimers(); const f = setup(); f.request();
    if (change === "room") f.session.roomId.set("room-bbbbbbbbbbbbbbbbbb");
    if (change === "peer") f.session.peerId.set("c".repeat(16));
    if (change === "leave") f.session.joined.set(false);
    if (change === "target") f.mesh.peerChoices.set([]);
    f.grant.set(f.command); f.revision.set(1);
    f.emit({ type: "machine-receive-state", roomId: f.session.roomId() });
    expect(f.service.state()).toBe("failed"); expect(f.service.error()).toBe("machine_receive_session_changed");
    vi.advanceTimersByTime(5000); expect(f.service.error()).toBe("machine_receive_session_changed");
    f.service.ngOnDestroy(); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not retain confirmation after grant change or expiry, and never auto-renews", () => {
    vi.useFakeTimers(); const f = setup();
    f.command.expiresAt = Date.now() + 1000;
    f.request(); f.grant.set(f.command); f.revision.set(1);
    f.emit({ type: "machine-receive-state", roomId: f.session.roomId() });
    expect(f.service.state()).toBe("confirmed");
    vi.advanceTimersByTime(1000); expect(f.service.state()).toBe("expired");
    f.command.expectedRevision = 1; f.command.expiresAt = Date.now() + 1000;
    f.request(); f.grant.set({ ...f.command }); f.revision.set(2);
    f.emit({ type: "machine-receive-state", roomId: f.session.roomId() });
    expect(f.service.state()).toBe("confirmed");
    f.grant.set(null); vi.advanceTimersByTime(250); expect(f.service.state()).toBe("idle");
    expect(f.signaling.send).toHaveBeenCalledTimes(2); f.service.ngOnDestroy();
  });
  it("blocks reuse of destroyed controls and clears source choices on disconnect", () => {
    vi.useFakeTimers(); const f = setup();
    expect(f.service.sources()).toHaveLength(1); f.session.joined.set(false);
    expect(f.service.sources()).toEqual([]); f.service.ngOnDestroy();
    f.session.joined.set(true); f.request(); expect(f.signaling.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
