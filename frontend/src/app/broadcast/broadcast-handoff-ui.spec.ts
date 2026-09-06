import "@angular/compiler";
import { Injector, runInInjectionContext, signal } from "@angular/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BroadcastPreflightComponent } from "./broadcast-preflight.component";

const oldId = "pkr_aaaaaaaaaaaaaaaa", nextId = "pkr_bbbbbbbbbbbbbbbb";
function fixture() {
  const packagers = signal([{ id: oldId, label: "Alt", capability: { maximumRenditions: 1 } },
    { id: nextId, label: "Mini-PC", capability: { maximumRenditions: 3 } }]);
  const publisher = {
    errorCode: signal(""), busy: signal(false), activeProgramId: signal("prg_aaaaaaaaaaaaaaaa"),
    activePackagerId: signal(oldId), handingOver: signal(false),
    coordinator: { programState: { value: signal({ lifecycle: "running", program: { programId: "prg_aaaaaaaaaaaaaaaa" } }) } },
    handoff: vi.fn(async () => { publisher.activePackagerId.set(nextId); }), stop: vi.fn(async () => {}),
  };
  const onboarding = { eligible: () => packagers(), selectedPackagerId: signal(oldId), select: vi.fn(() => true) };
  const preflight = { lifecycle: signal("idle"), selectedSourceIds: signal(["src_aaaaaaaaaaaaaaaa"]) };
  const component = runInInjectionContext(Injector.create({ providers: [] }), () => new BroadcastPreflightComponent(
    preflight as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    publisher as never, onboarding as never,
  ));
  Object.assign(component, { nativePublisherEnabled: signal(true), joined: signal(true), authenticated: signal(true),
    roomCreator: signal(true), roomId: signal("room-alpha") });
  component.handoffTargetId.set(nextId);
  return { component, publisher, onboarding, packagers };
}

describe("Native handoff local UI actions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does nothing on construction or target selection and requires the concrete confirmation", async () => {
    const f = fixture();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(f.publisher.handoff).not.toHaveBeenCalled();
    await f.component.handoffPackager();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Mini-PC"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("nicht SFrame-E2EE"));
    expect(f.publisher.handoff).not.toHaveBeenCalled();
    expect(f.onboarding.select).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await f.component.handoffPackager();
    expect(f.publisher.handoff).toHaveBeenCalledExactlyOnceWith(nextId, 3, "user-action");
    expect(f.component.handoffTargetId()).toBe("");
    expect(f.onboarding.select).toHaveBeenLastCalledWith(nextId);
  });

  for (const change of ["revoked", "selection", "busy"]) {
    it(`rechecks ${change} after the local dialog instead of using an obsolete target`, async () => {
      const f = fixture();
      vi.spyOn(window, "confirm").mockImplementation(() => {
        if (change === "revoked") f.packagers.set([]);
        if (change === "selection") f.component.handoffTargetId.set(oldId);
        if (change === "busy") f.publisher.busy.set(true);
        return true;
      });
      await f.component.handoffPackager();
      expect(f.publisher.handoff).not.toHaveBeenCalled();
      expect(f.onboarding.select).not.toHaveBeenCalled();
    });
  }

  it("keeps Stop reachable during internal cleanup and restores only the actual writer after rejection", async () => {
    const f = fixture();
    f.publisher.handingOver.set(true);
    f.publisher.coordinator.programState.value.set({ lifecycle: "stopping", program: { programId: "prg_aaaaaaaaaaaaaaaa" } });
    expect(f.component.programActive()).toBe(true);
    expect(f.component.canStop()).toBe(true);
    expect(f.component.programStatusLabel()).toBe("Packager wird übergeben");
    await f.component.stopBroadcast();
    expect(f.publisher.stop).toHaveBeenCalledWith("user-stop");
    f.publisher.handingOver.set(false);
    f.publisher.coordinator.programState.value.set({ lifecycle: "running", program: { programId: "prg_aaaaaaaaaaaaaaaa" } });
    f.publisher.handoff.mockRejectedValue(new Error("conflict"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await f.component.handoffPackager();
    expect(f.onboarding.select).toHaveBeenLastCalledWith(oldId);
  });
});
