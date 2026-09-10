import "@angular/compiler";
import { Injector, runInInjectionContext, signal } from "@angular/core";
import { afterEach, expect, it, vi } from "vitest";
import { NativeSourceProgramComponent } from "./native-source-program.component";
const packagerId = "pkr_aaaaaaaaaaaaaaaa";
function fixture() {
  const programs = { candidates: signal([{ id: packagerId, label: "Mini-PC", capability: { maximumRenditions: 3 } }]),
    view: signal({ active: false, phase: "idle", program: null, error: "" }), requestProgram: signal(null),
    controller: { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), canHandoff: vi.fn(() => true), handoff: vi.fn(async () => {}),
      controlledPackagerId: vi.fn((): string | null => null) } };
  const component = runInInjectionContext(Injector.create({ providers: [] }), () => new NativeSourceProgramComponent(programs as never));
  Object.assign(component, { disabled: signal(false), roomId: signal("room-alpha") });
  return { component, programs };
}
afterEach(() => vi.restoreAllMocks());

it("names only the currently confirmed writer, not a staged successor", () => {
  const f = fixture(); f.component.handoffId.set(packagerId); expect(f.component.confirmedPackager()).toBe("");
  f.programs.controller.controlledPackagerId.mockReturnValue(packagerId);
  f.programs.view.set({ active: true, phase: "live", program: null, error: "" });
  expect(f.component.confirmedPackager()).toBe("Mini-PC");
  f.programs.controller.controlledPackagerId.mockReturnValue(null);
  f.programs.view.set({ active: true, phase: "handing-over", program: null, error: "" });
  expect(f.component.confirmedPackager()).toBe("");
});

it("stages an explicit successor and confirms disruption and renewed participant consent", async () => {
  const f = fixture(); f.programs.view.set({ active: true, phase: "live", program: null, error: "" });
  f.component.handoffId.set(packagerId); const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  expect(f.programs.controller.handoff).not.toHaveBeenCalled(); await f.component.handoff();
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("erneut die ausdrückliche Zustimmung"));
  expect(f.programs.controller.handoff).not.toHaveBeenCalled();
  confirm.mockReturnValue(true); await f.component.handoff();
  expect(f.programs.controller.handoff).toHaveBeenCalledExactlyOnceWith(packagerId, "user-action");
});
for (const change of ["target", "candidates", "program", "disabled"]) it(`rechecks handoff ${change} after confirmation`, async () => {
  const f = fixture(); f.component.handoffId.set(packagerId);
  vi.spyOn(window, "confirm").mockImplementation(() => {
    if (change === "target") f.component.handoffId.set("pkr_bbbbbbbbbbbbbbbb");
    if (change === "candidates") f.programs.candidates.set([]);
    if (change === "program") f.programs.view.set({ ...f.programs.view(), program: {} as never });
    if (change === "disabled") (f.component.disabled as any).set(true);
    return true;
  });
  await f.component.handoff(); expect(f.programs.controller.handoff).not.toHaveBeenCalled();
});

function audioFixture() {
  const f = fixture();
  f.programs.candidates.set([{ ...f.programs.candidates()[0], capability: Object.assign({ maximumRenditions: 3 },
    { capabilityVersion: 5, sourcePrograms: true, sourceAudioControlVersion: 3, sourceAudioEncodingVersion: 1 }) }]);
  f.component.packagerId.set(packagerId); return f;
}
it.each([["speech", 1, 48000], ["balanced", 2, 96000], ["music", 2, 192000]] as const)("stages %s without starting media and sends the confirmed choice", async (preset, channels, targetBitsPerSecond) => {
  const f = audioFixture(); f.component.setAudioPreset(preset);
  expect(f.programs.controller.start).not.toHaveBeenCalled(); expect(f.component.canStart()).toBe(true);
  vi.spyOn(window, "confirm").mockReturnValue(true); await f.component.start();
  expect(f.programs.controller.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    audioOutput: { codec: "aac", sampleRate: 48000, channels, targetBitsPerSecond } }), "user-action");
});
it("bounds custom choices and never silently downgrades when agent support disappears", async () => {
  const f = audioFixture(); f.component.setAudioPreset("custom"); f.component.audioChannels.set(1); f.component.audioKbps.set(193);
  expect(f.component.canStart()).toBe(false); f.component.audioKbps.set(192); expect(f.component.canStart()).toBe(true);
  f.component.audioChannels.set(2); f.component.audioKbps.set(320); expect(f.component.canStart()).toBe(true);
  f.component.audioKbps.set(321); expect(f.component.canStart()).toBe(false);
  f.component.audioKbps.set(96); f.component.setAudioPreset("unsafe"); expect(f.component.audioPreset()).toBe("custom");
  f.programs.candidates.set([{ id: packagerId, label: "Older", capability: { maximumRenditions: 3 } }]);
  expect(f.component.audioPreset()).toBe("custom"); expect(f.component.canStart()).toBe(false);
  await f.component.start(); expect(f.programs.controller.start).not.toHaveBeenCalled();
  f.component.setAudioPreset("legacy"); expect(f.component.canStart()).toBe(true);
});
it.each(["preset", "rate", "channels", "capability"])("rechecks audio %s after confirmation", async change => {
  const f = audioFixture(); f.component.setAudioPreset("custom");
  vi.spyOn(window, "confirm").mockImplementation(() => {
    if (change === "preset") f.component.setAudioPreset("speech");
    if (change === "rate") f.component.audioKbps.set(48);
    if (change === "channels") f.component.audioChannels.set(1);
    if (change === "capability") f.programs.candidates.set([{ id: packagerId, label: "Older", capability: { maximumRenditions: 3 } }]);
    return true;
  });
  await f.component.start(); expect(f.programs.controller.start).not.toHaveBeenCalled();
});

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
