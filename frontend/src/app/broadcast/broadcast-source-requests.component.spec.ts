import "@angular/compiler";
import { Injector, runInInjectionContext, signal } from "@angular/core";
import { afterEach, expect, it, vi } from "vitest";
import { BroadcastSourceRequestsComponent } from "./broadcast-source-requests.component";

function fixture() {
  const requests = { busy: signal(false), reset: vi.fn(), setScope: vi.fn(), load: vi.fn(), create: vi.fn(), createOwn: vi.fn(), finish: vi.fn() };
  const sources = { workflow: { cancelSelection: vi.fn(), prepare: vi.fn(), approve: vi.fn(), revoke: vi.fn() },
    view: signal({ preparing: false, selection: null as any, error: "", publications: [] }) };
  const component = runInInjectionContext(Injector.create({ providers: [] }), () => new BroadcastSourceRequestsComponent(requests as never, sources as never));
  const inputs = { roomId: signal("room-alpha"), peerId: signal("0123456789abcdef"), identityKey: signal("owner"), disabled: signal(false),
    program: signal({ programId: "prg_aaaaaaaaaaaaaaaa", programEpoch: 2, programRevision: 3 }),
    candidates: signal([{ id: "fedcba9876543210", name: "Synthetic participant" }]) };
  Object.assign(component, inputs); component.target.set("fedcba9876543210");
  return { component, requests, inputs, sources };
}
it("confirms a specific selection and never stops an active publisher on panel destroy", () => {
  const f = fixture();
  f.sources.view.set({ ...f.sources.view(), selection: { requestId: "request", publications: [{ publicationId: "track" }] } });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  f.component.approveSource("request", "track"); expect(f.sources.workflow.approve).not.toHaveBeenCalled();
  confirm.mockReturnValue(true); f.component.approveSource("request", "track");
  expect(f.sources.workflow.approve).toHaveBeenCalledExactlyOnceWith("request", "track", 60000, "user-action");
  f.component.ngOnDestroy(); expect(f.sources.workflow.cancelSelection).toHaveBeenCalledOnce();
  expect(f.sources.workflow.revoke).not.toHaveBeenCalled();
});
it("rejects a changed selection during the final decrypt confirmation", () => {
  const f = fixture();
  f.sources.view.set({ ...f.sources.view(), selection: { requestId: "request", publications: [{ publicationId: "track" }] } });
  vi.spyOn(window, "confirm").mockImplementation(() => { f.sources.view.set({ ...f.sources.view(), selection: null }); return true; });
  f.component.approveSource("request", "track"); expect(f.sources.workflow.approve).not.toHaveBeenCalled();
});
afterEach(() => vi.restoreAllMocks());
it("confirms an own source separately without a selected remote peer or automatic decrypt approval", async () => {
  const f = fixture(); f.component.target.set(""); f.inputs.candidates.set([]);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await f.component.createOwn(); expect(f.requests.createOwn).not.toHaveBeenCalled();
  confirm.mockReturnValue(true); await f.component.createOwn();
  expect(f.requests.createOwn).toHaveBeenCalledExactlyOnceWith(f.inputs.program(), "camera");
  expect(f.sources.workflow.prepare).not.toHaveBeenCalled(); expect(f.sources.workflow.approve).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("keine Entschlüsselungsfreigabe"));
});
it("never fetches on scope changes and confirms only metadata requests", async () => {
  const f = fixture(); f.component.ngOnChanges(); expect(f.requests.load).not.toHaveBeenCalled();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await f.component.create(); expect(f.requests.create).not.toHaveBeenCalled();
  confirm.mockReturnValue(true); await f.component.create(); expect(f.requests.create).toHaveBeenCalledOnce();
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("keine Quellenfreigabe"));
  f.component.ngOnDestroy(); expect(f.requests.reset).toHaveBeenCalled();
});
for (const change of ["room", "peer", "identity", "program", "target", "kind", "disabled"]) {
  it(`does not send after ${change} changes during confirmation`, async () => {
    const f = fixture();
    vi.spyOn(window, "confirm").mockImplementation(() => {
      if (change === "room") f.inputs.roomId.set("room-other");
      if (change === "peer") f.inputs.peerId.set("aaaaaaaaaaaaaaaa");
      if (change === "identity") f.inputs.identityKey.set("other");
      if (change === "program") f.inputs.program.set({ ...f.inputs.program(), programEpoch: 3 });
      if (change === "target") f.component.target.set("");
      if (change === "kind") f.component.setKind("screen");
      if (change === "disabled") f.inputs.disabled.set(true);
      return true;
    });
    await f.component.create(); expect(f.requests.create).not.toHaveBeenCalled();
  });
}
for (const change of ["room", "peer", "identity", "program", "kind", "disabled"]) {
  it(`does not submit an own source after ${change} changes during confirmation`, async () => {
    const f = fixture();
    vi.spyOn(window, "confirm").mockImplementation(() => {
      if (change === "room") f.inputs.roomId.set("room-other");
      if (change === "peer") f.inputs.peerId.set("aaaaaaaaaaaaaaaa");
      if (change === "identity") f.inputs.identityKey.set("other");
      if (change === "program") f.inputs.program.set({ ...f.inputs.program(), programEpoch: 3 });
      if (change === "kind") f.component.setKind("screen");
      if (change === "disabled") f.inputs.disabled.set(true);
      return true;
    });
    await f.component.createOwn(); expect(f.requests.createOwn).not.toHaveBeenCalled();
  });
}
