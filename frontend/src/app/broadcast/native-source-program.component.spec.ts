import "@angular/compiler";
import { Injector, runInInjectionContext, signal } from "@angular/core";
import { afterEach, expect, it, vi } from "vitest";
import { NativeSourceProgramComponent } from "./native-source-program.component";
const packagerId = "pkr_aaaaaaaaaaaaaaaa";
function fixture() {
  const programs = { candidates: signal([{ id: packagerId, label: "Mini-PC", capability: { maximumRenditions: 3 } }]),
    view: signal({ active: false, phase: "idle", program: null, error: "" }), requestProgram: signal(null),
    controller: { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) } };
  const component = runInInjectionContext(Injector.create({ providers: [] }), () => new NativeSourceProgramComponent(programs as never));
  Object.assign(component, { disabled: signal(false), roomId: signal("room-alpha") });
  return { component, programs };
}
afterEach(() => vi.restoreAllMocks());

it("does nothing on open or selection, defaults private/software and confirms only the exact selected start", async () => {
  const f = fixture(), confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  expect(f.component.canStart()).toBe(false); f.component.packagerId.set(packagerId);
  expect(f.programs.controller.start).not.toHaveBeenCalled(); await f.component.start();
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("separate Zustimmung"));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("nicht SFrame-E2EE"));
  expect(f.programs.controller.start).not.toHaveBeenCalled();
  confirm.mockReturnValue(true); await f.component.start();
  expect(f.programs.controller.start).toHaveBeenCalledExactlyOnceWith({ roomId: "room-alpha", title: "Meine Mehrquellen-Sendung",
    visibility: "private", packagerId, requestedRenditions: 1, allowHardwareAcceleration: false }, "user-action");
});

for (const change of ["room", "title", "visibility", "renditions", "hardware", "revoked", "busy"]) {
  it(`rechecks ${change} after confirmation`, async () => {
    const f = fixture(); f.component.packagerId.set(packagerId);
    vi.spyOn(window, "confirm").mockImplementation(() => {
      if (change === "room") (f.component.roomId as any).set("room-other");
      if (change === "title") f.component.title.set("Other");
      if (change === "visibility") f.component.setVisibility("public");
      if (change === "renditions") f.component.setRenditions("3");
      if (change === "hardware") f.component.hardware.set(true);
      if (change === "revoked") f.programs.candidates.set([]);
      if (change === "busy") (f.component.disabled as any).set(true);
      return true;
    });
    await f.component.start(); expect(f.programs.controller.start).not.toHaveBeenCalled();
  });
}

it("keeps stop independent of panel disablement and never labels a mere start as confirmed output", async () => {
  const f = fixture(); (f.component.disabled as any).set(true);
  f.programs.view.set({ active: true, phase: "waiting-output", program: null, error: "" });
  expect(f.component.statusLabel()).toBe("Warte auf bestätigte Packager-Ausgabe");
  await f.component.stop(); expect(f.programs.controller.stop).toHaveBeenCalledOnce();
  f.programs.view.set({ active: true, phase: "failed", program: null, error: "stop_unconfirmed" });
  expect(f.component.statusLabel()).toContain("erneut stoppen");
  expect("ngOnDestroy" in f.component).toBe(false);
});
